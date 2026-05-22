use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    message: String,
    code: Option<&'static str>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
}

impl AppError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: None,
        }
    }

    pub fn with_code(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: Some(code),
        }
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    pub fn payload_too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    pub fn service_unavailable(message: impl Into<String>) -> Self {
        Self::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable",
            message,
        )
    }

    pub fn warehouse_unavailable(message: impl Into<String>) -> Self {
        Self::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "warehouse_unavailable",
            message,
        )
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn code(&self) -> Option<&'static str> {
        self.code
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if self.status.is_server_error() {
            crate::http::observability::server_error(self.status.as_u16(), self.code);
        }
        let public_error = if self.code == Some("warehouse_unavailable") {
            "data warehouse unavailable"
        } else if self.status.is_server_error() {
            if self.status == StatusCode::SERVICE_UNAVAILABLE {
                "service unavailable"
            } else {
                "internal server error"
            }
        } else {
            &self.message
        };
        (
            self.status,
            Json(ErrorBody {
                error: public_error,
                code: self.code,
            }),
        )
            .into_response()
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        tracing::error!(error = ?error, "io error");
        AppError::internal("internal server error")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warehouse_unavailable_preserves_safe_code() {
        let error = AppError::warehouse_unavailable("clickhouse endpoint returned 503");

        assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code(), Some("warehouse_unavailable"));
        assert_eq!(error.message(), "clickhouse endpoint returned 503");
    }
}
