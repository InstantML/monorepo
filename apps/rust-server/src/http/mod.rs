use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;
use tower::ServiceBuilder;
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowOrigin, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use url::Url;
use uuid::Uuid;

use crate::{
    artifact_store::LocalArtifactStore,
    config::AppConfig,
    domain::{
        ClerkAuthRequest, CreateApiKeyRequest, CreateArtifactRequest, CreateAttributesRequest,
        CreateConsoleLogsRequest, CreateObjectRequest, CreateOrganizationRequest,
        CreateProjectRequest, CreateRunRequest, CreateUserRequest, DevGoogleAuthRequest,
        LogMetricsRequest, RequestContext, ReserveSeatRequest, SessionContext, UpdateRunRequest,
        UploadArtifactRequest,
    },
    errors::{AppError, AppResult},
    store,
};

mod handlers;

use handlers::*;

const SESSION_COOKIE: &str = "instantml_session";

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
                .layer(TraceLayer::new_for_http())
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
        .route("/metrics", get(metrics))
        .route("/openapi.json", get(openapi_json))
        .route("/api/auth/config", get(auth_config))
}

fn control_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/auth/dev/google", post(auth_dev_google))
        .route("/api/auth/clerk", post(auth_clerk))
        .route("/api/auth/session", get(auth_session))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/users", post(create_user).get(list_users))
        .route("/api/orgs", post(create_org).get(list_orgs))
        .route("/api/orgs/name-availability", get(org_name_availability))
        .route(
            "/api/orgs/:org_id/api-keys",
            post(create_api_key).get(list_api_keys),
        )
        .route("/api/orgs/:org_id/seats", post(reserve_seat))
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
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::OPTIONS])
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
