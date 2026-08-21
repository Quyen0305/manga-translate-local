use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::diagnostics::ACTIVE_RUNTIME_DIRECTORY;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub host: IpAddr,
    pub port: u16,
    pub max_image_bytes: usize,
    pub data_dir: PathBuf,
    pub app_dir: PathBuf,
    pub cpu: bool,
    pub lifecycle: LifecyclePolicy,
    pub allowed_extension_origins: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LifecyclePolicy {
    pub idle_timeout_seconds: u64,
    pub preload_on_start: bool,
}

impl Default for LifecyclePolicy {
    fn default() -> Self {
        Self {
            idle_timeout_seconds: 15 * 60,
            preload_on_start: false,
        }
    }
}

impl AppConfig {
    pub fn load(cpu_flag: bool, data_dir: Option<PathBuf>) -> Result<Self> {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?);
        let app_dir = local.join("MangaTranslate");
        std::fs::create_dir_all(&app_dir)
            .with_context(|| format!("create {}", app_dir.display()))?;
        let koharu_data = local.join("Koharu");
        let default_data = if koharu_data.join(ACTIVE_RUNTIME_DIRECTORY).is_dir()
            || koharu_data.join("runtime").is_dir()
        {
            koharu_data
        } else {
            app_dir.join("data")
        };

        let mut lifecycle = load_lifecycle(&app_dir);
        if std::env::var_os("ENGINE_IDLE_TIMEOUT_SECONDS").is_some() {
            lifecycle.idle_timeout_seconds = env_parse("ENGINE_IDLE_TIMEOUT_SECONDS", 15 * 60)?;
        }
        if std::env::var_os("ENGINE_PRELOAD").is_some() {
            lifecycle.preload_on_start = env_bool("ENGINE_PRELOAD", false)?;
        }

        Ok(Self {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: env_parse("SERVICE_PORT", 40721)?,
            max_image_bytes: env_parse("MAX_IMAGE_BYTES", 40 * 1024 * 1024)?,
            data_dir: data_dir
                .or_else(|| std::env::var_os("ENGINE_DATA_DIR").map(PathBuf::from))
                .unwrap_or(default_data),
            allowed_extension_origins: load_allowed_origins(&app_dir),
            app_dir,
            cpu: cpu_flag || env_bool("ENGINE_CPU", false)?,
            lifecycle,
        })
    }

    pub fn socket_addr(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }

    pub fn init_logging(&self) -> Result<WorkerGuard> {
        let log_dir = self.app_dir.join("logs");
        std::fs::create_dir_all(&log_dir)?;
        let appender = tracing_appender::rolling::never(log_dir, "manga-translate.log");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        let filter = tracing_subscriber::EnvFilter::builder()
            .with_default_directive(tracing::Level::INFO.into())
            .from_env_lossy();
        tracing_subscriber::registry()
            .with(filter)
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(writer),
            )
            .init();
        Ok(guard)
    }

    pub fn save_lifecycle(&self, policy: LifecyclePolicy) -> Result<()> {
        let path = self.app_dir.join("lifecycle.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&policy)?)
            .with_context(|| format!("write {}", path.display()))
    }
}

fn load_lifecycle(app_dir: &std::path::Path) -> LifecyclePolicy {
    std::fs::read(app_dir.join("lifecycle.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn load_allowed_origins(app_dir: &std::path::Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(app_dir.join("native-host.json")) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    value["allowed_origins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|origin| origin.as_str())
        .map(|origin| origin.trim_end_matches('/').to_string())
        .collect()
}

fn env_parse<T>(name: &str, fallback: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match std::env::var(name) {
        Ok(value) => value
            .parse()
            .map_err(|error| anyhow::anyhow!("{name} is invalid: {error}")),
        Err(_) => Ok(fallback),
    }
}

fn env_bool(name: &str, fallback: bool) -> Result<bool> {
    match std::env::var(name) {
        Ok(value) if ["1", "true", "yes"].contains(&value.to_ascii_lowercase().as_str()) => {
            Ok(true)
        }
        Ok(value) if ["0", "false", "no"].contains(&value.to_ascii_lowercase().as_str()) => {
            Ok(false)
        }
        Ok(_) => Err(anyhow::anyhow!("{name} must be true or false")),
        Err(_) => Ok(fallback),
    }
}
