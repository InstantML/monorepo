use std::time::Duration;

use axum::http::{header, HeaderMap, Request, Response, Uri};
use tracing::{error, info, warn, Span};
use uuid::Uuid;

use crate::{config::ServicePlaneRole, errors::AppError};

const MAX_LOGGED_HEADER_BYTES: usize = 128;
const MAX_LOGGED_PATH_BYTES: usize = 512;

pub fn request_span<B>(request: &Request<B>, service_plane: ServicePlaneRole) -> Span {
    let headers = request.headers();
    let path = sanitized_request_path(request.uri());
    let request_id = header_value_for_logs(headers, "x-request-id").unwrap_or_default();
    let cf_ray = header_value_for_logs(headers, "cf-ray").unwrap_or_default();
    let cf_connecting_ip_present = headers.contains_key("cf-connecting-ip");
    let user_agent_family = user_agent_family(headers);
    tracing::info_span!(
        "http_request",
        method = %request.method(),
        path = %path,
        version = ?request.version(),
        request_id = %request_id,
        cf_ray = %cf_ray,
        cf_connecting_ip_present,
        user_agent_family = %user_agent_family,
        service_plane = %service_plane.as_str(),
    )
}

pub fn on_response<B>(
    response: &Response<B>,
    latency: Duration,
    span: &Span,
    slow_request_threshold: Duration,
) {
    let status = response.status().as_u16();
    let latency_ms = duration_ms(latency);
    if response.status().is_server_error() {
        error!(
            parent: span,
            status,
            latency_ms,
            "http_request_completed"
        );
    } else {
        info!(
            parent: span,
            status,
            latency_ms,
            "http_request_completed"
        );
    }
    if latency >= slow_request_threshold {
        warn!(
            parent: span,
            status,
            latency_ms,
            slow_request_ms = duration_ms(slow_request_threshold),
            "http_request_slow"
        );
    }
}

pub fn on_failure(failure_class: &dyn std::fmt::Display, latency: Duration, span: &Span) {
    error!(
        parent: span,
        failure_class = %failure_class,
        latency_ms = duration_ms(latency),
        code = "service_failure",
        error_kind = "service_failure",
        retryable = true,
        safe_summary = "service_failure",
        "http_request_failed"
    );
}

pub fn server_error(status: u16, code: Option<&'static str>) {
    let code = code.unwrap_or(if status == 503 {
        "service_unavailable"
    } else {
        "internal_server_error"
    });
    let retryable = status == 503 || code == "warehouse_unavailable";
    let safe_summary = match code {
        "warehouse_unavailable" => "warehouse_unavailable",
        "service_unavailable" => "service_unavailable",
        _ => "server_error",
    };
    error!(
        status,
        code,
        error_kind = code,
        retryable,
        safe_summary,
        "request failed"
    );
}

pub fn readiness_failure(service_plane: ServicePlaneRole, store: &'static str, error: &AppError) {
    warn!(
        service_plane = %service_plane.as_str(),
        status = error.status().as_u16(),
        code = error.code().unwrap_or("service_unavailable"),
        store,
        workflow = "readiness",
        operation = "readyz",
        outcome = "failure",
        stage = "store_ready",
        "readiness check failed"
    );
}

pub fn metric_ingest(
    org_id: Uuid,
    run_id: Uuid,
    metric_count: usize,
    inserted: Option<usize>,
    idempotency_key_present: bool,
    error: Option<&AppError>,
) {
    let outcome = outcome(error);
    let stage = if error.is_some() {
        "metric_insert"
    } else {
        "complete"
    };
    let (status, code, retryable) = error_fields(error);
    info!(
        workflow = "metrics",
        operation = "log_metrics",
        outcome,
        stage,
        status,
        code,
        retryable,
        org_id = %org_id,
        run_id = %run_id,
        metric_count,
        inserted = inserted.unwrap_or(0),
        idempotency_key_present,
        duplicate_request = false,
        "metric ingestion outcome"
    );
}

pub fn console_log_ingest(
    org_id: Uuid,
    run_id: Uuid,
    stream: &str,
    line_count: usize,
    inserted: Option<usize>,
    idempotency_key_present: bool,
    error: Option<&AppError>,
) {
    let outcome = outcome(error);
    let stage = if error.is_some() {
        "console_log_insert"
    } else {
        "complete"
    };
    let (status, code, retryable) = error_fields(error);
    info!(
        workflow = "console_logs",
        operation = "log_console_logs",
        outcome,
        stage,
        status,
        code,
        retryable,
        org_id = %org_id,
        run_id = %run_id,
        stream,
        line_count,
        inserted = inserted.unwrap_or(0),
        idempotency_key_present,
        duplicate_request = false,
        "console log ingestion outcome"
    );
}

pub fn artifact_upload(
    org_id: Uuid,
    run_id: Uuid,
    artifact_id: Option<Uuid>,
    artifact_type: Option<&str>,
    storage_backend: Option<&str>,
    size_bytes: Option<i64>,
    error: Option<&AppError>,
) {
    let outcome = outcome(error);
    let stage = if error.is_some() {
        "artifact_store"
    } else {
        "complete"
    };
    let (status, code, retryable) = error_fields(error);
    info!(
        workflow = "artifacts",
        operation = "upload_artifact",
        outcome,
        stage,
        status,
        code,
        retryable,
        org_id = %org_id,
        run_id = %run_id,
        artifact_id = %artifact_id.map(|id| id.to_string()).unwrap_or_default(),
        artifact_type = artifact_type.unwrap_or(""),
        storage_backend = storage_backend.unwrap_or(""),
        size_bytes = size_bytes.unwrap_or(0),
        range_requested = false,
        "artifact upload outcome"
    );
}

pub struct ArtifactDownloadOutcome<'a> {
    pub org_id: Uuid,
    pub run_id: Uuid,
    pub artifact_id: Uuid,
    pub artifact_type: &'a str,
    pub storage_backend: &'a str,
    pub size_bytes: Option<i64>,
    pub range_requested: bool,
    pub error: Option<&'a AppError>,
}

pub fn artifact_download(download: ArtifactDownloadOutcome<'_>) {
    let outcome = outcome(download.error);
    let stage = if download.error.is_some() {
        "artifact_open"
    } else {
        "complete"
    };
    let (status, code, retryable) = error_fields(download.error);
    info!(
        workflow = "artifacts",
        operation = "download_artifact",
        outcome,
        stage,
        status,
        code,
        retryable,
        org_id = %download.org_id,
        run_id = %download.run_id,
        artifact_id = %download.artifact_id,
        artifact_type = download.artifact_type,
        storage_backend = download.storage_backend,
        size_bytes = download.size_bytes.unwrap_or(0),
        range_requested = download.range_requested,
        "artifact download outcome"
    );
}

pub struct ImportOutcome<'a> {
    pub org_id: Uuid,
    pub source: &'a str,
    pub dry_run: bool,
    pub project_id: Option<Uuid>,
    pub run_count: usize,
    pub metric_count: usize,
    pub artifact_count: usize,
    pub error: Option<&'a AppError>,
}

pub fn import_outcome(outcome_data: ImportOutcome<'_>) {
    let outcome = outcome(outcome_data.error);
    let stage = if outcome_data.error.is_some() {
        "import_payload"
    } else {
        "complete"
    };
    let (status, code, retryable) = error_fields(outcome_data.error);
    info!(
        workflow = "imports",
        operation = "import_payload",
        outcome,
        stage,
        status,
        code,
        retryable,
        org_id = %outcome_data.org_id,
        source = outcome_data.source,
        dry_run = outcome_data.dry_run,
        project_id = %outcome_data.project_id.map(|id| id.to_string()).unwrap_or_default(),
        run_count = outcome_data.run_count,
        metric_count = outcome_data.metric_count,
        artifact_count = outcome_data.artifact_count,
        "import outcome"
    );
}

fn error_fields(error: Option<&AppError>) -> (u16, &'static str, bool) {
    let Some(error) = error else {
        return (200, "ok", false);
    };
    let status = error.status().as_u16();
    let code = error.code().unwrap_or(if status == 503 {
        "service_unavailable"
    } else if status >= 500 {
        "internal_server_error"
    } else {
        "request_rejected"
    });
    let retryable = status == 503 || code == "warehouse_unavailable";
    (status, code, retryable)
}

fn outcome(error: Option<&AppError>) -> &'static str {
    if error.is_some() {
        "failure"
    } else {
        "success"
    }
}

pub fn sanitized_request_path(uri: &Uri) -> String {
    truncate_ascii_for_logs(uri.path(), MAX_LOGGED_PATH_BYTES)
}

pub fn header_value_for_logs(headers: &HeaderMap, name: &str) -> Option<String> {
    let value = headers.get(name)?.to_str().ok()?;
    normalize_header_value(value)
}

pub fn normalize_header_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_LOGGED_HEADER_BYTES {
        return None;
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_graphic() || byte == b' ')
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub fn user_agent_family(headers: &HeaderMap) -> &'static str {
    let raw = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if raw.contains("instantml") || raw.contains("python-requests") || raw.contains("python") {
        "python-sdk"
    } else if raw.contains("mozilla") || raw.contains("chrome") || raw.contains("safari") {
        "browser"
    } else if raw.contains("curl") {
        "curl"
    } else {
        "unknown"
    }
}

fn truncate_ascii_for_logs(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    value
        .char_indices()
        .take_while(|(index, _)| *index < max_bytes)
        .map(|(_, ch)| ch)
        .collect()
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, Uri};

    use super::*;

    #[test]
    fn sanitized_request_path_drops_query_string() {
        let uri: Uri = "/api/runs/summary?q=secret&limit=10".parse().unwrap();

        assert_eq!(sanitized_request_path(&uri), "/api/runs/summary");
    }

    #[test]
    fn normalize_header_value_rejects_empty_long_and_control_values() {
        assert_eq!(normalize_header_value(" req-1 "), Some("req-1".to_string()));
        assert_eq!(normalize_header_value(""), None);
        assert_eq!(normalize_header_value("bad\nvalue"), None);
        assert_eq!(normalize_header_value(&"a".repeat(129)), None);
    }

    #[test]
    fn header_value_for_logs_extracts_safe_values_only() {
        let mut headers = HeaderMap::new();
        headers.insert("x-request-id", HeaderValue::from_static("req_123"));
        headers.insert("cf-ray", HeaderValue::from_str(&"a".repeat(129)).unwrap());

        assert_eq!(
            header_value_for_logs(&headers, "x-request-id"),
            Some("req_123".to_string())
        );
        assert_eq!(header_value_for_logs(&headers, "cf-ray"), None);
    }

    #[test]
    fn user_agent_family_is_coarse() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static("python-requests/2.32"),
        );
        assert_eq!(user_agent_family(&headers), "python-sdk");

        headers.insert(header::USER_AGENT, HeaderValue::from_static("Mozilla/5.0"));
        assert_eq!(user_agent_family(&headers), "browser");

        headers.insert(header::USER_AGENT, HeaderValue::from_static("curl/8.0"));
        assert_eq!(user_agent_family(&headers), "curl");
    }
}
