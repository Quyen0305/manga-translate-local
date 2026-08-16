use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Serialize;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;
use uuid::Uuid;

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
        engine: if state.engine.is_ready() {
            "ready"
        } else {
            "sleeping"
        },
        engine_source: format!("koharu-{KOHARU_VERSION}"),
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn ready(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(Ready {
        status: "ready",
        engine: if state.engine.is_ready() {
            "ready"
        } else {
            "sleeping"
        },
    })
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
                .insert(CONTENT_TYPE, HeaderValue::from_static("image/webp"));
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
