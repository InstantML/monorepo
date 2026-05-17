use std::process::ExitCode;

use instantml_rust_server::{
    config::{AppConfig, ClickHouseProvisioner, ServicePlaneRole},
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
        "worker" => worker(config).await,
        "seed-demo" => seed_demo(config).await,
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => Err(instantml_rust_server::AppError::config(format!(
            "unknown command {other}; expected serve, worker, migrate, seed-demo, or all"
        ))),
    }
}

async fn serve(config: AppConfig) -> instantml_rust_server::AppResult<()> {
    let metrics = metric_store::connect(&config)?;
    if should_migrate_primary_metric_store(&config) {
        metric_store::migrate(&metrics).await?;
    }
    let control_store = ControlStore::connect(&config)?;
    if let Some(control_store) = &control_store {
        control_store.migrate().await?;
    }
    let store = store::Store::connect(
        metrics.clone(),
        control_store,
        config.hosted_clickhouse.clone(),
    )
    .await?;
    let bind_addr = config.bind_addr;
    let app = instantml_rust_server::http::router(AppState::new(store, config));
    let listener = TcpListener::bind(bind_addr).await?;
    tracing::info!(%bind_addr, "Training Observability Rust server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| {
            instantml_rust_server::AppError::internal(format!("server failed: {error}"))
        })
}

async fn migrate_all(config: AppConfig) -> instantml_rust_server::AppResult<()> {
    let metrics = metric_store::connect(&config)?;
    if should_migrate_primary_metric_store(&config) {
        metric_store::migrate(&metrics).await?;
    }
    if let Some(control_store) = ControlStore::connect(&config)? {
        control_store.migrate().await?;
    }
    Ok(())
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
    let store =
        store::Store::connect(metrics, control_store, config.hosted_clickhouse.clone()).await?;
    let session = store::create_dev_google_session(
        &store,
        DevGoogleAuthRequest {
            email: Some("hello@instantml.ai".to_string()),
            display_name: None,
            account_type: None,
            org_name: None,
            seat_emails: None,
        },
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
    let store =
        store::Store::connect(metrics, control_store, config.hosted_clickhouse.clone()).await?;
    let deleted = store::delete_expired_idempotency(&store).await?;
    let deleted_sessions = store::delete_expired_or_revoked_sessions(&store).await?;
    let usage_snapshots = store::write_usage_daily_snapshots(&store).await?;
    tracing::info!(deleted, "deleted expired idempotency rows");
    tracing::info!(deleted_sessions, "deleted expired or revoked session rows");
    tracing::info!(usage_snapshots, "wrote immutable usage daily snapshots");
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
        "Usage: instantml-rust-server [serve|all|migrate|worker|seed-demo]\n\n\
         Environment: CLICKHOUSE_URL, INSTANTML_BIND_ADDR, INSTANTML_AUTH_MODE, \
         INSTANTML_BOOTSTRAP_TOKEN, INSTANTML_ARTIFACT_ROOT, INSTANTML_MAX_BODY_BYTES, INSTANTML_MAX_UPLOAD_BODY_BYTES, \
         INSTANTML_HOSTED_CLICKHOUSE_ENABLED, INSTANTML_SERVICE_PLANE, CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT"
    );
}
