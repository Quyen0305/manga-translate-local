use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tokio::sync::oneshot;

use crate::config::AppConfig;
use crate::engine::Engine;
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
                    let result = axum::serve(listener, crate::http::router(state))
                        .with_graceful_shutdown(async {
                            let _ = receiver.await;
                        })
                        .await;
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
        self.state.engine.unload();
    }

    pub fn restart_engine(&self) {
        self.state.engine.unload();
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn engine_ready(&self) -> bool {
        self.state.engine.is_ready()
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
        assert!(!controller.engine_ready());
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
