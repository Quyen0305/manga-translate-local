use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result, anyhow, bail};
use camino::Utf8PathBuf;
use image::GenericImageView;
use koharu_app::{App, AppConfig as KoharuConfig, PipelineRunOptions, PipelineSpec, Scope};
use koharu_core::{
    ImageData, ImageRole, LlmLoadRequest, LlmTarget, LlmTargetKind, Node, NodeId, NodeKind, Op,
    Page, PageId, ReadingOrder, Transform,
};
use koharu_llm::providers::ProviderConfig;
use koharu_runtime::{ComputePolicy, RuntimeHttpConfig, RuntimeManager};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::config::AppConfig;
use crate::error::AppError;

pub const KOHARU_VERSION: &str = "0.61.2";
const PIPELINE_STEPS: &[&str] = &[
    "comic-text-bubble-detector",
    "comic-text-detector-seg",
    "speech-bubble-segmentation",
    "paddle-ocr-vl-1.6",
    "yuzumarker-font-detection",
    "llm",
    "lama-manga",
    "koharu-renderer",
];

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
    app: RwLock<Option<Arc<App>>>,
    init_lock: Mutex<()>,
    job_lock: Mutex<()>,
}

impl Engine {
    pub fn new(config: AppConfig) -> Self {
        Self {
            config,
            app: RwLock::new(None),
            init_lock: Mutex::new(()),
            job_lock: Mutex::new(()),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.app.read().map(|app| app.is_some()).unwrap_or(false)
    }

    pub fn unload(&self) {
        if let Ok(mut app) = self.app.write() {
            *app = None;
        }
        tracing::info!("engine unloaded");
    }

    pub async fn translate(
        &self,
        image: Vec<u8>,
        filename: String,
        settings: TranslationSettings,
    ) -> Result<Vec<u8>, AppError> {
        let _job = self.job_lock.lock().await;
        let app = self.ensure_app().await.map_err(|error| {
            AppError::engine(format!("Could not initialize the Koharu engine: {error:#}"))
        })?;
        translate_with_app(&app, &image, &filename, &settings)
            .await
            .map_err(|error| AppError::engine(format!("{error:#}")))
    }

    async fn ensure_app(&self) -> Result<Arc<App>> {
        if let Some(app) = self.app.read().ok().and_then(|app| app.clone()) {
            return Ok(app);
        }
        let _init = self.init_lock.lock().await;
        if let Some(app) = self.app.read().ok().and_then(|app| app.clone()) {
            return Ok(app);
        }
        let app = initialize_app(&self.config).await?;
        *self
            .app
            .write()
            .map_err(|_| anyhow!("engine state lock poisoned"))? = Some(app.clone());
        Ok(app)
    }
}

async fn initialize_app(config: &AppConfig) -> Result<Arc<App>> {
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("create engine data dir {}", config.data_dir.display()))?;
    let data_path = Utf8PathBuf::from_path_buf(config.data_dir.clone())
        .map_err(|_| anyhow!("engine data path is not valid UTF-8"))?;
    let mut koharu = KoharuConfig::default();
    koharu.data.path = data_path;
    let http = RuntimeHttpConfig {
        connect_timeout_secs: koharu.http.connect_timeout.max(1),
        read_timeout_secs: koharu.http.read_timeout.max(1),
        max_retries: koharu.http.max_retries,
    };
    let compute = if config.cpu {
        ComputePolicy::CpuOnly
    } else {
        ComputePolicy::PreferGpu
    };
    let runtime = Arc::new(RuntimeManager::new_with_http(
        koharu.data.path.as_std_path(),
        compute,
        http,
    )?);
    runtime.prepare().await.context("prepare Koharu runtime")?;
    let app = Arc::new(App::new(koharu, runtime, config.cpu, "manga-translate")?);
    koharu_llm::suppress_native_logs();
    app.spawn_download_forwarder();
    app.spawn_llm_forwarder();
    tracing::info!(
        koharu_version = KOHARU_VERSION,
        cpu = config.cpu,
        "engine ready"
    );
    Ok(app)
}

async fn translate_with_app(
    app: &Arc<App>,
    image: &[u8],
    filename: &str,
    settings: &TranslationSettings,
) -> Result<Vec<u8>> {
    configure_provider(app, settings).await?;
    let project_dir = tempfile::Builder::new()
        .prefix("manga-translate-")
        .tempdir()
        .context("create temporary project directory")?;
    let project_path = Utf8PathBuf::from_path_buf(project_dir.path().join("project.khrproj"))
        .map_err(|_| anyhow!("temporary project path is not valid UTF-8"))?;
    let session = app
        .open_project(project_path, Some("browser-page".to_string()))
        .await
        .context("open temporary project")?;

    let result = async {
        let page_id = import_page(app, image, filename)?;
        let spec = PipelineSpec {
            scope: Scope::Pages(vec![page_id]),
            steps: PIPELINE_STEPS
                .iter()
                .map(|step| (*step).to_string())
                .collect(),
            options: PipelineRunOptions {
                target_language: Some(settings.target_language.clone()),
                system_prompt: non_empty(&settings.system_prompt),
                default_font: None,
                text_node_ids: None,
                region: None,
                reading_order: Some(ReadingOrder::Rtl),
            },
        };
        let warning_messages = Arc::new(std::sync::Mutex::new(Vec::new()));
        let warning_output = warning_messages.clone();
        let warning_sink: koharu_app::pipeline::WarningSink = Arc::new(move |warning| {
            if let Ok(mut messages) = warning_output.lock() {
                messages.push(format!("{}: {}", warning.step_id, warning.message));
            }
        });
        let outcome = koharu_app::pipeline::run(
            session.clone(),
            app.registry.clone(),
            app.runtime.clone(),
            app.cpu_only(),
            app.llm.clone(),
            app.renderer.clone(),
            spec,
            Arc::new(AtomicBool::new(false)),
            None,
            Some(warning_sink),
        )
        .await
        .context("run Koharu pipeline")?;
        if outcome.warning_count > 0 {
            let detail = warning_messages
                .lock()
                .map(|messages| messages.join("; "))
                .unwrap_or_default();
            bail!(
                "pipeline completed with {} failed step(s): {}",
                outcome.warning_count,
                detail
            );
        }
        rendered_bytes(&session, page_id)
    }
    .await;

    app.close_project().await.ok();
    result
}

async fn configure_provider(app: &App, settings: &TranslationSettings) -> Result<()> {
    let target = LlmTarget {
        kind: LlmTargetKind::Provider,
        model_id: settings.model.clone(),
        provider_id: Some(settings.provider.clone()),
    };
    let provider = ProviderConfig {
        http_client: app.runtime.http_client(),
        api_key: non_empty(&settings.api_key),
        base_url: non_empty(&settings.base_url),
        temperature: Some(0.2),
        max_tokens: Some(4096),
    };
    app.llm
        .load_from_request(
            LlmLoadRequest {
                target,
                options: None,
            },
            Some(provider),
        )
        .await
        .context("configure translation provider")
}

fn import_page(app: &App, bytes: &[u8], filename: &str) -> Result<PageId> {
    let decoded = image::load_from_memory(bytes).context("decode source image")?;
    let (width, height) = decoded.dimensions();
    let session = app
        .current_session()
        .ok_or_else(|| anyhow!("temporary project is not open"))?;
    let blob = session.blobs.put_bytes(bytes)?;
    let mut page = Page::new(filename, width, height);
    let page_id = page.id;
    let node_id = NodeId::new();
    page.nodes.insert(
        node_id,
        Node {
            id: node_id,
            transform: Transform::default(),
            visible: true,
            kind: NodeKind::Image(ImageData {
                role: ImageRole::Source,
                blob,
                opacity: 1.0,
                natural_width: width,
                natural_height: height,
                name: Some(filename.to_string()),
            }),
        },
    );
    app.apply(Op::AddPage { page, at: 0 })?;
    Ok(page_id)
}

fn rendered_bytes(session: &koharu_app::ProjectSession, page_id: PageId) -> Result<Vec<u8>> {
    let rendered = {
        let scene = session.scene.read();
        let page = scene
            .pages
            .get(&page_id)
            .ok_or_else(|| anyhow!("translated page disappeared"))?;
        page.nodes.values().find_map(|node| match &node.kind {
            NodeKind::Image(image) if image.role == ImageRole::Rendered => Some(image.blob.clone()),
            _ => None,
        })
    }
    .ok_or_else(|| anyhow!("pipeline did not produce a rendered image"))?;
    Ok(session.blobs.get_bytes(&rendered)?)
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}
