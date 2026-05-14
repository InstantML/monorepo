use std::process::ExitCode;

use rlobs_rust_server::{config::AppConfig, http::AppState, metric_store, store, telemetry};
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

async fn run() -> rlobs_rust_server::AppResult<()> {
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
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => Err(rlobs_rust_server::AppError::config(format!(
            "unknown command {other}; expected serve, worker, migrate, or all"
        ))),
    }
}

async fn serve(config: AppConfig) -> rlobs_rust_server::AppResult<()> {
    let metrics = metric_store::connect(&config)?;
    metric_store::migrate(&metrics).await?;
    let store = store::Store::connect(metrics.clone()).await?;
    let bind_addr = config.bind_addr;
    let app = rlobs_rust_server::http::router(AppState::new(store, config));
    let listener = TcpListener::bind(bind_addr).await?;
    tracing::info!(%bind_addr, "Training Observability Rust server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| rlobs_rust_server::AppError::internal(format!("server failed: {error}")))
}

async fn migrate_all(config: AppConfig) -> rlobs_rust_server::AppResult<()> {
    let metrics = metric_store::connect(&config)?;
    metric_store::migrate(&metrics).await?;
    Ok(())
}

async fn worker(config: AppConfig) -> rlobs_rust_server::AppResult<()> {
    let metrics = metric_store::connect(&config)?;
    metric_store::migrate(&metrics).await?;
    let store = store::Store::connect(metrics).await?;
    let deleted = store::delete_expired_idempotency(&store).await?;
    let deleted_sessions = store::delete_expired_or_revoked_sessions(&store).await?;
    let usage_snapshots = store::write_usage_daily_snapshots(&store).await?;
    tracing::info!(deleted, "deleted expired idempotency rows");
    tracing::info!(deleted_sessions, "deleted expired or revoked session rows");
    tracing::info!(usage_snapshots, "wrote immutable usage daily snapshots");
    Ok(())
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
        "Usage: rlobs-rust-server [serve|all|migrate|worker]\n\n\
         Environment: CLICKHOUSE_URL, RLOBS_BIND_ADDR, RLOBS_AUTH_MODE, \
         RLOBS_BOOTSTRAP_TOKEN, RLOBS_ARTIFACT_ROOT, RLOBS_MAX_BODY_BYTES, RLOBS_MAX_UPLOAD_BODY_BYTES"
    );
}
