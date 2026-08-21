#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod config;
mod diagnostics;
mod engine;
mod error;
mod http;
mod models;
mod native;
mod service;
#[cfg(windows)]
mod tray;

use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use config::AppConfig;
use engine::Engine;
use models::ModelDiscovery;
use service::{AppState, ServiceController, ServiceHealth};

#[derive(Parser, Debug)]
#[command(version, about = "Manga Translate desktop service powered by Koharu")]
struct Cli {
    #[arg(long, conflicts_with_all = ["service", "native_messaging", "install", "uninstall"])]
    tray: bool,
    #[arg(long, conflicts_with_all = ["tray", "native_messaging", "install", "uninstall"])]
    service: bool,
    #[arg(long, conflicts_with_all = ["tray", "service", "install", "uninstall"])]
    native_messaging: bool,
    #[arg(long, conflicts_with_all = ["tray", "service", "native_messaging", "uninstall"])]
    install: bool,
    #[arg(long, conflicts_with_all = ["tray", "service", "native_messaging", "install"])]
    uninstall: bool,
    #[arg(long)]
    cpu: bool,
    #[arg(long, value_name = "DIR")]
    data_dir: Option<std::path::PathBuf>,
}

fn main() -> Result<()> {
    if native::invoked_by_chrome() {
        return native::run_host();
    }
    let cli = Cli::parse();

    if cli.install {
        return native::install();
    }
    if cli.uninstall {
        return native::uninstall();
    }
    if cli.native_messaging {
        return native::run_host();
    }

    let config = AppConfig::load(cli.cpu, cli.data_dir)?;
    let _log_guard = config.init_logging()?;
    let state = Arc::new(AppState {
        engine: Arc::new(Engine::new(config.clone())),
        models: ModelDiscovery::new()?,
        service: Arc::new(ServiceHealth::default()),
        config: config.clone(),
    });

    if cli.service {
        return run_service(state);
    }

    #[cfg(windows)]
    {
        return tray::run(ServiceController::new(state), config);
    }

    #[cfg(not(windows))]
    anyhow::bail!("The tray application currently supports Windows only")
}

fn run_service(state: Arc<AppState>) -> Result<()> {
    state.service.prepare_standalone_start();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_stack_size(64 * 1024 * 1024)
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(state.config.socket_addr()).await?;
        state.service.mark_standalone_running();
        tracing::info!(url = %format!("http://{}", state.config.socket_addr()), "service started");
        let lifecycle = service::spawn_lifecycle_monitor(state.engine.clone());
        axum::serve(listener, http::router(state))
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await?;
        lifecycle.abort();
        Ok(())
    })
}
