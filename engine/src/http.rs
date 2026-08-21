use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Json, State};
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
        .allow_headers(allowed_headers);

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
        .route("/api/v1/storage/cleanup", post(cleanup_storage))
        .route("/api/v1/models", post(models))
        .route("/api/v1/translate-image", post(translate_image))
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
    let started = Instant::now();
    let result = translate_inner(&state, &headers, body).await;
    match result {
        Ok(bytes) => {
            tracing::info!(
                request_id = %request_id,
                duration_ms = started.elapsed().as_millis(),
                provider = %header(&headers, "x-mt-provider"),
                model = %header(&headers, "x-mt-model"),
                "image translated"
            );
            let mut response = bytes.into_response();
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
            response
        }
        Err(error) => error.response(request_id),
    }
}

async fn translate_inner(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Vec<u8>, AppError> {
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
        provider,
    };
    validate_translation(&settings)?;
    if settings.provider == "deepl" {
        settings.base_url = state
            .models
            .resolve_deepl(&settings.api_key, &settings.base_url)
            .await?;
    }
    state
        .engine
        .translate(
            body.to_vec(),
            safe_filename(&header(headers, "x-mt-filename")),
            settings,
        )
        .await
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
        };
        assert!(validate_translation(&settings).is_err());
    }
}
