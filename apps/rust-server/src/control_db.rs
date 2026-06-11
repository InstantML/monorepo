//! Postgres control-plane storage.
//!
//! System of record for users, orgs, memberships, sessions, API keys,
//! invitations, billing, and tenant routes. Replaces the former ClickHouse
//! append-only control log and its in-memory projection:
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

#[derive(Clone, Debug)]
pub struct ControlDb {
    pool: PgPool,
}

pub const DEFAULT_CONTROL_DB_MAX_CONNECTIONS: u32 = 10;
pub const CONTROL_DB_MAX_CONNECTIONS_ENV: &str = "CONTROL_DB_MAX_CONNECTIONS";

impl ControlDb {
    /// Connect to the control-plane Postgres using `DATABASE_URL`.
    ///
    /// Returns `Ok(None)` when no URL is configured so single-binary local mode
    /// can keep storing local operational records in ClickHouse.
    pub async fn connect(database_url: Option<&str>) -> AppResult<Option<Self>> {
        let Some(url) = database_url else {
            return Ok(None);
        };
        let options = pg_connect_options(url)?;
        let pool = PgPoolOptions::new()
            .max_connections(control_db_max_connections_from_env()?)
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

/// Parse a `DATABASE_URL` into `sqlx` connect options.
///
/// `sqlx` rejects the libpq-style `postgres://user:pass@/db?host=/socket/dir`
/// unix-socket form ("empty host"), but that is exactly the form Cloud Run +
/// the Cloud SQL Auth Proxy use (`?host=/cloudsql/<connection-name>`). To keep
/// operators from having to hand-percent-encode a socket path full of `/` and
/// `:`, accept the `?host=` form and rebuild it into the percent-encoded
/// authority form `sqlx` does accept. TCP URLs fall through to `sqlx`'s parser.
fn pg_connect_options(database_url: &str) -> AppResult<PgConnectOptions> {
    let invalid = |detail: String| {
        AppError::config(format!("invalid DATABASE_URL for control plane: {detail}"))
    };
    // The `?host=/dir` socket form has an empty authority host, which both
    // `sqlx`'s and `url`'s parsers reject outright — so detect and rewrite it by
    // hand before handing anything to `sqlx`. TCP URLs fall straight through.
    let Some(socket_dir) = host_query_param(database_url) else {
        return database_url
            .parse::<PgConnectOptions>()
            .map_err(|err| invalid(err.to_string()));
    };
    let base = database_url.split('?').next().unwrap_or(database_url);
    let after_scheme = base
        .strip_prefix("postgresql://")
        .or_else(|| base.strip_prefix("postgres://"))
        .ok_or_else(|| invalid("expected a postgres:// URL".to_string()))?;
    let (userinfo, host_and_path) = after_scheme
        .split_once('@')
        .ok_or_else(|| invalid("socket DATABASE_URL is missing credentials".to_string()))?;
    let database = host_and_path
        .split_once('/')
        .map(|(_, db)| db)
        .unwrap_or("");
    // Percent-encode the socket directory into the authority, where `sqlx`
    // treats a leading-slash host as a unix socket. `%` first so the escapes we
    // introduce are not themselves re-encoded. Userinfo is reused verbatim so
    // already-encoded credentials round-trip unchanged.
    let encoded_dir = socket_dir
        .replace('%', "%25")
        .replace('/', "%2F")
        .replace(':', "%3A");
    let rebuilt = format!("postgresql://{userinfo}@{encoded_dir}/{database}");
    rebuilt
        .parse::<PgConnectOptions>()
        .map_err(|err| invalid(err.to_string()))
}

/// Extract a `host=` query parameter (the libpq unix-socket directory) from a
/// connection URL, if present.
fn host_query_param(database_url: &str) -> Option<String> {
    let query = database_url.split_once('?')?.1;
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("host=").map(|value| value.to_string()))
}

/// Pool size. Fluid Compute / multi-instance Cloud Run runs several app
/// instances against one database, so keep per-instance connections modest and
/// let Cloud SQL's connection limit bound the total. Override with
/// `CONTROL_DB_MAX_CONNECTIONS`.
pub fn control_db_max_connections_from_env() -> AppResult<u32> {
    control_db_max_connections_from_lookup(|key| std::env::var(key).ok())
}

pub fn control_db_max_connections_from_lookup<F>(lookup: F) -> AppResult<u32>
where
    F: Fn(&str) -> Option<String>,
{
    let Some(raw) = lookup(CONTROL_DB_MAX_CONNECTIONS_ENV) else {
        return Ok(DEFAULT_CONTROL_DB_MAX_CONNECTIONS);
    };
    parse_positive_u32(CONTROL_DB_MAX_CONNECTIONS_ENV, &raw)
}

fn parse_positive_u32(key: &str, raw: &str) -> AppResult<u32> {
    let value = raw
        .trim()
        .parse::<u32>()
        .map_err(|_| AppError::config(format!("{key} must be an unsigned integer")))?;
    if value == 0 {
        return Err(AppError::config(format!("{key} must be greater than zero")));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cloud_run_unix_socket_host_form() {
        // The exact form Cloud Run + Cloud SQL Auth Proxy produce, which sqlx's
        // own parser rejects with "empty host".
        let opts = pg_connect_options(
            "postgres://instantml:pw@/control?host=/cloudsql/proj:us-central1:inst",
        )
        .expect("socket form should parse");
        assert_eq!(
            opts.get_socket()
                .map(|path| path.to_string_lossy().into_owned()),
            Some("/cloudsql/proj:us-central1:inst".to_string())
        );
        assert_eq!(opts.get_database(), Some("control"));
    }

    #[test]
    fn parses_plain_tcp_form() {
        let opts = pg_connect_options("postgres://u:pw@db.example.com:5432/control")
            .expect("tcp form should parse");
        assert_eq!(opts.get_host(), "db.example.com");
        assert_eq!(opts.get_port(), 5432);
        assert!(opts.get_socket().is_none());
    }

    #[test]
    fn parses_control_db_max_connections() {
        assert_eq!(
            control_db_max_connections_from_lookup(|_| None).expect("default should parse"),
            DEFAULT_CONTROL_DB_MAX_CONNECTIONS
        );
        assert_eq!(
            control_db_max_connections_from_lookup(|_| Some(" 6 ".to_string()))
                .expect("explicit value should parse"),
            6
        );
    }

    #[test]
    fn rejects_invalid_control_db_max_connections() {
        let err = control_db_max_connections_from_lookup(|_| Some("0".to_string()))
            .expect_err("zero pool size should fail");
        assert!(err.message().contains("greater than zero"));

        let err = control_db_max_connections_from_lookup(|_| Some("nope".to_string()))
            .expect_err("invalid pool size should fail");
        assert!(err.message().contains("unsigned integer"));
    }
}
