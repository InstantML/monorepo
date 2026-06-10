use std::time::Duration;

use axum::{
    extract::Request as AxumRequest,
    http::{header, HeaderMap, HeaderValue, Request, Response, Uri},
    middleware::Next,
    response::Response as AxumResponse,
};
use tracing::{error, info, warn, Span};
use uuid::Uuid;

use crate::{config::ServicePlaneRole, errors::AppError};

const MAX_LOGGED_HEADER_BYTES: usize = 128;
const MAX_LOGGED_PATH_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoutePlane {
    Platform,
    Control,
    Data,
    Unknown,
}

impl RoutePlane {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Platform => "platform",
            Self::Control => "control",
            Self::Data => "data",
            Self::Unknown => "unknown",
        }
    }

    pub fn tag(self) -> &'static str {
        match self {
            Self::Platform => "[Platform]",
            Self::Control => "[Control]",
            Self::Data => "[Data]",
            Self::Unknown => "[Unknown]",
        }
    }
}

pub async fn normalize_request_id_header(mut request: AxumRequest, next: Next) -> AxumResponse {
    let value =
        request_id_for_logs(request.headers()).unwrap_or_else(|| Uuid::new_v4().to_string());
    if request
        .headers()
        .get("x-request-id")
        .and_then(|header| header.to_str().ok())
        .is_none_or(|raw| raw != value)
    {
        if let Ok(value) = HeaderValue::from_str(&value) {
            request.headers_mut().insert("x-request-id", value);
        } else {
            request.headers_mut().remove("x-request-id");
        }
    }
    next.run(request).await
}

pub fn request_span<B>(request: &Request<B>, service_plane: ServicePlaneRole) -> Span {
    let headers = request.headers();
    let path = safe_request_path(request.uri());
    let route_plane = route_plane_for_path(request.uri().path());
    let request_id = request_id_for_logs(headers).unwrap_or_default();
    let trace_id = request_id.clone();
    let cf_ray = cf_ray_for_logs(headers).unwrap_or_default();
    let cf_connecting_ip_present = headers.contains_key("cf-connecting-ip");
    let user_agent_family = user_agent_family(headers);
    tracing::info_span!(
        "http_request",
        method = %request.method(),
        path = %path,
        version = ?request.version(),
        request_id = %request_id,
        trace_id = %trace_id,
        cf_ray = %cf_ray,
        cf_connecting_ip_present,
        user_agent_family = %user_agent_family,
        service_plane = %service_plane.as_str(),
        route_plane = %route_plane.as_str(),
        plane_tag = %route_plane.tag(),
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

pub fn error_response(
    status: u16,
    code: Option<&'static str>,
    field: Option<&'static str>,
    position: Option<usize>,
) {
    let code = safe_error_code(status, code);
    let retryable = status == 429 || status == 503 || code == "warehouse_unavailable";
    let safe_summary = safe_error_summary(status, code);
    let field = safe_error_field(field).unwrap_or("");
    let position = position.unwrap_or(0);
    if status >= 500 {
        error!(
            workflow = "http_error",
            operation = "respond",
            outcome = "failure",
            status,
            code,
            field,
            position,
            error_kind = code,
            retryable,
            safe_summary,
            "error response"
        );
    } else if retryable || status == 429 {
        warn!(
            workflow = "http_error",
            operation = "respond",
            outcome = "failure",
            status,
            code,
            field,
            position,
            error_kind = code,
            retryable,
            safe_summary,
            "error response"
        );
    } else {
        info!(
            workflow = "http_error",
            operation = "respond",
            outcome = "failure",
            status,
            code,
            field,
            position,
            error_kind = code,
            retryable,
            safe_summary,
            "error response"
        );
    }
}

pub struct RateLimitRejection<'a> {
    pub org_id: Option<Uuid>,
    pub request_class: &'a str,
    pub scope: &'static str,
    pub code: &'static str,
    pub retryable: bool,
    pub retry_after_secs: u64,
    pub limit: i64,
    pub remaining: i64,
    pub usage: Option<i64>,
    pub projected_usage: Option<i64>,
    pub plan_tier: Option<&'a str>,
    pub overage_mode: Option<&'a str>,
}

pub fn rate_limit_rejected(rejection: RateLimitRejection<'_>) {
    warn!(
        workflow = "rate_limit",
        operation = "reject",
        outcome = "failure",
        status = 429,
        code = rejection.code,
        error_kind = rejection.code,
        retryable = rejection.retryable,
        safe_summary = "rate_limited",
        org_id = %rejection.org_id.map(|id| id.to_string()).unwrap_or_default(),
        request_class = rejection.request_class,
        scope = rejection.scope,
        retry_after_secs = rejection.retry_after_secs,
        limit = rejection.limit,
        remaining = rejection.remaining,
        usage = rejection.usage.unwrap_or(0),
        projected_usage = rejection.projected_usage.unwrap_or(0),
        plan_tier = rejection.plan_tier.unwrap_or(""),
        overage_mode = rejection.overage_mode.unwrap_or(""),
        "rate limit rejected request"
    );
}

fn safe_error_code(status: u16, code: Option<&'static str>) -> &'static str {
    code.unwrap_or(if status == 503 {
        "service_unavailable"
    } else if status >= 500 {
        "internal_server_error"
    } else {
        "request_rejected"
    })
}

fn safe_error_summary(status: u16, code: &'static str) -> &'static str {
    match code {
        "warehouse_unavailable" => "warehouse_unavailable",
        "service_unavailable" => "service_unavailable",
        "run_search_invalid" | "run_search_regex_unsupported" => "search_validation_failed",
        _ if status == 401 => "authentication_required",
        _ if status == 403 => "access_denied",
        _ if status == 404 => "not_found",
        _ if status == 409 => "conflict",
        _ if status == 429 => "rate_limited",
        _ if status >= 500 => "server_error",
        _ => "request_rejected",
    }
}

fn safe_error_field(field: Option<&'static str>) -> Option<&'static str> {
    match field {
        Some("q") => Some("q"),
        _ => None,
    }
}

pub fn readiness_failure(service_plane: ServicePlaneRole, store: &'static str, error: &AppError) {
    warn!(
        service_plane = %service_plane.as_str(),
        status = error.status().as_u16(),
        code = error.safe_code(),
        error_kind = error.safe_code(),
        retryable = error.retryable(),
        safe_summary = error.safe_summary(),
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

pub fn rank_metric_ingest(
    org_id: Uuid,
    run_id: Uuid,
    rank: i64,
    metric_count: usize,
    inserted: Option<usize>,
    idempotency_key_present: bool,
    error: Option<&AppError>,
) {
    let outcome = outcome(error);
    let stage = if error.is_some() {
        "rank_metric_insert"
    } else {
        "complete"
    };
    let (status, code, retryable) = error_fields(error);
    info!(
        workflow = "metrics",
        operation = "log_rank_metrics",
        outcome,
        stage,
        status,
        code,
        retryable,
        org_id = %org_id,
        run_id = %run_id,
        rank,
        metric_count,
        inserted = inserted.unwrap_or(0),
        idempotency_key_present,
        duplicate_request = false,
        "rank metric ingestion outcome"
    );
}

pub fn project_mutation_outcome(
    org_id: Uuid,
    operation: &'static str,
    project_id: Option<Uuid>,
    error: Option<&AppError>,
) {
    let outcome = outcome(error);
    let stage = if error.is_some() {
        "project_mutation"
    } else {
        "complete"
    };
    let (status, code, retryable) = error_fields(error);
    info!(
        workflow = "projects",
        operation,
        outcome,
        stage,
        status,
        code,
        retryable,
        org_id = %org_id,
        project_id = %project_id.map(|id| id.to_string()).unwrap_or_default(),
        "project mutation outcome"
    );
}

pub fn run_mutation_outcome(
    org_id: Uuid,
    operation: &'static str,
    project_id: Option<Uuid>,
    run_id: Option<Uuid>,
    idempotency_key_present: bool,
    error: Option<&AppError>,
) {
    let outcome = outcome(error);
    let stage = if error.is_some() {
        "run_mutation"
    } else {
        "complete"
    };
    let (status, code, retryable) = error_fields(error);
    info!(
        workflow = "runs",
        operation,
        outcome,
        stage,
        status,
        code,
        retryable,
        org_id = %org_id,
        project_id = %project_id.map(|id| id.to_string()).unwrap_or_default(),
        run_id = %run_id.map(|id| id.to_string()).unwrap_or_default(),
        idempotency_key_present,
        "run mutation outcome"
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

pub struct ExportOutcome<'a> {
    pub org_id: Uuid,
    pub actor_kind: &'a str,
    pub actor_fingerprint: String,
    pub project_restricted: bool,
    pub format: &'a str,
    pub scope: &'a str,
    pub run_count: usize,
    pub truncated: bool,
    pub response_bytes: Option<usize>,
    pub error: Option<&'a AppError>,
}

pub fn export_outcome(outcome_data: ExportOutcome<'_>) {
    let outcome = outcome(outcome_data.error);
    let (status, code, retryable) = error_fields(outcome_data.error);
    info!(
        workflow = "export",
        operation = "export_data",
        outcome,
        status,
        code,
        retryable,
        org_id = %outcome_data.org_id,
        actor_kind = outcome_data.actor_kind,
        actor_fingerprint = outcome_data.actor_fingerprint,
        project_restricted = outcome_data.project_restricted,
        format = outcome_data.format,
        scope = outcome_data.scope,
        run_count = outcome_data.run_count,
        truncated = outcome_data.truncated,
        response_bytes = outcome_data.response_bytes.unwrap_or(0),
        "export outcome"
    );
}

fn error_fields(error: Option<&AppError>) -> (u16, &'static str, bool) {
    let Some(error) = error else {
        return (200, "ok", false);
    };
    (
        error.status().as_u16(),
        error.safe_code(),
        error.retryable(),
    )
}

fn outcome(error: Option<&AppError>) -> &'static str {
    if error.is_some() {
        "failure"
    } else {
        "success"
    }
}

pub fn safe_request_path(uri: &Uri) -> String {
    safe_path_for_logs(uri.path())
}

pub fn safe_path_for_logs(path: &str) -> String {
    let path = path.split('?').next().unwrap_or(path);
    let path = path.split('#').next().unwrap_or(path);
    let segments = path_segments(path);
    let template =
        known_route_template(&segments).unwrap_or_else(|| fallback_redacted_path(&segments));
    truncate_ascii_for_logs(&template, MAX_LOGGED_PATH_BYTES)
}

pub fn route_plane_for_path(path: &str) -> RoutePlane {
    let segments = path_segments(path);
    if is_platform_route(&segments) {
        RoutePlane::Platform
    } else if is_control_route(&segments) {
        RoutePlane::Control
    } else if is_data_route(&segments) {
        RoutePlane::Data
    } else {
        RoutePlane::Unknown
    }
}

fn path_segments(path: &str) -> Vec<&str> {
    path.trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn known_route_template(segments: &[&str]) -> Option<String> {
    let template: Vec<&str> = match segments {
        [] => vec![],
        ["health"] => vec!["health"],
        ["healthz"] => vec!["healthz"],
        ["readyz"] => vec!["readyz"],
        ["metrics"] => vec!["metrics"],
        ["openapi.json"] => vec!["openapi.json"],
        ["api", "admin", "overview"] => vec!["api", "admin", "overview"],
        ["api", "admin", "data-cells"] => vec!["api", "admin", "data-cells"],
        ["api", "auth", "config"] => vec!["api", "auth", "config"],
        ["api", "auth", "dev", "google"] => vec!["api", "auth", "dev", "google"],
        ["api", "auth", "clerk"] => vec!["api", "auth", "clerk"],
        ["api", "auth", "session"] => vec!["api", "auth", "session"],
        ["api", "auth", "logout"] => vec!["api", "auth", "logout"],
        ["api", "auth", "switch-organization"] => {
            vec!["api", "auth", "switch-organization"]
        }
        ["api", "auth", "device-code", "start"] => {
            vec!["api", "auth", "device-code", "start"]
        }
        ["api", "auth", "device-code", "poll"] => vec!["api", "auth", "device-code", "poll"],
        ["api", "auth", "device-code", "confirm"] => {
            vec!["api", "auth", "device-code", "confirm"]
        }
        ["api", "invitations", "preview"] => vec!["api", "invitations", "preview"],
        ["api", "invitations", "accept"] => vec!["api", "invitations", "accept"],
        ["api", "billing", "status"] => vec!["api", "billing", "status"],
        ["api", "billing", "checkout"] => vec!["api", "billing", "checkout"],
        ["api", "billing", "checkout", "sync"] => vec!["api", "billing", "checkout", "sync"],
        ["api", "billing", "portal"] => vec!["api", "billing", "portal"],
        ["api", "billing", "change-plan"] => vec!["api", "billing", "change-plan"],
        ["api", "billing", "add-seat"] => vec!["api", "billing", "add-seat"],
        ["api", "billing", "cancel"] => vec!["api", "billing", "cancel"],
        ["api", "billing", "storage-overage", "report"] => {
            vec!["api", "billing", "storage-overage", "report"]
        }
        ["api", "billing", "usage-overage", "report"] => {
            vec!["api", "billing", "usage-overage", "report"]
        }
        ["api", "billing", "webhook"] => vec!["api", "billing", "webhook"],
        ["api", "dashboard", "preferences"] => vec!["api", "dashboard", "preferences"],
        ["api", "workspace-views"] => vec!["api", "workspace-views"],
        ["api", "workspace-views", _] => vec!["api", "workspace-views", ":view_id"],
        ["api", "reports"] => vec!["api", "reports"],
        ["api", "reports", "panels"] => vec!["api", "reports", "panels"],
        ["api", "reports", "share", _] => vec!["api", "reports", "share", ":share_token"],
        ["api", "reports", _, "share"] => vec!["api", "reports", ":report_id", "share"],
        ["api", "reports", _, "blocks", _, "refresh"] => {
            vec![
                "api",
                "reports",
                ":report_id",
                "blocks",
                ":block_index",
                "refresh",
            ]
        }
        ["api", "reports", _, "markdown"] => vec!["api", "reports", ":report_id", "markdown"],
        ["api", "reports", _] => vec!["api", "reports", ":report_id"],
        ["api", "users"] => vec!["api", "users"],
        ["api", "orgs"] => vec!["api", "orgs"],
        ["api", "orgs", "current-user"] => vec!["api", "orgs", "current-user"],
        ["api", "orgs", "memberships"] => vec!["api", "orgs", "memberships"],
        ["api", "orgs", "name-availability"] => vec!["api", "orgs", "name-availability"],
        ["api", "orgs", _, "api-keys"] => vec!["api", "orgs", ":org_id", "api-keys"],
        ["api", "orgs", _, "api-keys", _, "revoke"] => {
            vec![
                "api",
                "orgs",
                ":org_id",
                "api-keys",
                ":api_key_id",
                "revoke",
            ]
        }
        ["api", "orgs", _, "seats"] => vec!["api", "orgs", ":org_id", "seats"],
        ["api", "orgs", _, "invitations"] => vec!["api", "orgs", ":org_id", "invitations"],
        ["api", "orgs", _, "invitations", _, "resend"] => {
            vec![
                "api",
                "orgs",
                ":org_id",
                "invitations",
                ":invitation_id",
                "resend",
            ]
        }
        ["api", "orgs", _, "invitations", _, "revoke"] => {
            vec![
                "api",
                "orgs",
                ":org_id",
                "invitations",
                ":invitation_id",
                "revoke",
            ]
        }
        ["api", "orgs", _, "service-accounts", _, "disable"] => {
            vec![
                "api",
                "orgs",
                ":org_id",
                "service-accounts",
                ":service_account_id",
                "disable",
            ]
        }
        ["projects"] => vec!["projects"],
        ["runs"] => vec!["runs"],
        ["runs", _] => vec!["runs", ":run_id"],
        ["runs", _, "metrics"] => vec!["runs", ":run_id", "metrics"],
        ["runs", _, "rank-metrics"] => vec!["runs", ":run_id", "rank-metrics"],
        ["api", "runs", _, "forks"] => vec!["api", "runs", ":run_id", "forks"],
        ["api", "runs", _, "lineage"] => vec!["api", "runs", ":run_id", "lineage"],
        ["api", "runs", _, "rank-metrics", "summary"] => {
            vec!["api", "runs", ":run_id", "rank-metrics", "summary"]
        }
        ["api", "runs", _, "logs"] => vec!["api", "runs", ":run_id", "logs"],
        ["api", "runs", _, "attributes"] => vec!["api", "runs", ":run_id", "attributes"],
        ["api", "runs", _, "objects"] => vec!["api", "runs", ":run_id", "objects"],
        ["api", "runs", _, "artifacts"] => vec!["api", "runs", ":run_id", "artifacts"],
        ["api", "runs", _, "artifacts", "upload"] => {
            vec!["api", "runs", ":run_id", "artifacts", "upload"]
        }
        ["api", "metrics", "series"] => vec!["api", "metrics", "series"],
        ["api", "objects", _, "rows"] => vec!["api", "objects", ":object_id", "rows"],
        ["api", "artifacts", _, "download"] => vec!["api", "artifacts", ":artifact_id", "download"],
        ["api", "overview"] => vec!["api", "overview"],
        ["api", "runs", "summary"] => vec!["api", "runs", "summary"],
        ["api", "runs", "side-by-side"] => vec!["api", "runs", "side-by-side"],
        ["api", "export"] => vec!["api", "export"],
        ["api", "usage"] => vec!["api", "usage"],
        ["api", "usage", "export"] => vec!["api", "usage", "export"],
        ["api", "storage", "clickhouse-connections", "current"] => {
            vec!["api", "storage", "clickhouse-connections", "current"]
        }
        ["api", "storage", "clickhouse-connections", "validate"] => {
            vec!["api", "storage", "clickhouse-connections", "validate"]
        }
        ["api", "storage", "clickhouse-connections"] => {
            vec!["api", "storage", "clickhouse-connections"]
        }
        ["api", "storage", "clickhouse-connections", "rotate-credentials"] => {
            vec![
                "api",
                "storage",
                "clickhouse-connections",
                "rotate-credentials",
            ]
        }
        ["api", "demo", "reset"] => vec!["api", "demo", "reset"],
        ["api", "imports"] => vec!["api", "imports"],
        ["api", "imports", "neptune"] => vec!["api", "imports", "neptune"],
        ["api", "imports", "wandb"] => vec!["api", "imports", "wandb"],
        ["api", "imports", "mlflow"] => vec!["api", "imports", "mlflow"],
        _ => return None,
    };
    Some(join_path(&template))
}

fn is_platform_route(segments: &[&str]) -> bool {
    matches!(
        segments,
        ["health"]
            | ["healthz"]
            | ["readyz"]
            | ["metrics"]
            | ["openapi.json"]
            | ["api", "auth", "config"]
    )
}

fn is_control_route(segments: &[&str]) -> bool {
    matches!(
        segments,
        ["api", "auth", "dev", "google"]
            | ["api", "auth", "clerk"]
            | ["api", "auth", "session"]
            | ["api", "auth", "logout"]
            | ["api", "auth", "switch-organization"]
            | ["api", "auth", "device-code", "start"]
            | ["api", "auth", "device-code", "poll"]
            | ["api", "auth", "device-code", "confirm"]
            | ["api", "admin", ..]
            | ["api", "invitations", ..]
            | ["api", "billing", ..]
            | ["api", "dashboard", "preferences"]
            | ["api", "workspace-views", ..]
            | ["api", "reports", ..]
            | ["api", "users"]
            | ["api", "orgs", ..]
    ) && !is_platform_route(segments)
}

fn is_data_route(segments: &[&str]) -> bool {
    matches!(
        segments,
        ["projects"]
            | ["runs", ..]
            | ["api", "runs", ..]
            | ["api", "metrics", "series"]
            | ["api", "objects", ..]
            | ["api", "artifacts", ..]
            | ["api", "overview"]
            | ["api", "export"]
            | ["api", "usage", ..]
            | ["api", "storage", "clickhouse-connections", ..]
            | ["api", "demo", "reset"]
            | ["api", "imports", ..]
    )
}

fn fallback_redacted_path(segments: &[&str]) -> String {
    if segments.is_empty() {
        return "/".to_string();
    }
    let redacted = segments
        .iter()
        .map(|segment| redact_unknown_segment(segment))
        .collect::<Vec<_>>();
    join_path(&redacted)
}

fn redact_unknown_segment(segment: &str) -> &str {
    if Uuid::parse_str(segment).is_ok() {
        return ":id";
    }
    if segment.len() > 16
        || segment.contains('=')
        || segment.contains('%')
        || segment.contains('@')
        || segment.contains(':')
        || is_secret_like_log_token(segment)
    {
        return ":token";
    }
    segment
}

fn join_path(parts: &[&str]) -> String {
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

pub fn request_id_for_logs(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("x-request-id")?.to_str().ok()?;
    normalize_request_id(value)
}

pub fn normalize_request_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_LOGGED_HEADER_BYTES {
        return None;
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return None;
    }
    if is_secret_like_log_token(trimmed) {
        return None;
    }
    Some(trimmed.to_string())
}

fn is_secret_like_log_token(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("bearer:")
        || lower.starts_with("bearer.")
        || lower.starts_with("instantml_")
        || lower.starts_with("instantml_live_")
        || lower.starts_with("instantml_test_")
        || lower.starts_with("sk-live-")
        || lower.starts_with("sk-test-")
        || lower.starts_with("sk_live_")
        || lower.starts_with("sk_test_")
        || lower.starts_with("rk_live_")
        || lower.starts_with("rk_test_")
        || lower.starts_with("whsec_")
        || lower.starts_with("gho_")
        || lower.starts_with("ghp_")
        || lower.starts_with("github_pat_")
        || lower.starts_with("xoxb-")
        || lower.starts_with("xoxp-")
}

pub fn cf_ray_for_logs(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("cf-ray")?.to_str().ok()?.trim();
    normalize_cf_ray(value)
}

pub fn normalize_cf_ray(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 64 || is_secret_like_log_token(trimmed) {
        return None;
    }
    let (ray, colo) = trimmed
        .split_once('-')
        .map_or((trimmed, None), |(ray, colo)| (ray, Some(colo)));
    if !(16..=32).contains(&ray.len()) || !ray.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    if let Some(colo) = colo {
        if colo.is_empty()
            || colo.len() > 8
            || !colo.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return None;
        }
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
    fn safe_request_path_drops_query_and_templates_dynamic_segments() {
        let uri: Uri = "/api/runs/summary?q=secret&limit=10".parse().unwrap();

        assert_eq!(safe_request_path(&uri), "/api/runs/summary");

        let uri: Uri = "/api/admin/overview?email=customer@example.com"
            .parse()
            .unwrap();
        assert_eq!(safe_request_path(&uri), "/api/admin/overview");

        let uri: Uri = "/runs/018faabb-0000-7000-9000-000000000001/metrics?key=secret"
            .parse()
            .unwrap();
        assert_eq!(safe_request_path(&uri), "/runs/:run_id/metrics");

        let uri: Uri = "/api/reports/share/public-secret-token".parse().unwrap();
        assert_eq!(safe_request_path(&uri), "/api/reports/share/:share_token");

        let uri: Uri = "/api/reports/report-1/blocks/2/refresh".parse().unwrap();
        assert_eq!(
            safe_request_path(&uri),
            "/api/reports/:report_id/blocks/:block_index/refresh"
        );
    }

    #[test]
    fn fallback_safe_path_redacts_token_like_unknown_segments() {
        assert_eq!(
            safe_path_for_logs("/api/unknown/customer@example.com?x=secret"),
            "/api/unknown/:token"
        );
        assert_eq!(
            safe_path_for_logs("/api/unknown/018faabb-0000-7000-9000-000000000001"),
            "/api/unknown/:id"
        );
        assert_eq!(
            safe_path_for_logs("/api/unknown/short-static"),
            "/api/unknown/short-static"
        );
        assert_eq!(
            safe_path_for_logs("/api/billing/cs_test_secret_token_123"),
            "/api/billing/:token"
        );
        assert_eq!(
            safe_path_for_logs("/api/unknown/sk_test_secret"),
            "/api/unknown/:token"
        );
        assert_eq!(
            safe_path_for_logs("/api/unknown/instantml_abc123"),
            "/api/unknown/:token"
        );
        assert_eq!(
            safe_path_for_logs("/api/unknown/ghp_abc123"),
            "/api/unknown/:token"
        );
    }

    #[test]
    fn route_plane_classification_is_segment_aware() {
        assert_eq!(route_plane_for_path("/readyz"), RoutePlane::Platform);
        assert_eq!(
            route_plane_for_path("/api/auth/config"),
            RoutePlane::Platform
        );
        assert_eq!(
            route_plane_for_path("/api/auth/configuration"),
            RoutePlane::Unknown
        );
        assert_eq!(route_plane_for_path("/api/auth/clerk"), RoutePlane::Control);
        assert_eq!(
            route_plane_for_path("/api/admin/overview"),
            RoutePlane::Control
        );
        assert_eq!(
            route_plane_for_path("/api/admin/data-cells"),
            RoutePlane::Control
        );
        assert_eq!(
            route_plane_for_path("/api/billing/status"),
            RoutePlane::Control
        );
        assert_eq!(
            route_plane_for_path("/api/reports/share/sensitive-token"),
            RoutePlane::Control
        );
        assert_eq!(
            route_plane_for_path("/runs/run-1/metrics"),
            RoutePlane::Data
        );
        assert_eq!(
            route_plane_for_path("/api/runs/run-1/artifacts/upload"),
            RoutePlane::Data
        );
        assert_eq!(
            route_plane_for_path("/api/storage/clickhouse-connections/validate"),
            RoutePlane::Data
        );
        assert_eq!(RoutePlane::Control.tag(), "[Control]");
        assert_eq!(RoutePlane::Data.as_str(), "data");
    }

    #[test]
    fn normalize_request_id_accepts_only_safe_tokens() {
        assert_eq!(
            normalize_request_id("web_018faabb-0000-7000-9000-000000000001"),
            Some("web_018faabb-0000-7000-9000-000000000001".to_string())
        );
        assert_eq!(normalize_request_id("user@example.com"), None);
        assert_eq!(normalize_request_id("Bearer abc"), None);
        assert_eq!(normalize_request_id("Bearer:abc123"), None);
        assert_eq!(normalize_request_id("instantml_abc123"), None);
        assert_eq!(normalize_request_id("instantml_live_abc123"), None);
        assert_eq!(normalize_request_id("instantml_test_abc123"), None);
        assert_eq!(normalize_request_id("sk-test-abc123"), None);
        assert_eq!(normalize_request_id("sk_test_abc123"), None);
        assert_eq!(normalize_request_id("sk_live_abc123"), None);
        assert_eq!(normalize_request_id("rk_test_abc123"), None);
        assert_eq!(normalize_request_id("whsec_abc123"), None);
        assert_eq!(normalize_request_id("gho_abc123"), None);
        assert_eq!(normalize_request_id("bad\nvalue"), None);
        assert_eq!(normalize_request_id(&"a".repeat(129)), None);
    }

    #[test]
    fn cf_ray_for_logs_accepts_only_ray_shaped_values() {
        assert_eq!(
            normalize_cf_ray("8a1b2c3d4e5f6789-SJC"),
            Some("8a1b2c3d4e5f6789-SJC".to_string())
        );
        assert_eq!(
            normalize_cf_ray("8a1b2c3d4e5f67898a1b2c3d4e5f6789"),
            Some("8a1b2c3d4e5f67898a1b2c3d4e5f6789".to_string())
        );
        assert_eq!(normalize_cf_ray("user@example.com"), None);
        assert_eq!(normalize_cf_ray("instantml_secret"), None);
        assert_eq!(normalize_cf_ray("not-a-ray"), None);
        assert_eq!(normalize_cf_ray("8a1b2c3d4e5f6789-too-long-colo"), None);

        let mut headers = HeaderMap::new();
        headers.insert("cf-ray", HeaderValue::from_static("8a1b2c3d4e5f6789-SJC"));
        assert_eq!(
            cf_ray_for_logs(&headers),
            Some("8a1b2c3d4e5f6789-SJC".to_string())
        );
        headers.insert("cf-ray", HeaderValue::from_static("instantml_secret"));
        assert_eq!(cf_ray_for_logs(&headers), None);
    }

    #[test]
    fn request_id_for_logs_uses_strict_request_id_rules() {
        let mut headers = HeaderMap::new();
        headers.insert("x-request-id", HeaderValue::from_static("req_123"));
        assert_eq!(request_id_for_logs(&headers), Some("req_123".to_string()));
        headers.insert("x-request-id", HeaderValue::from_static("user@example.com"));
        assert_eq!(request_id_for_logs(&headers), None);
    }

    #[test]
    fn error_fields_are_static_and_safe() {
        assert_eq!(safe_error_code(500, None), "internal_server_error");
        assert_eq!(safe_error_code(400, None), "request_rejected");
        assert!(
            error_fields(Some(&AppError::with_code(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
                "too many requests"
            )))
            .2
        );
        assert_eq!(
            safe_error_summary(400, "run_search_invalid"),
            "search_validation_failed"
        );
        assert_eq!(
            safe_error_summary(401, "request_rejected"),
            "authentication_required"
        );
        assert_eq!(safe_error_field(Some("q")), Some("q"));
        assert_eq!(safe_error_field(Some("metadata.secret")), None);
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
