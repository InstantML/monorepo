//! ClickHouse-backed metric store.
//!
//! Owns the connection, schema migrations, and (in later phases) the read/write
//! paths for `metric_points` and `metric_series`. Postgres remains the OLTP
//! store for orgs, runs, attributes, artifacts, etc; this module handles only
//! the high-volume time-series data.

use chrono::{DateTime, Utc};
use clickhouse::{Client as ClickHouseClient, Row};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::{
    config::AppConfig,
    errors::{AppError, AppResult},
};

/// One row in the ClickHouse `metric_points` table.
///
/// Field order matches the schema in `clickhouse/0001_initial.sql` — the
/// clickhouse crate uses positional RowBinary serialization, so reordering
/// fields here without also updating the table will silently corrupt data.
#[derive(Row, Serialize)]
pub struct MetricPointRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub key: String,
    pub step: f64,
    pub value: f64,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub logged_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub created_at: DateTime<Utc>,
}

/// Read shape for a single-run point query (mirrors `domain::MetricPointRow`).
#[derive(Row, Deserialize)]
pub struct PointReadRow {
    pub key: String,
    pub step: f64,
    pub value: f64,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub created_at: DateTime<Utc>,
}

/// Read shape for multi-run batched point queries — same as `PointReadRow` but
/// with the run id included so callers can fan out by run.
#[derive(Row, Deserialize)]
pub struct PointReadRowWithRun {
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub key: String,
    pub step: f64,
    pub value: f64,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub created_at: DateTime<Utc>,
}

/// Result row from a metric-series aggregate query. Field order matches the
/// SELECT-list produced by `query_series_for_runs`.
#[derive(Row, Deserialize)]
pub struct SeriesReadRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub key: String,
    pub count: u64,
    pub min: f64,
    pub max: f64,
    pub sum: f64,
    pub sum_sq: f64,
    pub latest: f64,
    pub latest_step: f64,
    pub best_step: f64,
}

const INITIAL_SCHEMA: &str = include_str!("../clickhouse/0001_initial.sql");

/// Wraps a configured ClickHouse client alongside the database it targets.
///
/// The clickhouse crate's `Client` builder does not expose the database it was
/// configured with, so we keep it ourselves — useful for `CREATE DATABASE`
/// bootstrap and for diagnostic logging.
#[derive(Clone)]
pub struct MetricStore {
    client: ClickHouseClient,
    database: String,
}

impl MetricStore {
    pub fn client(&self) -> &ClickHouseClient {
        &self.client
    }

    pub fn database(&self) -> &str {
        &self.database
    }

    /// Insert a batch of metric points. The `metric_series_mv` materialized
    /// view updates `metric_series` aggregates automatically during the same
    /// insert — callers do not need to maintain summary state separately.
    ///
    /// A no-op on empty input.
    pub async fn insert_points(&self, points: &[MetricPointRow]) -> AppResult<()> {
        if points.is_empty() {
            return Ok(());
        }
        let mut inserter = self
            .client
            .insert("metric_points")
            .map_err(|err| AppError::internal(format!("clickhouse insert init failed: {err}")))?;
        for point in points {
            inserter.write(point).await.map_err(|err| {
                AppError::internal(format!("clickhouse insert write failed: {err}"))
            })?;
        }
        inserter
            .end()
            .await
            .map_err(|err| AppError::internal(format!("clickhouse insert flush failed: {err}")))?;
        Ok(())
    }

    /// Fetch up to `limit` raw points for a single run, optionally filtered by
    /// key and step range. Returned rows are sorted by step (then created_at).
    pub async fn query_points(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        key: Option<&str>,
        start_step: Option<f64>,
        end_step: Option<f64>,
        limit: i64,
    ) -> AppResult<Vec<PointReadRow>> {
        let key_filter = if key.is_some() { "AND key = ?" } else { "" };
        let sql = format!(
            "SELECT key, step, value, created_at \
             FROM metric_points \
             WHERE org_id = ? AND run_id = ? {key_filter} \
               AND (? = 0 OR step >= ?) \
               AND (? = 0 OR step <= ?) \
             ORDER BY key, step ASC, created_at ASC \
             LIMIT ?"
        );
        let mut query = self.client.query(&sql).bind(org_id).bind(run_id);
        if let Some(k) = key {
            query = query.bind(k);
        }
        let (start_flag, start_val) = bind_optional_step(start_step);
        let (end_flag, end_val) = bind_optional_step(end_step);
        query
            .bind(start_flag)
            .bind(start_val)
            .bind(end_flag)
            .bind(end_val)
            .bind(limit)
            .fetch_all::<PointReadRow>()
            .await
            .map_err(clickhouse_read_error)
    }

    /// Fetch up to `limit` points per run for a single metric key across
    /// multiple runs. Used by the batched-series chart endpoint.
    pub async fn query_points_for_runs(
        &self,
        org_id: Uuid,
        run_ids: &[Uuid],
        key: &str,
        start_step: Option<f64>,
        end_step: Option<f64>,
        limit_per_run: i64,
    ) -> AppResult<Vec<PointReadRowWithRun>> {
        if run_ids.is_empty() {
            return Ok(Vec::new());
        }
        let (start_flag, start_val) = bind_optional_step(start_step);
        let (end_flag, end_val) = bind_optional_step(end_step);
        let sql = "SELECT run_id, key, step, value, created_at \
                   FROM metric_points \
                   WHERE org_id = ? AND run_id IN ? AND key = ? \
                     AND (? = 0 OR step >= ?) \
                     AND (? = 0 OR step <= ?) \
                   ORDER BY run_id, step ASC, created_at ASC \
                   LIMIT ? BY run_id";
        self.client
            .query(sql)
            .bind(org_id)
            .bind(run_ids)
            .bind(key)
            .bind(start_flag)
            .bind(start_val)
            .bind(end_flag)
            .bind(end_val)
            .bind(limit_per_run)
            .fetch_all::<PointReadRowWithRun>()
            .await
            .map_err(clickhouse_read_error)
    }

    /// Fetch aggregated series rows for a set of runs. Caller computes
    /// `mean`/`variance`/`best` from the raw aggregates.
    pub async fn query_series_for_runs(
        &self,
        org_id: Uuid,
        run_ids: &[Uuid],
        limit: Option<i64>,
    ) -> AppResult<Vec<SeriesReadRow>> {
        if run_ids.is_empty() {
            return Ok(Vec::new());
        }
        let limit_clause = if limit.is_some() { "LIMIT ?" } else { "" };
        let sql = format!(
            "SELECT \
               run_id, key, \
               toUInt64(countMerge(count)) AS count, \
               minMerge(min) AS min, \
               maxMerge(max) AS max, \
               sumMerge(sum) AS sum, \
               sumMerge(sum_sq) AS sum_sq, \
               argMaxMerge(latest) AS latest, \
               maxMerge(latest_step) AS latest_step, \
               argMaxMerge(best_step) AS best_step \
             FROM metric_series \
             WHERE org_id = ? AND run_id IN ? \
             GROUP BY run_id, key \
             ORDER BY key \
             {limit_clause}"
        );
        let mut query = self.client.query(&sql).bind(org_id).bind(run_ids);
        if let Some(n) = limit {
            query = query.bind(n);
        }
        query
            .fetch_all::<SeriesReadRow>()
            .await
            .map_err(clickhouse_read_error)
    }

    /// Count the total number of metric points for an org. Used by usage
    /// rollups in place of the prior Postgres `count(*)` query.
    pub async fn count_points_for_org(&self, org_id: Uuid) -> AppResult<i64> {
        let count: u64 = self
            .client
            .query("SELECT count() FROM metric_points WHERE org_id = ?")
            .bind(org_id)
            .fetch_one::<u64>()
            .await
            .map_err(clickhouse_read_error)?;
        Ok(count as i64)
    }

    /// Count the distinct (run_id, key) pairs that have at least one metric
    /// point for an org. Replaces the prior `count(*) from metric_series`.
    pub async fn count_series_for_org(&self, org_id: Uuid) -> AppResult<i64> {
        let count: u64 = self
            .client
            .query(
                "SELECT count() FROM (SELECT run_id, key FROM metric_series \
                 WHERE org_id = ? GROUP BY run_id, key)",
            )
            .bind(org_id)
            .fetch_one::<u64>()
            .await
            .map_err(clickhouse_read_error)?;
        Ok(count as i64)
    }
}

fn bind_optional_step(step: Option<f64>) -> (u8, f64) {
    match step {
        Some(value) => (1, value),
        None => (0, 0.0),
    }
}

fn clickhouse_read_error(err: clickhouse::error::Error) -> AppError {
    AppError::internal(format!("clickhouse query failed: {err}"))
}

/// Build a [`MetricStore`] from `CLICKHOUSE_URL`.
///
/// Accepts URLs of the form `http://user:pass@host:port/database`. The path
/// segment is treated as the database name; the userinfo is split into user
/// and password.
pub fn connect(config: &AppConfig) -> AppResult<MetricStore> {
    let parsed = Url::parse(&config.clickhouse_url)
        .map_err(|err| AppError::config(format!("CLICKHOUSE_URL is not a valid URL: {err}")))?;
    let scheme = parsed.scheme();
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::config("CLICKHOUSE_URL must include a host"))?;
    let port = parsed
        .port()
        .unwrap_or(if scheme == "https" { 8443 } else { 8123 });
    let database = parsed.path().trim_start_matches('/');
    let database = if database.is_empty() {
        "default".to_string()
    } else {
        database.to_string()
    };
    let user = if parsed.username().is_empty() {
        "default"
    } else {
        parsed.username()
    };
    let password = parsed.password().unwrap_or("");

    let endpoint = format!("{scheme}://{host}:{port}");
    let client = ClickHouseClient::default()
        .with_url(endpoint)
        .with_user(user)
        .with_password(password)
        .with_database(&database);

    Ok(MetricStore { client, database })
}

/// Apply the ClickHouse schema. Idempotent: every statement uses
/// `CREATE ... IF NOT EXISTS`.
pub async fn migrate(store: &MetricStore) -> AppResult<()> {
    ensure_database(store).await?;
    for statement in split_statements(INITIAL_SCHEMA) {
        store
            .client
            .query(&statement)
            .execute()
            .await
            .map_err(|err| AppError::internal(format!("clickhouse migration failed: {err}")))?;
    }
    Ok(())
}

/// Returns true when ClickHouse responds to a trivial query.
pub async fn ready(store: &MetricStore) -> bool {
    store.client.query("SELECT 1").execute().await.is_ok()
}

/// Create the configured database if it does not exist. ClickHouse rejects
/// queries against a missing database, so this must run before applying schema.
async fn ensure_database(store: &MetricStore) -> AppResult<()> {
    if store.database.is_empty() || store.database == "default" {
        return Ok(());
    }
    let bootstrap = store.client.clone().with_database("default");
    let statement = format!("CREATE DATABASE IF NOT EXISTS {}", store.database);
    bootstrap
        .query(&statement)
        .execute()
        .await
        .map_err(|err| AppError::internal(format!("clickhouse create database failed: {err}")))?;
    Ok(())
}

fn split_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    for line in sql.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("--") || trimmed.is_empty() {
            continue;
        }
        current.push_str(line);
        current.push('\n');
        if line.trim_end().ends_with(';') {
            let stmt = current.trim().trim_end_matches(';').trim().to_string();
            if !stmt.is_empty() {
                statements.push(stmt);
            }
            current.clear();
        }
    }
    let tail = current.trim().trim_end_matches(';').trim().to_string();
    if !tail.is_empty() {
        statements.push(tail);
    }
    statements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_statements_handles_comments_and_blanks() {
        let sql = "-- header\nCREATE TABLE a (x Int64) ENGINE = Memory;\n\n-- between\nCREATE TABLE b (y Int64) ENGINE = Memory;\n";
        let statements = split_statements(sql);
        assert_eq!(statements.len(), 2);
        assert!(statements[0].starts_with("CREATE TABLE a"));
        assert!(statements[1].starts_with("CREATE TABLE b"));
    }
}
