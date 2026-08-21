use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;

use tokio::sync::oneshot;

use crate::config::{AppConfig, LifecyclePolicy};
use crate::engine::{Engine, EngineDiagnostics};
use crate::models::ModelDiscovery;

pub struct AppState {
    pub config: AppConfig,
    pub engine: Arc<Engine>,
    pub models: ModelDiscovery,
    pub service: Arc<ServiceHealth>,
}

#[derive(Default)]
pub struct ServiceHealth {
    desired_running: AtomicBool,
    running: AtomicBool,
    restart_count: AtomicU64,
    consecutive_failures: AtomicU64,
    last_restart_epoch_seconds: AtomicU64,
    last_failure: RwLock<Option<String>>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiagnostics {
    pub status: &'static str,
    pub desired_running: bool,
    pub restart_count: u64,
    pub consecutive_failures: u64,
    pub last_restart_epoch_seconds: Option<u64>,
    pub last_failure: Option<String>,
}

impl ServiceHealth {
    pub fn prepare_standalone_start(&self) {
        self.prepare_manual_start();
    }

    pub fn mark_standalone_running(&self) {
        self.record_started();
    }

    pub fn diagnostics(&self) -> ServiceDiagnostics {
        let running = self.running.load(Ordering::Acquire);
        let desired = self.desired_running.load(Ordering::Acquire);
        let last_restart = self.last_restart_epoch_seconds.load(Ordering::Acquire);
        ServiceDiagnostics {
            status: if running {
                "running"
            } else if desired {
                "recovering"
            } else {
                "stopped"
            },
            desired_running: desired,
            restart_count: self.restart_count.load(Ordering::Acquire),
            consecutive_failures: self.consecutive_failures.load(Ordering::Acquire),
            last_restart_epoch_seconds: (last_restart > 0).then_some(last_restart),
            last_failure: self
                .last_failure
                .read()
                .ok()
                .and_then(|failure| failure.clone()),
        }
    }

    fn prepare_manual_start(&self) {
        self.desired_running.store(true, Ordering::Release);
        self.consecutive_failures.store(0, Ordering::Release);
    }

    fn record_started(&self) {
        self.running.store(true, Ordering::Release);
        self.consecutive_failures.store(0, Ordering::Release);
    }

    fn record_failure(&self, error: impl Into<String>) {
        self.running.store(false, Ordering::Release);
        self.consecutive_failures.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut failure) = self.last_failure.write() {
            *failure = Some(error.into().chars().take(800).collect());
        }
    }

    fn record_restart_attempt(&self) {
        self.restart_count.fetch_add(1, Ordering::AcqRel);
        self.last_restart_epoch_seconds
            .store(epoch_seconds(), Ordering::Release);
    }

    fn stop_requested(&self) {
        self.desired_running.store(false, Ordering::Release);
        self.running.store(false, Ordering::Release);
    }

    fn should_recover(&self) -> bool {
        self.desired_running.load(Ordering::Acquire)
            && !self.running.load(Ordering::Acquire)
            && self.consecutive_failures.load(Ordering::Acquire) < 3
            && epoch_seconds()
                .saturating_sub(self.last_restart_epoch_seconds.load(Ordering::Acquire))
                >= 2
    }
}

struct ServiceHandle {
    shutdown: oneshot::Sender<()>,
    thread: JoinHandle<()>,
}

pub struct ServiceController {
    state: Arc<AppState>,
    handle: Mutex<Option<ServiceHandle>>,
}

impl ServiceController {
    pub fn new(state: Arc<AppState>) -> Arc<Self> {
        Arc::new(Self {
            state,
            handle: Mutex::new(None),
        })
    }

    pub fn start(&self) {
        self.state.service.prepare_manual_start();
        self.start_internal(false);
    }

    fn start_internal(&self, recovery: bool) {
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
        if recovery {
            state.service.record_restart_attempt();
        }
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
                    state
                        .service
                        .record_failure("Không tạo được Tokio runtime cho local service");
                    tracing::error!("could not create HTTP runtime");
                    return;
                };
                runtime.block_on(async move {
                    let listener = match tokio::net::TcpListener::bind(state.config.socket_addr()).await {
                        Ok(listener) => listener,
                        Err(error) => {
                            state.service.record_failure(format!(
                                "Không bind được {}: {error}",
                                state.config.socket_addr()
                            ));
                            tracing::error!(%error, address = %state.config.socket_addr(), "could not bind service");
                            return;
                        }
                    };
                    state.service.record_started();
                    tracing::info!(address = %state.config.socket_addr(), "service started");
                    let lifecycle = spawn_lifecycle_monitor(state.engine.clone());
                    let result = axum::serve(listener, crate::http::router(state.clone()))
                        .with_graceful_shutdown(async {
                            let _ = receiver.await;
                        })
                        .await;
                    lifecycle.abort();
                    if let Err(error) = result {
                        state
                            .service
                            .record_failure(format!("Local HTTP service stopped: {error}"));
                        tracing::error!(%error, "HTTP service stopped with an error");
                    } else {
                        state.service.running.store(false, Ordering::Release);
                    }
                });
            });
        match thread {
            Ok(thread) => *handle = Some(ServiceHandle { shutdown, thread }),
            Err(error) => {
                self.state
                    .service
                    .record_failure(format!("Không tạo được service thread: {error}"));
                tracing::error!(%error, "could not start service thread");
            }
        }
    }

    pub fn stop(&self) {
        self.state.service.stop_requested();
        let current = self.handle.lock().ok().and_then(|mut handle| handle.take());
        if let Some(handle) = current {
            let _ = handle.shutdown.send(());
            let _ = handle.thread.join();
        }
        self.state.engine.unload("service-stop");
    }

    pub fn restart_engine(&self) {
        spawn_engine_operation(self.state.engine.clone(), "restart", |engine| async move {
            engine.restart().await
        });
    }

    pub fn retry_gpu(&self) {
        spawn_engine_operation(
            self.state.engine.clone(),
            "retry-gpu",
            |engine| async move { engine.retry_gpu().await.map(|_| ()) },
        );
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
        self.state.service.running.load(Ordering::Acquire)
    }

    pub fn recover_if_needed(&self) -> bool {
        if !self.state.service.should_recover() {
            return false;
        }
        let finished = self
            .handle
            .lock()
            .ok()
            .is_none_or(|handle| handle.as_ref().is_none_or(|item| item.thread.is_finished()));
        if !finished {
            return false;
        }
        tracing::warn!("local service stopped unexpectedly; watchdog is restarting it");
        self.start_internal(true);
        true
    }

    pub fn service_diagnostics(&self) -> ServiceDiagnostics {
        self.state.service.diagnostics()
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

fn epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
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
            service: Arc::new(ServiceHealth::default()),
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

    #[test]
    fn watchdog_retries_unexpected_failures_but_respects_manual_stop() {
        let health = ServiceHealth::default();
        health.prepare_manual_start();
        health.record_failure("simulated service crash");
        assert!(health.should_recover());

        health.stop_requested();
        assert!(!health.should_recover());

        health.prepare_manual_start();
        for _ in 0..3 {
            health.record_failure("repeated bind failure");
        }
        assert!(!health.should_recover());
    }

    fn wait_until(condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !condition() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(condition());
    }
}
