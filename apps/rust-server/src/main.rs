use std::{net::SocketAddr, process::ExitCode, time::Duration};

use instantml_rust_server::{
    config::{AppConfig, ClickHouseProvisioner, ServicePlaneRole},
    control_db::ControlDb,
    control_store::ControlStore,
    domain::{DevGoogleAuthRequest, RequestContext},
    http::AppState,
    metric_store, store, telemetry,
};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {}", error.message());
            ExitCode::FAILURE
        }
    }
}

async fn run() -> instantml_rust_server::AppResult<()> {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "serve".to_string());
    let config = AppConfig::from_env()?;
    telemetry::init(&config.log_format);
    match command.as_str() {
        "serve" => serve(config).await,
        "all" => serve(config).await,
        "migrate" => migrate_all(config).await,
        "migrate-control" => migrate_control(config).await,
        "worker" => worker(config).await,
        "seed-demo" => seed_demo(config).await,
        "backfill-control" => backfill_control(config).await,
        "emit-openapi" => emit_openapi(),
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => Err(instantml_rust_server::AppError::config(format!(
            "unknown command {other}; expected serve, worker, migrate, migrate-control, seed-demo, backfill-control, emit-openapi, or all"
        ))),
    }
}

/// Print the utoipa-generated OpenAPI spec to stdout. Used by the TypeScript
/// codegen pipeline (`npm run codegen:api`) — no running server required.
fn emit_openapi() -> instantml_rust_server::AppResult<()> {
    use instantml_rust_server::http::openapi::ApiDoc;
    use utoipa::OpenApi as _;
    let spec = ApiDoc::openapi();
    let json = serde_json::to_string_pretty(&spec).map_err(|err| {
        instantml_rust_server::AppError::internal(format!("serialize openapi: {err}"))
    })?;
    println!("{json}");
    Ok(())
}

async fn serve(config: AppConfig) -> instantml_rust_server::AppResult<()> {
    tracing::info!(
        service_plane = %config.service_plane.as_str(),
        bind_addr = %config.bind_addr,
        auth_mode = ?config.auth_mode,
        artifact_backend = ?config.artifact_backend,
        hosted_clickhouse_enabled = config.hosted_clickhouse.is_some(),
        slow_request_ms = (config
            .slow_request_threshold
            .as_millis()
            .min(u128::from(u64::MAX)) as u64),
        "rust server starting"
    );
    let metrics = metric_store::connect(&config)?;
    if should_migrate_primary_metric_store(&config) {
        metric_store::migrate(&metrics).await?;
    }
    let control_store = ControlStore::connect(&config)?;
    if let Some(control_store) = &control_store {
        control_store.migrate().await?;
    }
    let control_db = ControlDb::connect(config.control_database_url.as_deref()).await?;
    if let Some(control_db) = &control_db {
        control_db.migrate().await?;
    }
    let store = connect_store_with_retry(
        metrics.clone(),
        control_store,
        control_db,
        config.hosted_clickhouse.clone(),
        config.byoc_clickhouse.clone(),
    )
    .await?;
    if config.control_database_url.is_some() {
        // The Postgres control plane is authoritative for writes, but reads
        // still come from a per-instance in-memory projection that is only
        // rebuilt at startup (there is no cross-instance refresh yet). Running
        // more than one control instance would therefore serve stale auth/billing
        // reads, so the control service must stay single-instance (the deploy
        // tool pins this unless INSTANTML_CLOUD_RUN_UNSAFE_CONTROL_MULTI_INSTANCE
        // is set) until reads move to SQL.
        tracing::warn!(
            "control plane on Postgres uses a startup-only in-memory read projection; \
             run single-instance until reads are served from Postgres"
        );
    }
    // Data plane: poll the control table out-of-band so the request hot path
    // makes zero control-plane queries. See PR #32 for the burst-load failure
    // mode that motivated this change.
    let background_refresh = if config.service_plane.runs_background_control_refresh() {
        store.spawn_control_refresh_task()
    } else {
        None
    };
    let bind_addr = config.bind_addr;
    let service_plane = config.service_plane;
    let app = instantml_rust_server::http::router(AppState::new(store, config));
    let listener = TcpListener::bind(bind_addr).await?;
    tracing::info!(
        %bind_addr,
        service_plane = %service_plane.as_str(),
        "Training Observability Rust server listening"
    );
    let result = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .map_err(|error| instantml_rust_server::AppError::internal(format!("server failed: {error}")));
    if let Some(handle) = background_refresh {
        handle.abort();
    }
    result
}

async fn connect_store_with_retry(
    metrics: metric_store::MetricStore,
    control_store: Option<ControlStore>,
    control_db: Option<ControlDb>,
    hosted_clickhouse: Option<instantml_rust_server::config::HostedClickHouseConfig>,
    byoc_clickhouse: instantml_rust_server::config::ByocClickHouseConfig,
) -> instantml_rust_server::AppResult<store::Store> {
    let retry_delays = [
        Duration::from_secs(1),
        Duration::from_secs(2),
        Duration::from_secs(4),
    ];
    let max_attempts = retry_delays.len() + 1;
    for attempt in 1..=max_attempts {
        match store::Store::connect(
            metrics.clone(),
            control_store.clone(),
            control_db.clone(),
            hosted_clickhouse.clone(),
            byoc_clickhouse.clone(),
        )
        .await
        {
            Ok(store) => return Ok(store),
            Err(error) if attempt < max_attempts => {
                let delay = retry_delays[attempt - 1];
                tracing::warn!(
                    workflow = "startup",
                    operation = "store_connect",
                    outcome = "failure",
                    status = error.status().as_u16(),
                    code = error.safe_code(),
                    error_kind = error.safe_code(),
                    retryable = error.retryable(),
                    safe_summary = error.safe_summary(),
                    attempt,
                    max_attempts,
                    delay_ms = delay.as_millis() as u64,
                    "store startup projection rebuild failed; retrying"
                );
                tokio::time::sleep(delay).await;
            }
            Err(error) => {
                tracing::error!(
                    workflow = "startup",
                    operation = "store_connect",
                    outcome = "failure",
                    status = error.status().as_u16(),
                    code = error.safe_code(),
                    error_kind = error.safe_code(),
                    retryable = error.retryable(),
                    safe_summary = error.safe_summary(),
                    attempt,
                    max_attempts,
                    "store startup projection rebuild failed after retries"
                );
                return Err(error);
            }
        }
    }
    Err(instantml_rust_server::AppError::internal(
        "store startup projection rebuild failed",
    ))
}

async fn migrate_all(config: AppConfig) -> instantml_rust_server::AppResult<()> {
    let metrics = metric_store::connect(&config)?;
    if should_migrate_primary_metric_store(&config) {
        metric_store::migrate(&metrics).await?;
    }
    if let Some(control_store) = ControlStore::connect(&config)? {
        control_store.migrate().await?;
    }
    if let Some(control_db) = ControlDb::connect(config.control_database_url.as_deref()).await? {
        control_db.migrate().await?;
    }
    Ok(())
}

/// Apply only the Postgres control-plane migrations. Unlike `migrate`, this does
/// not touch ClickHouse, so it can run against a freshly provisioned Cloud SQL
/// instance (e.g. via the Cloud SQL Auth Proxy) before cutover, without a
/// reachable ClickHouse.
async fn migrate_control(config: AppConfig) -> instantml_rust_server::AppResult<()> {
    let control_db = ControlDb::connect(config.control_database_url.as_deref())
        .await?
        .ok_or_else(|| {
            instantml_rust_server::AppError::config("migrate-control requires DATABASE_URL")
        })?;
    control_db.migrate().await?;
    tracing::info!("control-plane Postgres migrations applied");
    println!("Control-plane Postgres schema is up to date.");
    Ok(())
}

/// One-shot cutover step: copy the ClickHouse control log into Postgres. Run
/// during the maintenance window, after `migrate` has created the schema and
/// before `DATABASE_URL` is turned on for the serving instances. Idempotent.
/// Exits non-zero if any rows could not be written so the operator resolves
/// collisions before flipping over.
async fn backfill_control(config: AppConfig) -> instantml_rust_server::AppResult<()> {
    let control_store = ControlStore::connect(&config)?.ok_or_else(|| {
        instantml_rust_server::AppError::config(
            "backfill-control requires the hosted ClickHouse control store (source)",
        )
    })?;
    let control_db = ControlDb::connect(config.control_database_url.as_deref())
        .await?
        .ok_or_else(|| {
            instantml_rust_server::AppError::config(
                "backfill-control requires DATABASE_URL (destination)",
            )
        })?;
    control_db.migrate().await?;

    let report = store::run_control_backfill(&control_store, &control_db).await?;
    tracing::info!(
        written = report.written,
        issues = report.issues.len(),
        "control backfill complete"
    );
    for issue in &report.issues {
        tracing::warn!(
            kind = %issue.kind,
            entity_id = %issue.entity_id,
            message = %issue.message,
            "control backfill could not write a record"
        );
    }
    println!(
        "Backfill wrote {} record(s); {} issue(s) needing resolution.",
        report.written,
        report.issues.len()
    );
    if report.issues.is_empty() {
        Ok(())
    } else {
        Err(instantml_rust_server::AppError::internal(format!(
            "control backfill left {} unresolved issue(s); fix the source data and re-run",
            report.issues.len()
        )))
    }
}

async fn seed_demo(config: AppConfig) -> instantml_rust_server::AppResult<()> {
    let metrics = metric_store::connect(&config)?;
    if should_migrate_primary_metric_store(&config) {
        metric_store::migrate(&metrics).await?;
    }
    let control_store = ControlStore::connect(&config)?;
    if let Some(control_store) = &control_store {
        control_store.migrate().await?;
    }
    let control_db = ControlDb::connect(config.control_database_url.as_deref()).await?;
    if let Some(control_db) = &control_db {
        control_db.migrate().await?;
    }
    let store = store::Store::connect(
        metrics,
        control_store,
        control_db,
        config.hosted_clickhouse.clone(),
        config.byoc_clickhouse.clone(),
    )
    .await?;
    let session = store::create_dev_google_session(
        &store,
        DevGoogleAuthRequest {
            email: Some("hello@instantml.ai".to_string()),
            display_name: None,
            mode: None,
            account_type: None,
            org_name: None,
            plan_tier: None,
            storage_choice: None,
            seat_emails: None,
            accept_invite_org_id: None,
            accept_invite_token: None,
        },
        None,
    )
    .await?;
    let org_id = session.payload.organization.id;
    let ctx = RequestContext {
        org_id,
        auth: None,
        session: None,
    };
    let result = store::reset_demo(&store, &ctx).await?;
    let runs = result
        .get("runs")
        .and_then(|value| value.as_array())
        .map(|array| array.len())
        .unwrap_or(0);
    tracing::info!(%org_id, runs, "seeded shared demo workspace");
    println!("Seeded shared demo workspace ({runs} runs) into org {org_id}");
    Ok(())
}

async fn worker(config: AppConfig) -> instantml_rust_server::AppResult<()> {
    let metrics = metric_store::connect(&config)?;
    if should_migrate_primary_metric_store(&config) {
        metric_store::migrate(&metrics).await?;
    }
    let control_store = ControlStore::connect(&config)?;
    if let Some(control_store) = &control_store {
        control_store.migrate().await?;
    }
    let control_db = ControlDb::connect(config.control_database_url.as_deref()).await?;
    if let Some(control_db) = &control_db {
        control_db.migrate().await?;
    }
    let store = store::Store::connect(
        metrics,
        control_store,
        control_db,
        config.hosted_clickhouse.clone(),
        config.byoc_clickhouse.clone(),
    )
    .await?;
    let deleted = store::delete_expired_idempotency(&store).await?;
    let deleted_sessions = store::delete_expired_or_revoked_sessions(&store).await?;
    let cleaned_uploads = store::cleanup_expired_artifact_uploads(&store, &config).await?;
    let usage_snapshots = store::write_usage_daily_snapshots(&store).await?;
    tracing::info!(
        workflow = "worker",
        operation = "cleanup",
        stage = "complete",
        outcome = "success",
        status = 200,
        code = "ok",
        retryable = false,
        deleted_idempotency_rows = deleted,
        deleted_session_rows = deleted_sessions,
        cleaned_artifact_upload_sessions = cleaned_uploads,
        usage_daily_snapshots = usage_snapshots,
        "worker cleanup outcome"
    );
    Ok(())
}

fn should_migrate_primary_metric_store(config: &AppConfig) -> bool {
    if matches!(config.service_plane, ServicePlaneRole::Control) {
        return false;
    }
    !matches!(
        config
            .hosted_clickhouse
            .as_ref()
            .map(|hosted| &hosted.provisioner),
        Some(ClickHouseProvisioner::CloudService)
    )
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            let _ = signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

fn print_help() {
    println!(
        "Usage: instantml-rust-server [serve|all|migrate|worker|seed-demo|emit-openapi]\n\n\
         emit-openapi: prints the utoipa-generated OpenAPI spec to stdout (used by\n  \
                   `npm run codegen:api`).\n\n\
         Environment: CLICKHOUSE_URL, INSTANTML_BIND_ADDR, INSTANTML_AUTH_MODE, \
         INSTANTML_BOOTSTRAP_TOKEN, INSTANTML_ARTIFACT_ROOT, INSTANTML_MAX_BODY_BYTES, INSTANTML_MAX_UPLOAD_BODY_BYTES, \
         INSTANTML_HOSTED_CLICKHOUSE_ENABLED, INSTANTML_SERVICE_PLANE, CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT"
    );
}
