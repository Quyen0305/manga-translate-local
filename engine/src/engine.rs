use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use image::{DynamicImage, ImageFormat};
use koharu_pipeline::{
    Committer, Operation, Pipeline, PipelineConfig, Request, RunStatus, Scope, StageOutput,
    TranslationConfig,
};
use koharu_rasterizer::{RasterOptions, Rasterizer};
use koharu_renderer::Renderer;
use koharu_scene::{AssetInput, AssetMetadata, AssetRole, At, PageDraft, Session, Snapshot};
use koharu_translator::{GenerationConfig, Language, ModelSelection, Provider, ProvidersConfig};
use serde::{Deserialize, Serialize};
use sysinfo::{ProcessesToUpdate, System, get_current_pid};
use tokio::sync::Mutex;

use crate::config::{AppConfig, LifecyclePolicy};
use crate::diagnostics::{ACTIVE_RUNTIME_DIRECTORY, CudaDiagnostics};
use crate::error::AppError;

pub const KOHARU_VERSION: &str = "0.70.2";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSettings {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub target_language: String,
    pub system_prompt: String,
}

pub struct Engine {
    config: AppConfig,
    app: RwLock<Option<Arc<EngineApp>>>,
    busy: AtomicBool,
    loading: AtomicBool,
    force_cpu: AtomicBool,
    fallback_reason: RwLock<Option<String>>,
    last_unload_reason: RwLock<Option<String>>,
    last_activity_epoch_seconds: AtomicU64,
    loaded_at_epoch_seconds: AtomicU64,
    idle_timeout_seconds: AtomicU64,
    preload_on_start: AtomicBool,
    init_lock: Mutex<()>,
    job_lock: Mutex<()>,
}

struct EngineApp {
    cpu_only: bool,
    device: koharu_ml::Device,
    pipeline: RwLock<Option<CachedPipeline>>,
    renderer: Renderer,
    rasterizer: Rasterizer,
}

struct CachedPipeline {
    profile: String,
    pipeline: Pipeline,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineDiagnostics {
    pub state: &'static str,
    pub loaded: bool,
    pub busy: bool,
    pub loading: bool,
    pub requested_mode: &'static str,
    pub active_mode: &'static str,
    pub fallback_reason: Option<String>,
    pub last_unload_reason: Option<String>,
    pub last_activity_epoch_seconds: u64,
    pub loaded_at_epoch_seconds: Option<u64>,
    pub idle_timeout_seconds: u64,
    pub idle_seconds_remaining: Option<u64>,
    pub preload_on_start: bool,
    pub resources: EngineResources,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineResources {
    pub process_memory_bytes: u64,
    pub system_memory_bytes: u64,
    pub process_cpu_percent: f32,
    pub gpu_name: Option<String>,
    pub gpu_memory_used_bytes: Option<u64>,
    pub gpu_memory_budget_bytes: Option<u64>,
    pub gpu_utilization_percent: Option<f32>,
}

impl Engine {
    pub fn new(config: AppConfig) -> Self {
        let now = epoch_seconds();
        Self {
            force_cpu: AtomicBool::new(config.cpu),
            idle_timeout_seconds: AtomicU64::new(config.lifecycle.idle_timeout_seconds),
            preload_on_start: AtomicBool::new(config.lifecycle.preload_on_start),
            config,
            app: RwLock::new(None),
            busy: AtomicBool::new(false),
            loading: AtomicBool::new(false),
            fallback_reason: RwLock::new(None),
            last_unload_reason: RwLock::new(None),
            last_activity_epoch_seconds: AtomicU64::new(now),
            loaded_at_epoch_seconds: AtomicU64::new(0),
            init_lock: Mutex::new(()),
            job_lock: Mutex::new(()),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.app.read().map(|app| app.is_some()).unwrap_or(false)
    }

    pub fn unload(&self, reason: &str) -> bool {
        let unloaded = self
            .app
            .write()
            .ok()
            .and_then(|mut app| app.take())
            .is_some();
        if unloaded {
            self.loaded_at_epoch_seconds.store(0, Ordering::Release);
            if let Ok(mut current) = self.last_unload_reason.write() {
                *current = Some(reason.to_owned());
            }
            tracing::info!(reason, "engine unloaded");
            trim_process_working_set();
        }
        unloaded
    }

    pub fn request_unload(&self, reason: &str) -> Result<bool> {
        if self.is_busy() || self.loading.load(Ordering::Acquire) {
            bail!("engine is busy");
        }
        Ok(self.unload(reason))
    }

    pub fn unload_if_idle(&self) -> bool {
        let timeout = self.idle_timeout_seconds.load(Ordering::Acquire);
        if !idle_expired(
            self.is_ready(),
            self.is_busy(),
            self.loading.load(Ordering::Acquire),
            timeout,
            self.last_activity_epoch_seconds.load(Ordering::Acquire),
            epoch_seconds(),
        ) {
            return false;
        }
        self.unload("idle-timeout")
    }

    pub async fn preload(&self) -> Result<bool> {
        let _job = self
            .job_lock
            .try_lock()
            .map_err(|_| anyhow!("engine is busy"))?;
        if self.is_ready() {
            return Ok(false);
        }
        self.touch();
        self.ensure_app().await?;
        Ok(true)
    }

    pub async fn restart(&self) -> Result<()> {
        let _job = self
            .job_lock
            .try_lock()
            .map_err(|_| anyhow!("engine is busy"))?;
        if self.is_busy() {
            bail!("engine is busy");
        }
        self.unload("restart");
        self.touch();
        self.ensure_app().await?;
        Ok(())
    }

    pub fn lifecycle_policy(&self) -> LifecyclePolicy {
        LifecyclePolicy {
            idle_timeout_seconds: self.idle_timeout_seconds.load(Ordering::Acquire),
            preload_on_start: self.preload_on_start.load(Ordering::Acquire),
        }
    }

    pub fn update_lifecycle_policy(&self, policy: LifecyclePolicy) -> Result<()> {
        if policy.idle_timeout_seconds != 0
            && !(60..=24 * 60 * 60).contains(&policy.idle_timeout_seconds)
        {
            bail!("idle timeout must be 0 or between 60 and 86400 seconds");
        }
        self.config.save_lifecycle(policy)?;
        self.idle_timeout_seconds
            .store(policy.idle_timeout_seconds, Ordering::Release);
        self.preload_on_start
            .store(policy.preload_on_start, Ordering::Release);
        Ok(())
    }

    pub fn preload_on_start(&self) -> bool {
        self.preload_on_start.load(Ordering::Acquire)
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    pub fn state(&self) -> &'static str {
        if self.is_busy() {
            "busy"
        } else if self.loading.load(Ordering::Acquire) {
            "loading"
        } else if self.is_ready() {
            "ready"
        } else {
            "sleeping"
        }
    }

    pub fn diagnostics(&self) -> EngineDiagnostics {
        let force_cpu = self.force_cpu.load(Ordering::Acquire);
        let loaded = self.is_ready();
        let busy = self.is_busy();
        let loading = self.loading.load(Ordering::Acquire);
        let timeout = self.idle_timeout_seconds.load(Ordering::Acquire);
        let last_activity = self.last_activity_epoch_seconds.load(Ordering::Acquire);
        let loaded_at = self.loaded_at_epoch_seconds.load(Ordering::Acquire);
        let app = self.app.read().ok().and_then(|app| app.clone());
        let mut resources = app.as_deref().map(EngineApp::resources).unwrap_or_default();
        if resources.process_memory_bytes == 0 {
            resources = host_resources();
        }
        EngineDiagnostics {
            state: self.state(),
            loaded,
            busy,
            loading,
            requested_mode: if self.config.cpu { "cpu" } else { "gpu" },
            active_mode: if self.config.cpu {
                "cpu"
            } else if force_cpu {
                "cpu-fallback"
            } else {
                "gpu"
            },
            fallback_reason: self
                .fallback_reason
                .read()
                .ok()
                .and_then(|reason| reason.clone()),
            last_unload_reason: self
                .last_unload_reason
                .read()
                .ok()
                .and_then(|reason| reason.clone()),
            last_activity_epoch_seconds: last_activity,
            loaded_at_epoch_seconds: (loaded_at > 0).then_some(loaded_at),
            idle_timeout_seconds: timeout,
            idle_seconds_remaining: (loaded && timeout > 0)
                .then(|| timeout.saturating_sub(epoch_seconds().saturating_sub(last_activity))),
            preload_on_start: self.preload_on_start(),
            resources,
        }
    }

    pub async fn translate(
        &self,
        image: Vec<u8>,
        filename: String,
        settings: TranslationSettings,
    ) -> Result<Vec<u8>, AppError> {
        let _job = self.job_lock.lock().await;
        self.busy.store(true, Ordering::Release);
        self.touch();
        let result = self.translate_locked(image, filename, settings).await;
        self.touch();
        self.busy.store(false, Ordering::Release);
        result
    }

    async fn translate_locked(
        &self,
        image: Vec<u8>,
        filename: String,
        settings: TranslationSettings,
    ) -> Result<Vec<u8>, AppError> {
        let app = self.ensure_app().await.map_err(|error| {
            AppError::engine(format!("Could not initialize the Koharu engine: {error:#}"))
        })?;
        match translate_with_app(&app, &image, &filename, &settings).await {
            Ok(bytes) => Ok(bytes),
            Err(error) if !app.cpu_only && is_cuda_compatibility_error(&format!("{error:#}")) => {
                let reason = format!("CUDA không tương thích: {error:#}");
                tracing::warn!(%reason, "retrying translation with CPU fallback");
                drop(app);
                self.activate_cpu_fallback(reason);
                let cpu_app = self.ensure_app().await.map_err(|error| {
                    AppError::engine(format!("Could not initialize CPU fallback: {error:#}"))
                })?;
                translate_with_app(&cpu_app, &image, &filename, &settings)
                    .await
                    .map_err(|error| AppError::engine(format!("CPU fallback failed: {error:#}")))
            }
            Err(error) => Err(AppError::engine(format!("{error:#}"))),
        }
    }

    async fn ensure_app(&self) -> Result<Arc<EngineApp>> {
        if let Some(app) = self.app.read().ok().and_then(|app| app.clone()) {
            return Ok(app);
        }
        let _init = self.init_lock.lock().await;
        if let Some(app) = self.app.read().ok().and_then(|app| app.clone()) {
            return Ok(app);
        }
        if !self.config.cpu && !self.force_cpu.load(Ordering::Acquire) {
            let cuda = CudaDiagnostics::collect(false);
            if cuda.requires_cpu_fallback() {
                self.activate_cpu_fallback(cuda.message);
            }
        }
        let cpu = self.config.cpu || self.force_cpu.load(Ordering::Acquire);
        self.loading.store(true, Ordering::Release);
        let initialized = initialize_app(&self.config, cpu).await;
        self.loading.store(false, Ordering::Release);
        let app = initialized?;
        *self
            .app
            .write()
            .map_err(|_| anyhow!("engine state lock poisoned"))? = Some(app.clone());
        let now = epoch_seconds();
        self.loaded_at_epoch_seconds.store(now, Ordering::Release);
        self.last_activity_epoch_seconds
            .store(now, Ordering::Release);
        Ok(app)
    }

    fn activate_cpu_fallback(&self, reason: String) {
        self.force_cpu.store(true, Ordering::Release);
        if let Ok(mut fallback_reason) = self.fallback_reason.write() {
            *fallback_reason = Some(reason);
        }
        self.unload("cuda-fallback");
    }

    fn touch(&self) {
        self.last_activity_epoch_seconds
            .store(epoch_seconds(), Ordering::Release);
    }
}

impl EngineApp {
    fn pipeline(&self, settings: &TranslationSettings) -> Result<Pipeline> {
        let profile = pipeline_profile(settings);
        if let Some(pipeline) = self.pipeline.read().ok().and_then(|cached| {
            cached
                .as_ref()
                .filter(|item| item.profile == profile)
                .map(|item| item.pipeline.clone())
        }) {
            return Ok(pipeline);
        }

        let (pipeline_config, providers_config) = pipeline_configs(settings)?;
        let pipeline =
            Pipeline::from_values(pipeline_config, providers_config, self.device.clone())
                .context("create Koharu 0.70.2 pipeline")?;
        *self
            .pipeline
            .write()
            .map_err(|_| anyhow!("pipeline state lock poisoned"))? = Some(CachedPipeline {
            profile,
            pipeline: pipeline.clone(),
        });
        Ok(pipeline)
    }

    fn resources(&self) -> EngineResources {
        let snapshot = self
            .pipeline
            .read()
            .ok()
            .and_then(|cached| cached.as_ref().map(|cached| cached.pipeline.clone()))
            .map(|pipeline| {
                let receiver = pipeline.subscribe_resources();
                receiver.borrow().clone()
            });
        let Some(snapshot) = snapshot else {
            return host_resources();
        };
        let device = snapshot
            .devices
            .iter()
            .find(|device| device.selected)
            .or_else(|| snapshot.devices.first());
        EngineResources {
            process_memory_bytes: snapshot.process_memory_bytes,
            system_memory_bytes: snapshot.system_memory_bytes,
            process_cpu_percent: snapshot.process_cpu_percent,
            gpu_name: device.map(|device| device.name.clone()),
            gpu_memory_used_bytes: device.and_then(|device| device.memory_used_bytes),
            gpu_memory_budget_bytes: device.and_then(|device| device.memory_budget_bytes),
            gpu_utilization_percent: device.and_then(|device| device.utilization_percent),
        }
    }
}

fn host_resources() -> EngineResources {
    let mut system = System::new();
    system.refresh_memory();
    let pid = get_current_pid().ok();
    if let Some(pid) = pid {
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    }
    let process = pid.and_then(|pid| system.process(pid));
    EngineResources {
        process_memory_bytes: process.map_or(0, sysinfo::Process::memory),
        system_memory_bytes: system.total_memory(),
        process_cpu_percent: process.map_or(0.0, sysinfo::Process::cpu_usage),
        ..EngineResources::default()
    }
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn idle_expired(
    loaded: bool,
    busy: bool,
    loading: bool,
    timeout: u64,
    last_activity: u64,
    now: u64,
) -> bool {
    loaded && !busy && !loading && timeout > 0 && now.saturating_sub(last_activity) >= timeout
}

#[cfg(windows)]
fn trim_process_working_set() {
    use windows_sys::Win32::System::ProcessStatus::EmptyWorkingSet;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let trimmed = unsafe { EmptyWorkingSet(GetCurrentProcess()) } != 0;
    if !trimmed {
        tracing::debug!("Windows did not trim the engine working set");
    }
}

#[cfg(not(windows))]
fn trim_process_working_set() {}

async fn initialize_app(config: &AppConfig, cpu: bool) -> Result<Arc<EngineApp>> {
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("create engine data dir {}", config.data_dir.display()))?;
    let runtime_dir = config.data_dir.join(ACTIVE_RUNTIME_DIRECTORY);
    koharu_runtime::Store::configure(&runtime_dir)
        .with_context(|| format!("configure Koharu runtime store {}", runtime_dir.display()))?;
    koharu_ml::init()
        .await
        .context("initialize Koharu runtimes")?;
    let device = koharu_ml::device(cpu);
    let app = Arc::new(EngineApp {
        cpu_only: cpu,
        device,
        pipeline: RwLock::new(None),
        renderer: Renderer::new().context("initialize Koharu renderer")?,
        rasterizer: Rasterizer::new().context("initialize Koharu rasterizer")?,
    });
    tracing::info!(
        koharu_version = KOHARU_VERSION,
        runtime_store = %runtime_dir.display(),
        cpu,
        "engine ready"
    );
    Ok(app)
}

fn is_cuda_compatibility_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "cuda_error_unsupported_ptx_version",
        "unsupported ptx",
        "unsupported toolchain",
        "cuda driver version is insufficient",
        "no kernel image is available",
        "cudnn_status_arch_mismatch",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

async fn translate_with_app(
    app: &Arc<EngineApp>,
    image: &[u8],
    filename: &str,
    settings: &TranslationSettings,
) -> Result<Vec<u8>> {
    let provider = provider(settings)?;
    let _secret = SecretLease::install(secret_key(provider), &settings.api_key)?;
    let decoded = image::load_from_memory(image).context("decode source image")?;
    let mut session = Session::memory()
        .await
        .context("create in-memory project")?;
    let mut page = None;
    let patch = session.snapshot().patch(|edit| {
        let id = edit.add_page(
            PageDraft::new(
                filename,
                f64::from(decoded.width()),
                f64::from(decoded.height()),
            ),
            At::End,
        )?;
        edit.set_asset(
            id,
            &AssetRole::new("source")?,
            AssetInput::new(
                Arc::<[u8]>::from(image.to_vec()),
                image_media_type(filename),
                AssetMetadata {
                    width: Some(decoded.width()),
                    height: Some(decoded.height()),
                    attributes: BTreeMap::new(),
                },
            ),
        )?;
        page = Some(id);
        Ok(())
    })?;
    session.commit(patch).await?;
    let page = page.context("page ID was not assigned")?;

    let pipeline = app.pipeline(settings)?;
    let snapshot = session.snapshot();
    let mut committer = SessionCommitter(&mut session);
    let report = pipeline
        .execute(
            snapshot,
            Request {
                operation: Operation::Full,
                scope: Scope::Pages(vec![page]),
                ..Request::default()
            },
            &mut committer,
        )
        .await
        .context("run Koharu 0.70.2 pipeline")?;
    if report.status != RunStatus::Completed {
        bail!("Koharu pipeline stopped before completion");
    }

    let snapshot = session.snapshot();
    let frame = app
        .renderer
        .render(&snapshot, page)
        .await
        .context("render translated scene")?;
    let raster = app
        .rasterizer
        .rasterize(&frame.raster_frame()?, RasterOptions::default())
        .context("rasterize translated scene")?;
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(raster.image)
        .write_to(&mut output, ImageFormat::Png)
        .context("encode translated PNG")?;
    Ok(output.into_inner())
}

struct SessionCommitter<'a>(&'a mut Session);

#[async_trait]
impl Committer for SessionCommitter<'_> {
    async fn commit(&mut self, output: StageOutput) -> Result<Snapshot> {
        Ok(self.0.commit(output.patch).await?.snapshot)
    }
}

fn pipeline_configs(settings: &TranslationSettings) -> Result<(PipelineConfig, ProvidersConfig)> {
    let provider = provider(settings)?;
    let target_language = settings
        .target_language
        .parse::<Language>()
        .map_err(|error| anyhow!("invalid target language: {error}"))?;
    let model = if provider == Provider::DeepL {
        None
    } else {
        Some(settings.model.trim().to_string())
    };
    let mut pipeline = PipelineConfig::default();
    pipeline.translation = TranslationConfig {
        model: ModelSelection {
            provider,
            model,
            quantization: None,
            vision: false,
        },
        generation: GenerationConfig {
            temperature: Some(0.2),
            max_tokens: Some(4096),
            ..GenerationConfig::default()
        },
        target_language,
        instructions: non_empty(&settings.system_prompt),
    };

    let mut providers = ProvidersConfig::default();
    if !settings.base_url.trim().is_empty() {
        let base_url = settings
            .base_url
            .trim()
            .parse()
            .context("invalid provider Base URL")?;
        match provider {
            Provider::OpenAiCompatible => providers.openai_compatible.base_url = Some(base_url),
            Provider::DeepL => providers.deepl.base_url = Some(base_url),
            _ => {}
        }
    }
    Ok((pipeline, providers))
}

fn provider(settings: &TranslationSettings) -> Result<Provider> {
    match settings.provider.as_str() {
        "openai" => Ok(Provider::OpenAi),
        "gemini" => Ok(Provider::Gemini),
        "claude" => Ok(Provider::Claude),
        "deepseek" => Ok(Provider::DeepSeek),
        "deepl" => Ok(Provider::DeepL),
        "google-translate" => Ok(Provider::GoogleCloudTranslation),
        "caiyun" => Ok(Provider::Caiyun),
        "openai-compatible" => Ok(Provider::OpenAiCompatible),
        value => bail!("unsupported Koharu provider {value}"),
    }
}

fn secret_key(provider: Provider) -> &'static str {
    match provider {
        Provider::OpenAi => "openai",
        Provider::Gemini => "gemini",
        Provider::Claude => "claude",
        Provider::DeepSeek => "deepseek",
        Provider::DeepL => "deepl",
        Provider::GoogleCloudTranslation => "google-cloud-translation",
        Provider::Caiyun => "caiyun",
        Provider::OpenAiCompatible => "openai-compatible",
        Provider::AtlasCloud => "atlas-cloud",
        Provider::OpenRouter => "openrouter",
        Provider::LmStudio => "lm-studio",
        Provider::Local => "local",
    }
}

struct SecretLease {
    key: &'static str,
    previous: Option<koharu_secrets::SecretString>,
}

impl SecretLease {
    fn install(key: &'static str, value: &str) -> Result<Self> {
        let previous = koharu_secrets::get(key)
            .with_context(|| format!("read temporary credential slot {key}"))?;
        if value.trim().is_empty() {
            koharu_secrets::delete(key)
                .with_context(|| format!("clear temporary credential slot {key}"))?;
        } else {
            koharu_secrets::set(key, &koharu_secrets::SecretString::from(value.trim()))
                .with_context(|| format!("set temporary credential slot {key}"))?;
        }
        Ok(Self { key, previous })
    }
}

impl Drop for SecretLease {
    fn drop(&mut self) {
        let restored = match &self.previous {
            Some(secret) => koharu_secrets::set(self.key, secret),
            None => koharu_secrets::delete(self.key),
        };
        if let Err(error) = restored {
            tracing::error!(provider = self.key, %error, "failed to restore provider credential");
        }
    }
}

fn pipeline_profile(settings: &TranslationSettings) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        settings.provider,
        settings.model,
        settings.base_url,
        settings.target_language,
        settings.system_prompt
    )
}

fn image_media_type(filename: &str) -> &'static str {
    let extension = std::path::Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::{TranslationSettings, idle_expired, is_cuda_compatibility_error, pipeline_configs};

    #[test]
    fn only_cuda_compatibility_failures_trigger_fallback() {
        assert!(is_cuda_compatibility_error(
            "DriverError(CUDA_ERROR_UNSUPPORTED_PTX_VERSION: unsupported toolchain)"
        ));
        assert!(!is_cuda_compatibility_error(
            "Provider returned HTTP 401 for an invalid API key"
        ));
    }

    #[test]
    fn maps_extension_settings_to_new_pipeline() {
        let settings = TranslationSettings {
            provider: "gemini".into(),
            model: "gemini-2.5-flash".into(),
            api_key: "test".into(),
            base_url: String::new(),
            target_language: "vi".into(),
            system_prompt: "Natural manga dialogue".into(),
        };
        let (pipeline, _) = pipeline_configs(&settings).unwrap();
        assert_eq!(
            pipeline.translation.model.model.as_deref(),
            Some("gemini-2.5-flash")
        );
        assert_eq!(pipeline.translation.target_language.tag(), "vi-VN");
    }

    #[test]
    fn idle_timeout_never_interrupts_active_or_sleeping_engine() {
        assert!(idle_expired(true, false, false, 900, 100, 1000));
        assert!(!idle_expired(true, true, false, 900, 100, 1000));
        assert!(!idle_expired(true, false, true, 900, 100, 1000));
        assert!(!idle_expired(false, false, false, 900, 100, 1000));
        assert!(!idle_expired(true, false, false, 0, 100, 1000));
        assert!(!idle_expired(true, false, false, 900, 101, 1000));
    }
}
