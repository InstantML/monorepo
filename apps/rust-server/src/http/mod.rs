use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    http::{HeaderName, Method},
    routing::{get, post},
    Router,
};
use std::time::Duration;
use tower::ServiceBuilder;
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowOrigin, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use url::Url;

use axum::http::header;
use axum::http::HeaderValue;

use crate::{config::AppConfig, store};

pub(crate) mod handlers;
pub(crate) mod observability;
pub mod openapi;

use handlers::{
    accept_invitation, auth_clerk, auth_config, auth_dev_google, auth_logout, auth_session,
    auth_switch_organization, billing_add_seat, billing_cancel, billing_change_plan,
    billing_checkout, billing_checkout_sync, billing_portal, billing_report_storage_overage,
    billing_status, billing_webhook, create_api_key, create_artifact, create_attributes,
    create_customer_clickhouse_connection, create_invitation, create_object, create_org,
    create_project, create_run, create_user, create_workspace_view,
    customer_clickhouse_connection_status, device_code_confirm, device_code_poll,
    device_code_start, disable_service_account, download_artifact, export_data,
    get_dashboard_preferences, get_metrics, get_run, get_workspace_view, health, import_mlflow,
    import_neptune, import_wandb, list_api_keys, list_artifacts, list_attributes,
    list_console_logs, list_imports, list_invitations, list_object_rows, list_objects,
    list_org_memberships, list_orgs, list_projects, list_runs, list_seats, list_users,
    list_workspace_views, log_console_logs, log_metrics, log_rank_metrics, metrics_handler,
    metrics_series, not_found, openapi_json, org_name_availability, overview, preview_invitation,
    rank_metrics_summary, readyz, resend_invitation, reserve_seat, reset_demo, revoke_api_key,
    revoke_invitation, rotate_customer_clickhouse_credentials, runs_summary, side_by_side,
    update_dashboard_preferences, update_run, update_workspace_view, upload_artifact, usage_export,
    usage_summary, validate_customer_clickhouse_connection,
};

const SESSION_COOKIE: &str = "instantml_session";
const SESSION_COOKIE_MAX_AGE_SECS: u64 = 60 * 60 * 24 * 30;

#[derive(Clone)]
pub struct AppState {
    pub store: store::Store,
    pub config: AppConfig,
}

impl AppState {
    pub fn new(store: store::Store, config: AppConfig) -> Self {
        Self { store, config }
    }
}

pub fn router(state: AppState) -> Router {
    let max_body = state.config.max_body_bytes;
    let max_upload = state.config.max_upload_body_bytes;
    let request_timeout = state.config.request_timeout;
    let slow_request_threshold = state.config.slow_request_threshold;
    let service_plane = state.config.service_plane;
    let shared = Arc::new(state);
    let cors = cors_layer(&shared.config);

    let mut app = platform_routes();
    if service_plane.includes_control() {
        app = app.merge(control_routes());
    }
    if service_plane.includes_data() {
        app = app.merge(data_routes(max_upload));
    }

    app.fallback(not_found)
        .with_state(shared)
        .layer(
            ServiceBuilder::new()
                .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
                .layer(PropagateRequestIdLayer::x_request_id())
                .layer(
                    TraceLayer::new_for_http()
                        .make_span_with(move |request: &axum::http::Request<_>| {
                            observability::request_span(request, service_plane)
                        })
                        .on_response(
                            move |response: &axum::http::Response<_>,
                                  latency: Duration,
                                  span: &tracing::Span| {
                                observability::on_response(
                                    response,
                                    latency,
                                    span,
                                    slow_request_threshold,
                                );
                            },
                        )
                        .on_failure(
                            move |failure_class: tower_http::classify::ServerErrorsFailureClass,
                                  latency: Duration,
                                  span: &tracing::Span| {
                                observability::on_failure(&failure_class, latency, span);
                            },
                        ),
                )
                .layer(cors)
                .layer(CompressionLayer::new())
                .layer(TimeoutLayer::new(request_timeout)),
        )
        .layer(DefaultBodyLimit::max(max_body))
}

fn platform_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/health", get(health))
        .route("/healthz", get(health))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics_handler))
        .route("/openapi.json", get(openapi_json))
        .route("/api/auth/config", get(auth_config))
}

fn control_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/auth/dev/google", post(auth_dev_google))
        .route("/api/auth/clerk", post(auth_clerk))
        .route("/api/auth/session", get(auth_session))
        .route("/api/auth/logout", post(auth_logout))
        .route(
            "/api/auth/switch-organization",
            post(auth_switch_organization),
        )
        .route("/api/auth/device-code/start", post(device_code_start))
        .route("/api/auth/device-code/poll", post(device_code_poll))
        .route("/api/auth/device-code/confirm", post(device_code_confirm))
        .route("/api/invitations/preview", post(preview_invitation))
        .route("/api/invitations/accept", post(accept_invitation))
        .route("/api/billing/status", get(billing_status))
        .route("/api/billing/checkout", post(billing_checkout))
        .route("/api/billing/checkout/sync", post(billing_checkout_sync))
        .route("/api/billing/portal", post(billing_portal))
        .route("/api/billing/change-plan", post(billing_change_plan))
        .route("/api/billing/add-seat", post(billing_add_seat))
        .route("/api/billing/cancel", post(billing_cancel))
        .route(
            "/api/billing/storage-overage/report",
            post(billing_report_storage_overage),
        )
        .route("/api/billing/webhook", post(billing_webhook))
        .route(
            "/api/dashboard/preferences",
            get(get_dashboard_preferences).put(update_dashboard_preferences),
        )
        .route(
            "/api/workspace-views",
            get(list_workspace_views).post(create_workspace_view),
        )
        .route(
            "/api/workspace-views/:view_id",
            get(get_workspace_view).put(update_workspace_view),
        )
        .route("/api/users", post(create_user).get(list_users))
        .route("/api/orgs", post(create_org).get(list_orgs))
        .route("/api/orgs/memberships", get(list_org_memberships))
        .route("/api/orgs/name-availability", get(org_name_availability))
        .route(
            "/api/orgs/:org_id/api-keys",
            post(create_api_key).get(list_api_keys),
        )
        .route(
            "/api/orgs/:org_id/seats",
            post(reserve_seat).get(list_seats),
        )
        .route(
            "/api/orgs/:org_id/invitations",
            post(create_invitation).get(list_invitations),
        )
        .route(
            "/api/orgs/:org_id/invitations/:invitation_id/resend",
            post(resend_invitation),
        )
        .route(
            "/api/orgs/:org_id/invitations/:invitation_id/revoke",
            post(revoke_invitation),
        )
        .route(
            "/api/orgs/:org_id/api-keys/:api_key_id/revoke",
            post(revoke_api_key),
        )
        .route(
            "/api/orgs/:org_id/service-accounts/:service_account_id/disable",
            post(disable_service_account),
        )
}

fn data_routes(max_upload: usize) -> Router<Arc<AppState>> {
    Router::new()
        .route("/projects", post(create_project).get(list_projects))
        .route("/runs", post(create_run).get(list_runs))
        .route("/runs/:run_id", get(get_run).patch(update_run))
        .route("/runs/:run_id/metrics", post(log_metrics).get(get_metrics))
        .route("/runs/:run_id/rank-metrics", post(log_rank_metrics))
        .route(
            "/api/runs/:run_id/rank-metrics/summary",
            get(rank_metrics_summary),
        )
        .route("/api/metrics/series", post(metrics_series))
        .route(
            "/api/runs/:run_id/logs",
            post(log_console_logs).get(list_console_logs),
        )
        .route("/api/overview", get(overview))
        .route("/api/runs/summary", get(runs_summary))
        .route("/api/runs/side-by-side", get(side_by_side))
        .route(
            "/api/runs/:run_id/attributes",
            post(create_attributes).get(list_attributes),
        )
        .route(
            "/api/runs/:run_id/objects",
            post(create_object).get(list_objects),
        )
        .route("/api/objects/:object_id/rows", get(list_object_rows))
        .route(
            "/api/runs/:run_id/artifacts",
            post(create_artifact).get(list_artifacts),
        )
        .route(
            "/api/runs/:run_id/artifacts/upload",
            post(upload_artifact).layer(DefaultBodyLimit::max(max_upload)),
        )
        .route(
            "/api/artifacts/:artifact_id/download",
            get(download_artifact),
        )
        .route("/api/export", get(export_data))
        .route("/api/usage", get(usage_summary))
        .route("/api/usage/export", get(usage_export))
        .route(
            "/api/storage/clickhouse-connections/current",
            get(customer_clickhouse_connection_status),
        )
        .route(
            "/api/storage/clickhouse-connections/validate",
            post(validate_customer_clickhouse_connection),
        )
        .route(
            "/api/storage/clickhouse-connections",
            post(create_customer_clickhouse_connection),
        )
        .route(
            "/api/storage/clickhouse-connections/rotate-credentials",
            post(rotate_customer_clickhouse_credentials),
        )
        .route("/api/demo/reset", post(reset_demo))
        .route("/api/imports", get(list_imports))
        .route("/api/imports/neptune", post(import_neptune))
        .route("/api/imports/wandb", post(import_wandb))
        .route("/api/imports/mlflow", post(import_mlflow))
}

fn cors_layer(config: &AppConfig) -> CorsLayer {
    let allowed = config.allowed_frontend_origins.clone();
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin_allowed_for_cors(origin, &allowed)
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::ACCEPT,
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("idempotency-key"),
            HeaderName::from_static("x-instantml-bootstrap-token"),
        ])
        .allow_credentials(true)
}

fn origin_allowed_for_cors(origin: &HeaderValue, allowed: &[String]) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let origin = origin.trim_end_matches('/');
    if allowed.iter().any(|candidate| candidate == origin) {
        return true;
    }
    Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1"))
}
