use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Json, Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;
use uuid::Uuid;

use crate::diagnostics::{
    CudaDiagnostics, StorageDiagnostics, cleanup_storage as clean_storage, legacy_koharu_running,
};
use crate::editor::EditorRequest;
use crate::engine::{KOHARU_VERSION, TranslationSettings};
use crate::error::AppError;
use crate::models::ModelRequest;
use crate::service::AppState;

pub fn router(state: Arc<AppState>) -> Router {
    let allowed_extension_origins = state.config.allowed_extension_origins.clone();
    let allowed_headers = [
        "content-type",
        "x-mt-provider",
        "x-mt-model",
        "x-mt-api-key",
        "x-mt-base-url",
        "x-mt-target-language",
        "x-mt-system-prompt",
        "x-mt-filename",
        "x-mt-job-id",
        "x-mt-visual-context-mode",
    ]
    .into_iter()
    .map(|value| HeaderName::from_static(value))
    .collect::<Vec<_>>();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin.to_str().is_ok_and(|value| {
                allowed_extension_origins
                    .iter()
                    .any(|allowed| allowed == value)
                    || value.starts_with("http://127.0.0.1")
                    || value.starts_with("http://localhost")
            })
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(allowed_headers)
        .expose_headers([
            HeaderName::from_static("x-mt-job-id"),
            HeaderName::from_static("x-mt-visual-context"),
            HeaderName::from_static("x-mt-visual-context-message"),
            HeaderName::from_static("x-mt-editor-session"),
            HeaderName::from_static("x-request-id"),
        ]);

    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/api/v1/diagnostics", get(diagnostics))
        .route("/api/v1/engine/status", get(engine_status))
        .route("/api/v1/engine/unload", post(unload_engine))
        .route("/api/v1/engine/preload", post(preload_engine))
        .route("/api/v1/engine/restart", post(restart_engine))
        .route("/api/v1/engine/retry-gpu", post(retry_gpu))
        .route("/api/v1/engine/policy", post(update_engine_policy))
        .route("/api/v1/jobs/{job_id}", get(job_status))
        .route("/api/v1/jobs/{job_id}/cancel", post(cancel_job))
        .route("/api/v1/storage/cleanup", post(cleanup_storage))
        .route("/api/v1/models", post(models))
        .route("/api/v1/translate-image", post(translate_image))
        .route("/api/v1/editor/{session_id}", get(editor_scene))
        .route("/api/v1/editor/{session_id}/render", post(editor_render))
        .route(
            "/api/v1/editor/{session_id}/retranslate",
            post(editor_retranslate),
        )
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(state.config.max_image_bytes))
        .layer(SetResponseHeaderLayer::if_not_present(
            CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(cors)
        .with_state(state)
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(Health {
        status: "ok",
        mode: "unified",
        engine: state.engine.state(),
        engine_source: format!("koharu-{KOHARU_VERSION}"),
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn ready(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(Ready {
        status: "ready",
        engine: state.engine.state(),
    })
}

async fn diagnostics(State(state): State<Arc<AppState>>) -> Response {
    let data_dir = state.config.data_dir.clone();
    let cpu = state.config.cpu;
    let (storage, cuda) = tokio::join!(
        tokio::task::spawn_blocking(move || StorageDiagnostics::scan(&data_dir)),
        tokio::task::spawn_blocking(move || CudaDiagnostics::collect(cpu)),
    );
    let storage = match storage {
        Ok(Ok(storage)) => storage,
        Ok(Err(error)) => {
            return AppError::internal(format!("Storage scan failed: {error:#}"))
                .response(Uuid::new_v4());
        }
        Err(error) => {
            return AppError::internal(format!("Storage scan task failed: {error}"))
                .response(Uuid::new_v4());
        }
    };
    let cuda = match cuda {
        Ok(cuda) => cuda,
        Err(error) => {
            return AppError::internal(format!("CUDA diagnostics failed: {error}"))
                .response(Uuid::new_v4());
        }
    };
    (
        StatusCode::OK,
        axum::Json(DiagnosticsResponse {
            engine: state.engine.diagnostics(),
            service: state.service.diagnostics(),
            cuda,
            storage,
        }),
    )
        .into_response()
}

async fn engine_status(State(state): State<Arc<AppState>>) -> Response {
    lifecycle_response(&state, "status")
}

async fn unload_engine(State(state): State<Arc<AppState>>) -> Response {
    let request_id = Uuid::new_v4();
    match state.engine.request_unload("manual") {
        Ok(unloaded) => lifecycle_response(&state, if unloaded { "unloaded" } else { "sleeping" }),
        Err(error) => lifecycle_error(error, request_id),
    }
}

async fn preload_engine(State(state): State<Arc<AppState>>) -> Response {
    let request_id = Uuid::new_v4();
    match state.engine.preload().await {
        Ok(loaded) => {
            lifecycle_response(&state, if loaded { "preloaded" } else { "already-ready" })
        }
        Err(error) => lifecycle_error(error, request_id),
    }
}

async fn restart_engine(State(state): State<Arc<AppState>>) -> Response {
    let request_id = Uuid::new_v4();
    match state.engine.restart().await {
        Ok(()) => lifecycle_response(&state, "restarted"),
        Err(error) => lifecycle_error(error, request_id),
    }
}

async fn retry_gpu(State(state): State<Arc<AppState>>) -> Response {
    let request_id = Uuid::new_v4();
    match state.engine.retry_gpu().await {
        Ok(restored) => lifecycle_response(
            &state,
            if restored {
                "gpu-restored"
            } else {
                "gpu-already-active"
            },
        ),
        Err(error) if error.to_string().contains("CPU-only mode") => {
            AppError::validation("Engine được khởi động ở chế độ chỉ CPU").response(request_id)
        }
        Err(error) if error.to_string().contains("engine is busy") => {
            AppError::conflict("Engine đang xử lý ảnh; hãy thử lại GPU sau").response(request_id)
        }
        Err(error) => AppError::engine_code(
            "GPU_RETRY_FAILED",
            format!("Không khôi phục được GPU: {error:#}. Engine vẫn giữ CPU fallback."),
        )
        .response(request_id),
    }
}

async fn update_engine_policy(
    State(state): State<Arc<AppState>>,
    Json(policy): Json<crate::config::LifecyclePolicy>,
) -> Response {
    let request_id = Uuid::new_v4();
    match state.engine.update_lifecycle_policy(policy) {
        Ok(()) => lifecycle_response(&state, "policy-updated"),
        Err(error) => {
            AppError::validation(format!("Invalid engine policy: {error:#}")).response(request_id)
        }
    }
}

fn lifecycle_response(state: &AppState, action: &'static str) -> Response {
    (
        StatusCode::OK,
        axum::Json(LifecycleResponse {
            action,
            engine: state.engine.diagnostics(),
        }),
    )
        .into_response()
}

fn lifecycle_error(error: anyhow::Error, request_id: Uuid) -> Response {
    if error.to_string().contains("engine is busy") {
        AppError::conflict("Engine đang xử lý ảnh; hãy thử lại sau khi hàng đợi hoàn tất")
            .response(request_id)
    } else {
        AppError::engine(format!("Engine lifecycle operation failed: {error:#}"))
            .response(request_id)
    }
}

async fn cleanup_storage(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CleanupRequest>,
) -> Response {
    let request_id = Uuid::new_v4();
    if matches!(state.engine.state(), "busy" | "loading") {
        return AppError::conflict(
            "Engine đang xử lý ảnh; hãy dọn cache sau khi hàng đợi hoàn tất",
        )
        .response(request_id);
    }
    if ![
        "downloads",
        "staging",
        "visual-context-cache",
        "legacy-runtime",
        "legacy-models",
        "legacy-cache",
    ]
    .contains(&request.target.as_str())
    {
        return AppError::validation("Nhóm dữ liệu cần dọn không hợp lệ").response(request_id);
    }
    if request.target.starts_with("legacy-") && legacy_koharu_running() {
        return AppError::conflict(
            "Koharu desktop đang chạy; hãy thoát Koharu trước khi dọn dữ liệu cũ",
        )
        .response(request_id);
    }
    let data_dir = state.config.data_dir.clone();
    let target = request.target.clone();
    match tokio::task::spawn_blocking(move || clean_storage(&data_dir, &target)).await {
        Ok(Ok(freed_bytes)) => (
            StatusCode::OK,
            axum::Json(CleanupResponse {
                target: request.target,
                freed_bytes,
            }),
        )
            .into_response(),
        Ok(Err(error)) => {
            AppError::internal(format!("Không dọn được dữ liệu: {error:#}")).response(request_id)
        }
        Err(error) => {
            AppError::internal(format!("Tác vụ dọn cache thất bại: {error}")).response(request_id)
        }
    }
}

async fn models(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let request_id = Uuid::new_v4();
    let request = ModelRequest {
        provider: header(&headers, "x-mt-provider"),
        api_key: header(&headers, "x-mt-api-key"),
        base_url: header(&headers, "x-mt-base-url")
            .trim_end_matches('/')
            .to_string(),
    };
    match state.models.list(request).await {
        Ok(models) => (StatusCode::OK, axum::Json(ModelsResponse { models })).into_response(),
        Err(error) => error.response(request_id),
    }
}

async fn translate_image(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request_id = Uuid::new_v4();
    let job_id = match translation_job_id(&headers) {
        Ok(job_id) => job_id,
        Err(error) => return error.response(request_id),
    };
    let visual_context_enabled =
        header(&headers, "x-mt-visual-context-mode") == crate::visual_context::MODE;
    if let Err(error) = state.jobs.create(job_id.clone(), visual_context_enabled) {
        return AppError::internal(format!("Không tạo được translation job: {error:#}"))
            .response(request_id);
    }
    let started = Instant::now();
    let result = translate_inner(&state, &headers, body, &job_id).await;
    match result {
        Ok(output) => {
            tracing::info!(
                request_id = %request_id,
                duration_ms = started.elapsed().as_millis(),
                provider = %header(&headers, "x-mt-provider"),
                model = %header(&headers, "x-mt-model"),
                "image translated"
            );
            let mut response = output.bytes.into_response();
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("image/png"));
            response
                .headers_mut()
                .insert("x-mt-cache", HeaderValue::from_static("miss"));
            response.headers_mut().insert(
                "x-request-id",
                HeaderValue::from_str(&request_id.to_string())
                    .unwrap_or_else(|_| HeaderValue::from_static("invalid")),
            );
            if let Some(session_id) = output.editor_session_id
                && let Ok(value) = HeaderValue::from_str(&session_id)
            {
                response.headers_mut().insert("x-mt-editor-session", value);
            }
            response.headers_mut().insert(
                "x-mt-job-id",
                HeaderValue::from_str(&job_id)
                    .unwrap_or_else(|_| HeaderValue::from_static("invalid")),
            );
            if let Some(job) = state.jobs.status(&job_id) {
                if let Some(context_state) = job.visual_context_state.as_deref()
                    && let Ok(value) = HeaderValue::from_str(context_state)
                {
                    response.headers_mut().insert("x-mt-visual-context", value);
                }
                if let Some(message) = job.visual_context_message.as_deref()
                    && let Ok(value) = HeaderValue::from_str(&urlencoding::encode(message))
                {
                    response
                        .headers_mut()
                        .insert("x-mt-visual-context-message", value);
                }
            }
            response
        }
        Err(error) => {
            if error.code == "JOB_CANCELLED" {
                state.jobs.mark_cancelled(&job_id);
            } else {
                state.jobs.fail(&job_id, &error.message);
            }
            error.response(request_id)
        }
    }
}

async fn job_status(State(state): State<Arc<AppState>>, Path(job_id): Path<String>) -> Response {
    job_status_response(&state.jobs, &job_id)
}

fn job_status_response(jobs: &crate::jobs::JobRegistry, job_id: &str) -> Response {
    match jobs.status(job_id) {
        Some(status) => (StatusCode::OK, axum::Json(status)).into_response(),
        // Polling can arrive before the image POST has finished creating its job.
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

async fn cancel_job(State(state): State<Arc<AppState>>, Path(job_id): Path<String>) -> Response {
    if !state.jobs.cancel(&job_id) {
        return AppError::new(
            "JOB_NOT_CANCELLABLE",
            StatusCode::CONFLICT,
            "Tác vụ không tồn tại hoặc đã kết thúc",
        )
        .response(Uuid::new_v4());
    }
    match state.jobs.status(&job_id) {
        Some(status) => (StatusCode::OK, axum::Json(status)).into_response(),
        None => AppError::internal("Không đọc lại được trạng thái tác vụ").response(Uuid::new_v4()),
    }
}

async fn translate_inner(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    body: Bytes,
    job_id: &str,
) -> Result<crate::engine::TranslationOutput, AppError> {
    let content_type = header(headers, "content-type")
        .split(';')
        .next()
        .unwrap_or_default()
        .to_string();
    if !content_type.starts_with("image/") {
        return Err(AppError::validation("Request body is not an image"));
    }
    if body.is_empty() {
        return Err(AppError::validation("Image is empty"));
    }

    let settings = translation_settings(state, headers).await?;
    state
        .engine
        .translate(
            body.to_vec(),
            safe_filename(&header(headers, "x-mt-filename")),
            settings,
            job_id.to_owned(),
            state.jobs.clone(),
        )
        .await
}

async fn editor_scene(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Response {
    match state.engine.editor_scene(&session_id) {
        Ok(scene) => (StatusCode::OK, Json(scene)).into_response(),
        Err(error) => error.response(Uuid::new_v4()),
    }
}

async fn editor_render(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(request): Json<EditorRequest>,
) -> Response {
    editor_render_inner(&state, session_id, request, None).await
}

async fn editor_retranslate(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<EditorRequest>,
) -> Response {
    let settings = match translation_settings(&state, &headers).await {
        Ok(settings) => settings,
        Err(error) => return error.response(Uuid::new_v4()),
    };
    editor_render_inner(&state, session_id, request, Some(settings)).await
}

async fn editor_render_inner(
    state: &Arc<AppState>,
    session_id: String,
    request: EditorRequest,
    settings: Option<TranslationSettings>,
) -> Response {
    let request_id = Uuid::new_v4();
    match state
        .engine
        .edit_render(session_id.clone(), request, settings)
        .await
    {
        Ok(output) => {
            let mut response = output.bytes.into_response();
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("image/png"));
            if let Ok(value) = HeaderValue::from_str(&output.scene.session_id) {
                response.headers_mut().insert("x-mt-editor-session", value);
            }
            response
        }
        Err(error) => error.response(request_id),
    }
}

async fn translation_settings(
    state: &Arc<AppState>,
    headers: &HeaderMap,
) -> Result<TranslationSettings, AppError> {
    let provider = header(headers, "x-mt-provider");
    let mut settings = TranslationSettings {
        model: if provider == "deepl" {
            "mt".to_string()
        } else {
            header(headers, "x-mt-model")
        },
        api_key: header(headers, "x-mt-api-key"),
        base_url: header(headers, "x-mt-base-url")
            .trim_end_matches('/')
            .to_string(),
        target_language: default_string(header(headers, "x-mt-target-language"), "vi"),
        system_prompt: urlencoding::decode(&header(headers, "x-mt-system-prompt"))
            .map(|value| value.into_owned())
            .unwrap_or_default(),
        visual_context_mode: default_string(header(headers, "x-mt-visual-context-mode"), "off"),
        provider,
    };
    validate_translation(&settings)?;
    if settings.provider == "deepl" {
        settings.base_url = state
            .models
            .resolve_deepl(&settings.api_key, &settings.base_url)
            .await?;
    }
    Ok(settings)
}

fn translation_job_id(headers: &HeaderMap) -> Result<String, AppError> {
    let value = header(headers, "x-mt-job-id");
    if value.is_empty() {
        return Ok(Uuid::new_v4().to_string());
    }
    Uuid::parse_str(&value)
        .map(|id| id.to_string())
        .map_err(|_| AppError::validation("Translation job ID không hợp lệ"))
}

fn validate_translation(settings: &TranslationSettings) -> Result<(), AppError> {
    if ![
        "openai",
        "gemini",
        "claude",
        "deepseek",
        "deepl",
        "google-translate",
        "caiyun",
        "openai-compatible",
    ]
    .contains(&settings.provider.as_str())
    {
        return Err(AppError::validation("Invalid translation provider"));
    }
    if settings.model.trim().is_empty() {
        return Err(AppError::validation("Translation model is missing"));
    }
    if settings.target_language.trim().is_empty() {
        return Err(AppError::validation("Target language is missing"));
    }
    if settings.provider != "openai-compatible" && settings.api_key.trim().is_empty() {
        return Err(AppError::validation("API key is missing"));
    }
    if settings.provider == "openai-compatible" && settings.base_url.trim().is_empty() {
        return Err(AppError::validation(
            "OpenAI-compatible requires a Base URL",
        ));
    }
    if !["off", crate::visual_context::MODE].contains(&settings.visual_context_mode.as_str()) {
        return Err(AppError::validation("Visual context mode is invalid"));
    }
    Ok(())
}

fn header(headers: &HeaderMap, name: &'static str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn default_string(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn safe_filename(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || ['.', '_', '-'].contains(&character) {
                character
            } else {
                '_'
            }
        })
        .collect();
    let value = value.chars().rev().take(120).collect::<String>();
    let value = value.chars().rev().collect::<String>();
    if value.is_empty() {
        "manga-page.png".into()
    } else {
        value
    }
}

async fn not_found() -> Response {
    AppError::new("NOT_FOUND", StatusCode::NOT_FOUND, "Endpoint not found").response(Uuid::new_v4())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    status: &'static str,
    mode: &'static str,
    engine: &'static str,
    engine_source: String,
    version: &'static str,
}

#[derive(Serialize)]
struct Ready {
    status: &'static str,
    engine: &'static str,
}

#[derive(Serialize)]
struct ModelsResponse {
    models: Vec<crate::models::ModelInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsResponse {
    engine: crate::engine::EngineDiagnostics,
    service: crate::service::ServiceDiagnostics,
    cuda: CudaDiagnostics,
    storage: StorageDiagnostics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleResponse {
    action: &'static str,
    engine: crate::engine::EngineDiagnostics,
}

#[derive(Deserialize)]
struct CleanupRequest {
    target: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupResponse {
    target: String,
    freed_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_is_sanitized_and_bounded() {
        assert_eq!(safe_filename("../bad name.png"), ".._bad_name.png");
        assert!(safe_filename(&"x".repeat(200)).len() <= 120);
    }

    #[test]
    fn openai_compatible_requires_base_url() {
        let settings = TranslationSettings {
            provider: "openai-compatible".into(),
            model: "qwen".into(),
            api_key: String::new(),
            base_url: String::new(),
            target_language: "vi".into(),
            system_prompt: String::new(),
            visual_context_mode: "off".into(),
        };
        assert!(validate_translation(&settings).is_err());
    }

    #[test]
    fn translation_job_id_accepts_uuid_and_generates_default() {
        let generated = translation_job_id(&HeaderMap::new()).expect("generated job id");
        assert!(Uuid::parse_str(&generated).is_ok());

        let expected = Uuid::new_v4();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-mt-job-id",
            HeaderValue::from_str(&expected.to_string()).expect("job header"),
        );
        assert_eq!(
            translation_job_id(&headers).expect("valid job id"),
            expected.to_string()
        );
    }

    #[test]
    fn translation_job_id_rejects_arbitrary_text() {
        let mut headers = HeaderMap::new();
        headers.insert("x-mt-job-id", HeaderValue::from_static("not-a-uuid"));
        let error = translation_job_id(&headers).expect_err("invalid job id");
        assert_eq!(error.code, "VALIDATION_ERROR");
    }

    #[test]
    fn polling_an_uncreated_job_is_an_empty_non_error_response() {
        let jobs = crate::jobs::JobRegistry::default();
        assert_eq!(
            job_status_response(&jobs, "not-created").status(),
            StatusCode::NO_CONTENT
        );
        jobs.create("created".into(), false).unwrap();
        assert_eq!(
            job_status_response(&jobs, "created").status(),
            StatusCode::OK
        );
    }
}
