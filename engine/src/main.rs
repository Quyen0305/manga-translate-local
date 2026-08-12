//! Native manga pipeline worker built directly on Koharu's public Rust crates.
//!
//! Stdout is reserved for NDJSON protocol messages. Diagnostics go to stderr.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use anyhow::{Context, Result, anyhow, bail};
use camino::Utf8PathBuf;
use clap::Parser;
use image::GenericImageView;
use koharu_app::{App, AppConfig, PipelineRunOptions, PipelineSpec, Scope};
use koharu_core::{
    ImageData, ImageRole, LlmLoadRequest, LlmTarget, LlmTargetKind, Node, NodeId, NodeKind, Op,
    Page, PageId, ReadingOrder, Transform,
};
use koharu_llm::providers::ProviderConfig;
use koharu_runtime::{ComputePolicy, RuntimeHttpConfig, RuntimeManager};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const KOHARU_VERSION: &str = "0.61.2";
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

#[derive(Parser)]
#[command(version, about = "Manga Translate source-backed engine worker")]
struct Cli {
    #[arg(long, value_name = "DIR")]
    data_dir: PathBuf,
    #[arg(long)]
    cpu: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequest {
    id: String,
    input_path: PathBuf,
    output_path: PathBuf,
    filename: String,
    settings: TranslationSettings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationSettings {
    provider: String,
    model: String,
    api_key: String,
    base_url: String,
    target_language: String,
    system_prompt: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolMessage<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a str>,
    #[serde(rename = "type")]
    kind: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    koharu_version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ProtocolError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolError {
    code: &'static str,
    message: String,
}

fn main() -> Result<()> {
    std::thread::Builder::new()
        .name("manga-engine".into())
        .stack_size(64 * 1024 * 1024)
        .spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(run())
        })?
        .join()
        .map_err(|_| anyhow!("engine worker panicked"))?
}

async fn run() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    let app = initialize_app(&cli).await?;
    emit(&ProtocolMessage {
        id: None,
        kind: "ready",
        ok: true,
        content_type: None,
        version: Some(env!("CARGO_PKG_VERSION")),
        koharu_version: Some(KOHARU_VERSION),
        error: None,
    })?;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<WorkerRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                emit(&ProtocolMessage {
                    id: None,
                    kind: "result",
                    ok: false,
                    content_type: None,
                    version: None,
                    koharu_version: None,
                    error: Some(ProtocolError {
                        code: "INVALID_REQUEST",
                        message: error.to_string(),
                    }),
                })?;
                continue;
            }
        };

        let result = translate(&app, &request).await;
        let message = match result {
            Ok(()) => ProtocolMessage {
                id: Some(&request.id),
                kind: "result",
                ok: true,
                content_type: Some("image/webp"),
                version: None,
                koharu_version: None,
                error: None,
            },
            Err(error) => ProtocolMessage {
                id: Some(&request.id),
                kind: "result",
                ok: false,
                content_type: None,
                version: None,
                koharu_version: None,
                error: Some(ProtocolError {
                    code: "PIPELINE_FAILED",
                    message: format!("{error:#}"),
                }),
            },
        };
        emit(&message)?;
    }
    Ok(())
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::builder()
        .with_default_directive(tracing::Level::INFO.into())
        .from_env_lossy();
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();
}

async fn initialize_app(cli: &Cli) -> Result<Arc<App>> {
    std::fs::create_dir_all(&cli.data_dir)
        .with_context(|| format!("create engine data dir {}", cli.data_dir.display()))?;
    let data_path = Utf8PathBuf::from_path_buf(cli.data_dir.clone())
        .map_err(|_| anyhow!("engine data path is not valid UTF-8"))?;
    let mut config = AppConfig::default();
    config.data.path = data_path;
    let http = RuntimeHttpConfig {
        connect_timeout_secs: config.http.connect_timeout.max(1),
        read_timeout_secs: config.http.read_timeout.max(1),
        max_retries: config.http.max_retries,
    };
    let compute = if cli.cpu {
        ComputePolicy::CpuOnly
    } else {
        ComputePolicy::PreferGpu
    };
    let runtime = Arc::new(RuntimeManager::new_with_http(
        config.data.path.as_std_path(),
        compute,
        http,
    )?);
    runtime.prepare().await.context("prepare Koharu runtime")?;
    let app = Arc::new(App::new(config, runtime, cli.cpu, "manga-engine")?);
    koharu_llm::suppress_native_logs();
    app.spawn_download_forwarder();
    app.spawn_llm_forwarder();
    Ok(app)
}

async fn translate(app: &Arc<App>, request: &WorkerRequest) -> Result<()> {
    configure_provider(app, &request.settings).await?;
    let project_dir = request
        .output_path
        .parent()
        .ok_or_else(|| anyhow!("output path has no parent"))?
        .join("project.khrproj");
    let project_path = Utf8PathBuf::from_path_buf(project_dir)
        .map_err(|_| anyhow!("project path is not valid UTF-8"))?;
    let session = app
        .open_project(project_path, Some("browser-page".to_string()))
        .await
        .context("open temporary project")?;

    let result = async {
        let page_id = import_page(app, &request.input_path, &request.filename)?;
        let spec = PipelineSpec {
            scope: Scope::Pages(vec![page_id]),
            steps: PIPELINE_STEPS
                .iter()
                .map(|step| (*step).to_string())
                .collect(),
            options: PipelineRunOptions {
                target_language: Some(request.settings.target_language.clone()),
                system_prompt: non_empty(&request.settings.system_prompt),
                default_font: None,
                text_node_ids: None,
                region: None,
                reading_order: Some(ReadingOrder::Rtl),
            },
        };
        let warning_messages = Arc::new(Mutex::new(Vec::new()));
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
        write_rendered(&session, page_id, &request.output_path)
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

fn import_page(app: &App, input: &Path, filename: &str) -> Result<PageId> {
    let bytes = std::fs::read(input).with_context(|| format!("read {}", input.display()))?;
    let decoded = image::load_from_memory(&bytes).context("decode source image")?;
    let (width, height) = decoded.dimensions();
    let session = app
        .current_session()
        .ok_or_else(|| anyhow!("temporary project is not open"))?;
    let blob = session.blobs.put_bytes(&bytes)?;
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

fn write_rendered(
    session: &koharu_app::ProjectSession,
    page_id: PageId,
    output: &Path,
) -> Result<()> {
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
    let bytes = session.blobs.get_bytes(&rendered)?;
    std::fs::write(output, bytes).with_context(|| format!("write {}", output.display()))
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn emit(message: &ProtocolMessage<'_>) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, message)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}
