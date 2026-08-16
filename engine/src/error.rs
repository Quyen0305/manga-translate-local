use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug)]
pub struct AppError {
    pub code: &'static str,
    pub status: StatusCode,
    pub message: String,
}

impl AppError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(
            "VALIDATION_ERROR",
            StatusCode::UNPROCESSABLE_ENTITY,
            message,
        )
    }

    pub fn provider(message: impl Into<String>) -> Self {
        Self::new("PROVIDER_API_ERROR", StatusCode::BAD_GATEWAY, message)
    }

    pub fn engine(message: impl Into<String>) -> Self {
        Self::new("ENGINE_ERROR", StatusCode::BAD_GATEWAY, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL_ERROR", StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    pub fn new(code: &'static str, status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            code,
            status,
            message: message.into(),
        }
    }

    pub fn response(self, request_id: Uuid) -> Response {
        tracing::error!(
            request_id = %request_id,
            code = self.code,
            status = self.status.as_u16(),
            error = %self.message,
            "request failed"
        );
        (
            self.status,
            Json(ErrorEnvelope {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                    request_id: request_id.to_string(),
                },
            }),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        Self::internal(format!("{error:#}"))
    }
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: String,
    request_id: String,
}
