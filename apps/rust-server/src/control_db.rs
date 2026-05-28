//! Postgres control-plane storage.
//!
//! System of record for users, orgs, memberships, sessions, API keys,
//! invitations, billing, and tenant routes. Replaces the ClickHouse
//! append-only event log (`control_store.rs`) and its in-memory projection:
//! uniqueness, atomicity, and read-after-write are enforced by Postgres.
//!
//! Tenant-owned run data and metrics remain in ClickHouse.

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::time::Duration;

use crate::errors::{AppError, AppResult};

/// Embeds the SQL files in `migrations/` at compile time so the running binary
/// can apply them without shipping the files separately. Matches how the
/// `migrate` command already drives the ClickHouse schema.
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub struct ControlDb {
    pool: PgPool,
}

impl ControlDb {
    /// Connect to the control-plane Postgres using `DATABASE_URL`.
    ///
    /// Returns `Ok(None)` when no URL is configured so single-binary local mode
    /// and the legacy ClickHouse control path keep working unchanged during the
    /// migration.
    pub async fn connect(database_url: Option<&str>) -> AppResult<Option<Self>> {
        let Some(url) = database_url else {
            return Ok(None);
        };
        let options: PgConnectOptions = url.parse().map_err(|err| {
            AppError::config(format!("invalid DATABASE_URL for control plane: {err}"))
        })?;
        let pool = PgPoolOptions::new()
            .max_connections(pool_max_connections())
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .map_err(|err| {
                AppError::internal(format!("control-plane postgres connect failed: {err}"))
            })?;
        Ok(Some(Self { pool }))
    }

    /// Build directly from a pool. Used by tests that get an isolated database
    /// from `#[sqlx::test]`.
    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Apply pending migrations. Idempotent; safe to call on every boot.
    pub async fn migrate(&self) -> AppResult<()> {
        MIGRATOR.run(&self.pool).await.map_err(|err| {
            AppError::internal(format!("control-plane postgres migration failed: {err}"))
        })
    }

    /// Liveness probe for readiness checks.
    pub async fn ready(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.pool).await.is_ok()
    }
}

/// Pool size. Fluid Compute / multi-instance Cloud Run runs several app
/// instances against one database, so keep per-instance connections modest and
/// let Cloud SQL's connection limit bound the total. Override with
/// `CONTROL_DB_MAX_CONNECTIONS`.
fn pool_max_connections() -> u32 {
    std::env::var("CONTROL_DB_MAX_CONNECTIONS")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(10)
}
