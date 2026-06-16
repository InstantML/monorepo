use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    http::{HeaderName, Method},
    middleware,
    routing::{get, patch, post, put},
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
pub(crate) mod rate_limit;

use handlers::{
    abort_artifact_upload, accept_invitation, admin_overview, append_import_chunk,
    artifact_version_lineage, auth_clerk, auth_config, auth_dev_google, auth_logout, auth_session,
    auth_switch_organization, billing_add_seat, billing_cancel, billing_change_plan,
    billing_checkout, billing_checkout_sync, billing_portal, billing_report_storage_overage,
    billing_report_usage_overage, billing_status, billing_webhook, cancel_import_job,
    commit_import_job, complete_artifact_upload, create_api_key, create_artifact,
    create_artifact_input_edge, create_attributes, create_current_user_org,
    create_customer_clickhouse_connection, create_import_job, create_invitation, create_object,
    create_org, create_project, create_report, create_run, create_user, create_workspace_view,
    customer_clickhouse_connection_status, delete_artifact_alias, delete_artifact_version,
    delete_report, delete_workspace_view, device_code_confirm, device_code_poll, device_code_start,
    disable_service_account, download_artifact, download_artifact_entry, export_data,
    export_report_markdown, export_workspace_view, fork_run, get_artifact_collection,
    get_artifact_version, get_dashboard_preferences, get_import_job, get_metrics, get_report,
    get_report_by_share_token, get_run, get_run_lineage, get_workspace_view, health, import_mlflow,
    import_neptune, import_wandb, import_workspace_view, initiate_artifact_upload, list_api_keys,
    list_artifact_collection_versions, list_artifact_collections, list_artifact_manifest,
    list_artifacts, list_attributes, list_console_logs, list_imports, list_invitations,
    list_object_rows, list_objects, list_org_memberships, list_org_panels, list_orgs,
    list_projects, list_reports, list_runs, list_seats, list_users, list_workspace_views,
    log_console_logs, log_metrics, log_rank_metrics, metrics_handler, metrics_series, not_found,
    openapi_json, org_name_availability, overview, preview_invitation, rank_metrics_summary,
    readyz, renew_artifact_upload, resend_invitation, reserve_seat, reset_demo,
    resolve_artifact_version, revoke_api_key, revoke_invitation,
    rotate_customer_clickhouse_credentials, rotate_report_share_token, run_artifact_edges,
    runs_summary, set_artifact_alias, side_by_side, update_artifact_retention,
    update_dashboard_preferences, update_report, update_run, update_workspace_view,
    upload_artifact, usage_export, usage_summary, validate_customer_clickhouse_connection,
    workspace_view_data,
};

const SESSION_COOKIE: &str = "instantml_session";
const SESSION_COOKIE_MAX_AGE_SECS: u64 = 60 * 60 * 24 * 30;

#[derive(Clone)]
pub struct AppState {
    pub store: store::Store,
    pub config: AppConfig,
    pub rate_limiter: rate_limit::RateLimiter,
}

impl AppState {
    pub fn new(store: store::Store, config: AppConfig) -> Self {
        Self {
            store,
            config,
            rate_limiter: rate_limit::RateLimiter::new(),
        }
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
        app = app.merge(
            data_routes(max_upload).route_layer(middleware::from_fn_with_state(
                shared.clone(),
                rate_limit::data_plane_rate_limit,
            )),
        );
    }

    app.fallback(not_found)
        .with_state(shared)
        .layer(
            ServiceBuilder::new()
                .layer(middleware::from_fn(
                    observability::normalize_request_id_header,
                ))
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
        .route("/api/admin/overview", get(admin_overview))
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
        .route(
            "/api/billing/usage-overage/report",
            post(billing_report_usage_overage),
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
        .route("/api/workspace-views/import", post(import_workspace_view))
        .route(
            "/api/workspace-views/:view_id/export",
            get(export_workspace_view),
        )
        .route(
            "/api/workspace-views/:view_id",
            get(get_workspace_view)
                .put(update_workspace_view)
                .delete(delete_workspace_view),
        )
        .route("/api/users", post(create_user).get(list_users))
        .route("/api/orgs", post(create_org).get(list_orgs))
        .route("/api/orgs/current-user", post(create_current_user_org))
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
        .route("/api/runs/:run_id/forks", post(fork_run))
        .route("/api/runs/:run_id/lineage", get(get_run_lineage))
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
        .route("/api/workspace-view-data", post(workspace_view_data))
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
        .route("/api/artifact-collections", get(list_artifact_collections))
        .route(
            "/api/artifact-collections/:collection_id",
            get(get_artifact_collection),
        )
        .route(
            "/api/artifact-collections/:collection_id/versions",
            get(list_artifact_collection_versions),
        )
        .route(
            "/api/artifact-collections/:collection_id/aliases/:alias",
            put(set_artifact_alias).delete(delete_artifact_alias),
        )
        .route(
            "/api/artifact-versions/resolve",
            get(resolve_artifact_version),
        )
        .route(
            "/api/artifact-versions/:version_id",
            get(get_artifact_version).delete(delete_artifact_version),
        )
        .route(
            "/api/artifact-versions/:version_id/manifest",
            get(list_artifact_manifest),
        )
        .route(
            "/api/artifact-versions/:version_id/lineage",
            get(artifact_version_lineage),
        )
        .route(
            "/api/artifact-versions/:version_id/retention",
            patch(update_artifact_retention),
        )
        .route(
            "/api/artifact-entries/:entry_id/download",
            get(download_artifact_entry),
        )
        .route(
            "/api/runs/:run_id/artifact-uploads",
            post(initiate_artifact_upload),
        )
        .route(
            "/api/artifact-uploads/:upload_session_id/renew",
            post(renew_artifact_upload),
        )
        .route(
            "/api/artifact-uploads/:upload_session_id/complete",
            post(complete_artifact_upload).layer(DefaultBodyLimit::max(max_upload)),
        )
        .route(
            "/api/artifact-uploads/:upload_session_id/abort",
            post(abort_artifact_upload),
        )
        .route(
            "/api/runs/:run_id/artifact-inputs",
            post(create_artifact_input_edge),
        )
        .route("/api/runs/:run_id/artifact-edges", get(run_artifact_edges))
        .route("/api/reports", get(list_reports).post(create_report))
        .route("/api/reports/panels", get(list_org_panels))
        .route(
            "/api/reports/share/:share_token",
            get(get_report_by_share_token),
        )
        .route(
            "/api/reports/:report_id",
            get(get_report).patch(update_report).delete(delete_report),
        )
        .route(
            "/api/reports/:report_id/share",
            post(rotate_report_share_token),
        )
        .route(
            "/api/reports/:report_id/markdown",
            get(export_report_markdown),
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
        .route("/api/imports/jobs", post(create_import_job))
        .route("/api/imports/jobs/:import_id", get(get_import_job))
        .route(
            "/api/imports/jobs/:import_id/chunks",
            post(append_import_chunk).layer(DefaultBodyLimit::max(max_upload)),
        )
        .route(
            "/api/imports/jobs/:import_id/commit",
            post(commit_import_job),
        )
        .route(
            "/api/imports/jobs/:import_id/cancel",
            post(cancel_import_job),
        )
        .route("/api/imports/neptune", post(import_neptune))
        .route("/api/imports/wandb", post(import_wandb))
        .route("/api/imports/mlflow", post(import_mlflow))
}

fn cors_layer(config: &AppConfig) -> CorsLayer {
    cors_layer_for_origins(config.allowed_frontend_origins.clone())
}

fn cors_layer_for_origins(allowed: Vec<String>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin_allowed_for_cors(origin, &allowed)
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::ACCEPT,
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("idempotency-key"),
            HeaderName::from_static("x-instantml-bootstrap-token"),
            HeaderName::from_static("x-request-id"),
        ])
        .expose_headers([HeaderName::from_static("x-request-id")])
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

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request, routing::get};
    use tower::Service;

    use super::*;

    async fn ok() -> &'static str {
        "ok"
    }

    #[tokio::test]
    async fn cors_allows_and_exposes_request_id_headers() {
        let app = Router::new().route("/api/auth/config", get(ok)).layer(
            ServiceBuilder::new()
                .layer(middleware::from_fn(
                    observability::normalize_request_id_header,
                ))
                .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
                .layer(PropagateRequestIdLayer::x_request_id())
                .layer(cors_layer_for_origins(vec![
                    "http://127.0.0.1:3000".to_string()
                ])),
        );

        let mut preflight_app = app.clone();
        let preflight = preflight_app
            .call(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/auth/config")
                    .header(header::ORIGIN, "http://127.0.0.1:3000")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "DELETE")
                    .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "x-request-id")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(preflight.status().is_success());
        assert!(preflight
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .contains("x-request-id"));

        let mut request_app = app;
        let response = request_app
            .call(
                Request::builder()
                    .uri("/api/auth/config")
                    .header(header::ORIGIN, "http://127.0.0.1:3000")
                    .header("x-request-id", "user@example.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_EXPOSE_HEADERS)
                .and_then(|value| value.to_str().ok()),
            Some("x-request-id")
        );
        let response_request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert_ne!(response_request_id, "user@example.com");
        assert!(observability::normalize_request_id(response_request_id).is_some());
    }
}
