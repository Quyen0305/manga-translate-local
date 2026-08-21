use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tokio::sync::oneshot;

use crate::config::{AppConfig, LifecyclePolicy};
use crate::engine::{Engine, EngineDiagnostics};
use crate::models::ModelDiscovery;

pub struct AppState {
    pub config: AppConfig,
    pub engine: Arc<Engine>,
    pub models: ModelDiscovery,
}

struct ServiceHandle {
    shutdown: oneshot::Sender<()>,
    thread: JoinHandle<()>,
}

pub struct ServiceController {
    state: Arc<AppState>,
    handle: Mutex<Option<ServiceHandle>>,
    running: Arc<AtomicBool>,
}

impl ServiceController {
    pub fn new(state: Arc<AppState>) -> Arc<Self> {
        Arc::new(Self {
            state,
            handle: Mutex::new(None),
            running: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn start(&self) {
        let mut handle = match self.handle.lock() {
            Ok(handle) => handle,
            Err(_) => return,
        };
        if handle
            .as_ref()
            .is_some_and(|current| current.thread.is_finished())
        {
            if let Some(finished) = handle.take() {
                let _ = finished.thread.join();
            }
        } else if handle.is_some() {
            return;
        }
        let state = self.state.clone();
        let running = self.running.clone();
        let (shutdown, receiver) = oneshot::channel();
        let thread = std::thread::Builder::new()
            .name("manga-http".into())
            .stack_size(64 * 1024 * 1024)
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_stack_size(64 * 1024 * 1024)
                    .enable_all()
                    .build();
                let Ok(runtime) = runtime else {
                    tracing::error!("could not create HTTP runtime");
                    return;
                };
                runtime.block_on(async move {
                    let listener = match tokio::net::TcpListener::bind(state.config.socket_addr()).await {
                        Ok(listener) => listener,
                        Err(error) => {
                            tracing::error!(%error, address = %state.config.socket_addr(), "could not bind service");
                            return;
                        }
                    };
                    running.store(true, Ordering::Release);
                    tracing::info!(address = %state.config.socket_addr(), "service started");
                    let lifecycle = spawn_lifecycle_monitor(state.engine.clone());
                    let result = axum::serve(listener, crate::http::router(state))
                        .with_graceful_shutdown(async {
                            let _ = receiver.await;
                        })
                        .await;
                    lifecycle.abort();
                    running.store(false, Ordering::Release);
                    if let Err(error) = result {
                        tracing::error!(%error, "HTTP service stopped with an error");
                    }
                });
            });
        match thread {
            Ok(thread) => *handle = Some(ServiceHandle { shutdown, thread }),
            Err(error) => tracing::error!(%error, "could not start service thread"),
        }
    }

    pub fn stop(&self) {
        let current = self.handle.lock().ok().and_then(|mut handle| handle.take());
        if let Some(handle) = current {
            let _ = handle.shutdown.send(());
            let _ = handle.thread.join();
        }
        self.running.store(false, Ordering::Release);
        self.state.engine.unload("service-stop");
    }

    pub fn restart_engine(&self) {
        spawn_engine_operation(self.state.engine.clone(), "restart", |engine| async move {
            engine.restart().await
        });
    }

    pub fn unload_engine(&self) -> anyhow::Result<bool> {
        self.state.engine.request_unload("manual")
    }

    pub fn engine_diagnostics(&self) -> EngineDiagnostics {
        self.state.engine.diagnostics()
    }

    pub fn lifecycle_policy(&self) -> LifecyclePolicy {
        self.state.engine.lifecycle_policy()
    }

    pub fn update_lifecycle_policy(&self, policy: LifecyclePolicy) -> anyhow::Result<()> {
        self.state.engine.update_lifecycle_policy(policy)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
}

pub fn spawn_lifecycle_monitor(engine: Arc<Engine>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if engine.preload_on_start()
            && let Err(error) = engine.preload().await
        {
            tracing::error!(%error, "could not preload engine");
        }
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let engine = engine.clone();
            match tokio::task::spawn_blocking(move || engine.unload_if_idle()).await {
                Ok(true) => tracing::info!("engine entered sleep after idle timeout"),
                Ok(false) => {}
                Err(error) => tracing::error!(%error, "idle watchdog failed"),
            }
        }
    })
}

fn spawn_engine_operation<F, Fut>(engine: Arc<Engine>, operation: &'static str, task: F)
where
    F: FnOnce(Arc<Engine>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = anyhow::Result<()>> + Send + 'static,
{
    let result = std::thread::Builder::new()
        .name(format!("engine-{operation}"))
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            match runtime {
                Ok(runtime) => {
                    if let Err(error) = runtime.block_on(task(engine)) {
                        tracing::error!(%error, operation, "engine lifecycle operation failed");
                    }
                }
                Err(error) => {
                    tracing::error!(%error, operation, "could not create lifecycle runtime")
                }
            }
        });
    if let Err(error) = result {
        tracing::error!(%error, operation, "could not start lifecycle operation");
    }
}

impl Drop for ServiceController {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn service_can_stop_and_start_without_loading_engine() {
        let temp = tempfile::tempdir().expect("temp app directory");
        let config = AppConfig {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            max_image_bytes: 1024,
            data_dir: temp.path().join("data"),
            app_dir: temp.path().to_path_buf(),
            cpu: true,
            lifecycle: LifecyclePolicy::default(),
            allowed_extension_origins: Vec::new(),
        };
        let state = Arc::new(AppState {
            engine: Arc::new(Engine::new(config.clone())),
            models: ModelDiscovery::new().expect("model discovery"),
            config,
        });
        let controller = ServiceController::new(state);

        controller.start();
        wait_until(|| controller.is_running());
        assert!(!controller.state.engine.is_ready());
        controller.stop();
        assert!(!controller.is_running());

        controller.start();
        wait_until(|| controller.is_running());
        controller.stop();
        assert!(!controller.is_running());
    }

    fn wait_until(condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !condition() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(condition());
    }
}
