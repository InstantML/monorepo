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
    field: Option<&'static str>,
    position: Option<usize>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<usize>,
}

impl AppError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: None,
            field: None,
            position: None,
        }
    }

    pub fn with_code(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: Some(code),
            field: None,
            position: None,
        }
    }

    pub fn with_field_code(
        status: StatusCode,
        code: &'static str,
        field: &'static str,
        position: Option<usize>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            message: message.into(),
            code: Some(code),
            field: Some(field),
            position,
        }
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn search_validation(message: impl Into<String>, position: Option<usize>) -> Self {
        Self::with_field_code(
            StatusCode::BAD_REQUEST,
            "run_search_invalid",
            "q",
            position,
            message,
        )
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

    pub fn safe_code(&self) -> &'static str {
        self.code
            .unwrap_or(if self.status == StatusCode::SERVICE_UNAVAILABLE {
                "service_unavailable"
            } else if self.status.is_server_error() {
                "internal_server_error"
            } else {
                "request_rejected"
            })
    }

    pub fn retryable(&self) -> bool {
        self.status == StatusCode::TOO_MANY_REQUESTS
            || self.status == StatusCode::SERVICE_UNAVAILABLE
            || self.safe_code() == "warehouse_unavailable"
    }

    pub fn safe_summary(&self) -> &'static str {
        match self.safe_code() {
            "warehouse_unavailable" => "warehouse_unavailable",
            "service_unavailable" => "service_unavailable",
            "run_search_invalid" | "run_search_regex_unsupported" => "search_validation_failed",
            _ if self.status == StatusCode::UNAUTHORIZED => "authentication_required",
            _ if self.status == StatusCode::FORBIDDEN => "access_denied",
            _ if self.status == StatusCode::NOT_FOUND => "not_found",
            _ if self.status == StatusCode::CONFLICT => "conflict",
            _ if self.status == StatusCode::TOO_MANY_REQUESTS => "rate_limited",
            _ if self.status.is_server_error() => "server_error",
            _ => "request_rejected",
        }
    }

    pub fn field(&self) -> Option<&'static str> {
        self.field
    }

    pub fn position(&self) -> Option<usize> {
        self.position
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        crate::http::observability::error_response(
            self.status.as_u16(),
            self.code,
            self.field,
            self.position,
        );
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
                field: self.field,
                position: self.position,
            }),
        )
            .into_response()
    }
}

impl From<std::io::Error> for AppError {
    fn from(_error: std::io::Error) -> Self {
        tracing::error!(
            workflow = "io",
            operation = "convert_error",
            outcome = "failure",
            status = 500,
            code = "internal_server_error",
            error_kind = "io_error",
            retryable = false,
            safe_summary = "io_error",
            "io error"
        );
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
        assert_eq!(error.safe_code(), "warehouse_unavailable");
        assert_eq!(error.safe_summary(), "warehouse_unavailable");
        assert!(error.retryable());
        assert_eq!(error.message(), "clickhouse endpoint returned 503");
    }

    #[test]
    fn safe_error_facts_do_not_depend_on_message_text() {
        let error = AppError::with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limit_exceeded",
            "raw details stay out of logs",
        );

        assert_eq!(error.safe_code(), "rate_limit_exceeded");
        assert_eq!(error.safe_summary(), "rate_limited");
        assert!(error.retryable());

        let error = AppError::internal("database secret should not be logged");
        assert_eq!(error.safe_code(), "internal_server_error");
        assert_eq!(error.safe_summary(), "server_error");
        assert!(!error.retryable());
    }
}
