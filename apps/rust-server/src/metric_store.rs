//! ClickHouse-backed storage.
//!
//! Owns the connection, schema migrations, high-volume metric reads/writes, and
//! the low-volume operational record log used to rebuild the Rust service's
//! single-process index.

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

/// One row in the ClickHouse `console_log_lines` table.
///
/// Field order matches the schema in `clickhouse/0001_initial.sql`.
#[derive(Row, Serialize)]
pub struct ConsoleLogInsertRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub stream: String,
    #[serde(with = "clickhouse::serde::uuid")]
    pub ingest_id: Uuid,
    pub line_number: u64,
    pub message: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub logged_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub created_at: DateTime<Utc>,
}

/// One durable operational record in the ClickHouse control/data-plane layer.
///
/// Operational state is intentionally stored as complete JSON payloads in an
/// append-only table. The Rust service rebuilds its in-process index from these
/// rows on startup, then writes one row per accepted mutation.
#[derive(Row, Serialize, Deserialize, Clone)]
pub struct OperationalRecordRow {
    pub kind: String,
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    pub entity_id: String,
    pub payload: String,
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

/// Read shape for a console log window query.
#[derive(Row, Deserialize, Clone)]
pub struct ConsoleLogReadRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub stream: String,
    #[serde(with = "clickhouse::serde::uuid")]
    pub ingest_id: Uuid,
    pub line_number: u64,
    pub message: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub logged_at: DateTime<Utc>,
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

#[derive(Row, Deserialize)]
pub struct MetricKeyReadRow {
    pub key: String,
}

#[derive(Clone, Copy)]
pub enum SeriesSortMode {
    Latest,
    BestMax,
    BestMin,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClickHouseConnection {
    pub endpoint: String,
    pub username: String,
    pub password: String,
    pub database: String,
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
            .map_err(|err| clickhouse_storage_error("clickhouse insert init failed", err))?;
        for point in points {
            inserter
                .write(point)
                .await
                .map_err(|err| clickhouse_storage_error("clickhouse insert write failed", err))?;
        }
        inserter
            .end()
            .await
            .map_err(|err| clickhouse_storage_error("clickhouse insert flush failed", err))?;
        Ok(())
    }

    pub async fn insert_console_logs(&self, rows: &[ConsoleLogInsertRow]) -> AppResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut inserter = self
            .client
            .insert("console_log_lines")
            .map_err(|err| clickhouse_storage_error("clickhouse log insert init failed", err))?;
        for row in rows {
            inserter.write(row).await.map_err(|err| {
                clickhouse_storage_error("clickhouse log insert write failed", err)
            })?;
        }
        inserter
            .end()
            .await
            .map_err(|err| clickhouse_storage_error("clickhouse log insert flush failed", err))?;
        Ok(())
    }

    pub async fn insert_operational_record(&self, row: &OperationalRecordRow) -> AppResult<()> {
        let mut inserter = self.client.insert("operational_records").map_err(|err| {
            clickhouse_storage_error("clickhouse operational insert init failed", err)
        })?;
        inserter.write(row).await.map_err(|err| {
            clickhouse_storage_error("clickhouse operational insert write failed", err)
        })?;
        inserter.end().await.map_err(|err| {
            clickhouse_storage_error("clickhouse operational insert flush failed", err)
        })?;
        Ok(())
    }

    pub async fn load_operational_records(&self) -> AppResult<Vec<OperationalRecordRow>> {
        self.client
            .query(
                "SELECT kind, org_id, entity_id, payload, created_at \
                 FROM operational_records \
                 ORDER BY created_at ASC, kind ASC, entity_id ASC",
            )
            .fetch_all::<OperationalRecordRow>()
            .await
            .map_err(clickhouse_read_error)
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

    pub async fn query_console_log_window(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        stream: &str,
        cursor: Option<(u64, Uuid)>,
        limit: i64,
    ) -> AppResult<Vec<ConsoleLogReadRow>> {
        let (cursor_set, cursor_line, cursor_ingest) = match cursor {
            Some((line_number, ingest_id)) => (1_u8, line_number, ingest_id),
            None => (0_u8, 0_u64, Uuid::nil()),
        };
        self.client
            .query(
                "SELECT run_id, stream, ingest_id, line_number, message, logged_at, created_at \
                 FROM console_log_lines \
                 WHERE org_id = ? AND run_id = ? AND stream = ? \
                   AND (? = 0 OR line_number > ? OR (line_number = ? AND ingest_id > ?)) \
                 ORDER BY line_number ASC, ingest_id ASC \
                 LIMIT ?",
            )
            .bind(org_id)
            .bind(run_id)
            .bind(stream)
            .bind(cursor_set)
            .bind(cursor_line)
            .bind(cursor_line)
            .bind(cursor_ingest)
            .bind(limit)
            .fetch_all::<ConsoleLogReadRow>()
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

    pub async fn query_series_for_runs_key(
        &self,
        org_id: Uuid,
        run_ids: &[Uuid],
        key: &str,
    ) -> AppResult<Vec<SeriesReadRow>> {
        if run_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.client
            .query(
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
                 WHERE org_id = ? AND run_id IN ? AND key = ? \
                 GROUP BY run_id, key \
                 ORDER BY run_id",
            )
            .bind(org_id)
            .bind(run_ids)
            .bind(key)
            .fetch_all::<SeriesReadRow>()
            .await
            .map_err(clickhouse_read_error)
    }

    pub async fn query_series_for_org_key(
        &self,
        org_id: Uuid,
        key: &str,
    ) -> AppResult<Vec<SeriesReadRow>> {
        self.client
            .query(
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
                 WHERE org_id = ? AND key = ? \
                 GROUP BY run_id, key \
                 ORDER BY run_id",
            )
            .bind(org_id)
            .bind(key)
            .fetch_all::<SeriesReadRow>()
            .await
            .map_err(clickhouse_read_error)
    }

    pub async fn query_top_series_for_org_key(
        &self,
        org_id: Uuid,
        key: &str,
        mode: SeriesSortMode,
        limit: i64,
    ) -> AppResult<Vec<SeriesReadRow>> {
        let order_clause = match mode {
            SeriesSortMode::Latest => "latest DESC",
            SeriesSortMode::BestMax => "max DESC",
            SeriesSortMode::BestMin => "min ASC",
        };
        let sql = format!(
            "SELECT \
               run_id, key, \
               count, min, max, sum, sum_sq, latest, latest_step, best_step \
             FROM ( \
               SELECT \
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
               WHERE org_id = ? AND key = ? \
               GROUP BY run_id, key \
             ) \
             ORDER BY {order_clause}, run_id \
             LIMIT ?"
        );
        self.client
            .query(&sql)
            .bind(org_id)
            .bind(key)
            .bind(limit)
            .fetch_all::<SeriesReadRow>()
            .await
            .map_err(clickhouse_read_error)
    }

    pub async fn query_top_series_for_project_key(
        &self,
        org_id: Uuid,
        project: &str,
        key: &str,
        mode: SeriesSortMode,
        limit: i64,
    ) -> AppResult<Vec<SeriesReadRow>> {
        let order_clause = match mode {
            SeriesSortMode::Latest => "latest DESC",
            SeriesSortMode::BestMax => "max DESC",
            SeriesSortMode::BestMin => "min ASC",
        };
        let sql = format!(
            "SELECT \
               run_id, key, \
               count, min, max, sum, sum_sq, latest, latest_step, best_step \
             FROM ( \
               SELECT \
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
               WHERE org_id = ? AND key = ? AND run_id IN ( \
                 SELECT toUUID(entity_id) \
                 FROM operational_records \
                 WHERE org_id = ? AND kind = 'run' \
                   AND JSONExtractString(payload, 'project') = ? \
               ) \
               GROUP BY run_id, key \
             ) \
             ORDER BY {order_clause}, run_id \
             LIMIT ?"
        );
        self.client
            .query(&sql)
            .bind(org_id)
            .bind(key)
            .bind(org_id)
            .bind(project)
            .bind(limit)
            .fetch_all::<SeriesReadRow>()
            .await
            .map_err(clickhouse_read_error)
    }

    pub async fn query_keys_for_runs(
        &self,
        org_id: Uuid,
        run_ids: &[Uuid],
        limit: i64,
    ) -> AppResult<Vec<String>> {
        if run_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .client
            .query(
                "SELECT key \
                 FROM metric_series \
                 WHERE org_id = ? AND run_id IN ? \
                 GROUP BY key \
                 ORDER BY key \
                 LIMIT ?",
            )
            .bind(org_id)
            .bind(run_ids)
            .bind(limit)
            .fetch_all::<MetricKeyReadRow>()
            .await
            .map_err(clickhouse_read_error)?;
        Ok(rows.into_iter().map(|row| row.key).collect())
    }

    /// Count the total number of metric points for an org. Used by usage
    /// rollups in place of the prior ClickHouse `count(*)` query.
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

    /// Count metric points created within a half-open UTC usage period.
    pub async fn count_points_for_org_period(
        &self,
        org_id: Uuid,
        period_start: DateTime<Utc>,
        period_end: DateTime<Utc>,
    ) -> AppResult<i64> {
        let count: u64 = self
            .client
            .query(
                "SELECT count() \
                 FROM metric_points \
                 WHERE org_id = ? \
                 AND created_at >= parseDateTime64BestEffort(?, 6, 'UTC') \
                 AND created_at < parseDateTime64BestEffort(?, 6, 'UTC')",
            )
            .bind(org_id)
            .bind(period_start.to_rfc3339())
            .bind(period_end.to_rfc3339())
            .fetch_one::<u64>()
            .await
            .map_err(clickhouse_read_error)?;
        Ok(count as i64)
    }

    pub async fn count_points_for_project(&self, org_id: Uuid, project: &str) -> AppResult<i64> {
        let count: u64 = self
            .client
            .query(
                "SELECT count() \
                 FROM metric_points \
                 WHERE org_id = ? AND run_id IN ( \
                   SELECT toUUID(entity_id) \
                   FROM operational_records \
                   WHERE org_id = ? AND kind = 'run' \
                     AND JSONExtractString(payload, 'project') = ? \
                 )",
            )
            .bind(org_id)
            .bind(org_id)
            .bind(project)
            .fetch_one::<u64>()
            .await
            .map_err(clickhouse_read_error)?;
        Ok(count as i64)
    }

    pub async fn count_points_for_runs(&self, org_id: Uuid, run_ids: &[Uuid]) -> AppResult<i64> {
        if run_ids.is_empty() {
            return Ok(0);
        }
        let count: u64 = self
            .client
            .query(
                "SELECT toUInt64(sum(count)) \
                 FROM ( \
                   SELECT countMerge(count) AS count \
                   FROM metric_series \
                   WHERE org_id = ? AND run_id IN ? \
                   GROUP BY run_id, key \
                 )",
            )
            .bind(org_id)
            .bind(run_ids)
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
    clickhouse_storage_error("clickhouse query failed", err)
}

fn clickhouse_storage_error(action: &str, err: clickhouse::error::Error) -> AppError {
    let message = format!("{action}: {err}");
    if is_clickhouse_unavailable_message(&message) {
        AppError::warehouse_unavailable(message)
    } else {
        AppError::internal(message)
    }
}

fn is_clickhouse_unavailable_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "503",
        "502 bad gateway",
        "504 gateway timeout",
        "service unavailable",
        "temporarily unavailable",
        "connection refused",
        "connection reset",
        "connection closed",
        "timed out",
        "timeout",
        "operation timed out",
        "not ready",
        "no route to host",
        "failed to lookup address information",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Build a [`MetricStore`] from `CLICKHOUSE_URL`.
///
/// Accepts URLs of the form `http://user:pass@host:port/database`. The path
/// segment is treated as the database name; the userinfo is split into user
/// and password.
pub fn connect(config: &AppConfig) -> AppResult<MetricStore> {
    connect_url(&config.clickhouse_url, "CLICKHOUSE_URL")
}

pub fn connect_url(raw_url: &str, label: &str) -> AppResult<MetricStore> {
    connect_connection(&parse_clickhouse_url(raw_url, label)?)
}

pub fn connect_connection(connection: &ClickHouseConnection) -> AppResult<MetricStore> {
    let client = ClickHouseClient::default()
        .with_url(&connection.endpoint)
        .with_user(&connection.username)
        .with_password(&connection.password)
        .with_database(&connection.database);

    Ok(MetricStore {
        client,
        database: connection.database.clone(),
    })
}

/// Parse a ClickHouse HTTP URL into the connection fields the clickhouse crate
/// needs. Accepts URLs of the form `http://user:pass@host:port/database`.
pub fn parse_clickhouse_url(raw_url: &str, label: &str) -> AppResult<ClickHouseConnection> {
    let parsed = Url::parse(raw_url)
        .map_err(|err| AppError::config(format!("{label} is not a valid URL: {err}")))?;
    let scheme = parsed.scheme();
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::config(format!("{label} must include a host")))?;
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
    Ok(ClickHouseConnection {
        endpoint,
        username: user.to_string(),
        password: password.to_string(),
        database,
    })
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
            .map_err(|err| clickhouse_storage_error("clickhouse migration failed", err))?;
    }
    Ok(())
}

/// Returns true when ClickHouse responds to a trivial query.
pub async fn ready(store: &MetricStore) -> bool {
    store.client.query("SELECT 1").execute().await.is_ok()
}

/// Create the configured database if it does not exist. ClickHouse rejects
/// queries against a missing database, so this must run before applying schema.
pub async fn ensure_database(store: &MetricStore) -> AppResult<()> {
    if store.database.is_empty() || store.database == "default" {
        return Ok(());
    }
    let bootstrap = store.client.clone().with_database("default");
    let statement = format!("CREATE DATABASE IF NOT EXISTS {}", store.database);
    bootstrap
        .query(&statement)
        .execute()
        .await
        .map_err(|err| clickhouse_storage_error("clickhouse create database failed", err))?;
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
    fn parse_clickhouse_url_applies_defaults() {
        let parsed = parse_clickhouse_url("https://example.com/default", "TEST_URL").unwrap();
        assert_eq!(parsed.endpoint, "https://example.com:8443");
        assert_eq!(parsed.username, "default");
        assert_eq!(parsed.password, "");
        assert_eq!(parsed.database, "default");
    }

    #[test]
    fn split_statements_handles_comments_and_blanks() {
        let sql = "-- header\nCREATE TABLE a (x Int64) ENGINE = Memory;\n\n-- between\nCREATE TABLE b (y Int64) ENGINE = Memory;\n";
        let statements = split_statements(sql);
        assert_eq!(statements.len(), 2);
        assert!(statements[0].starts_with("CREATE TABLE a"));
        assert!(statements[1].starts_with("CREATE TABLE b"));
    }

    #[test]
    fn clickhouse_unavailable_classifier_catches_transient_warehouse_states() {
        for message in [
            "clickhouse query failed: HTTP status 503 Service Unavailable",
            "clickhouse migration failed: operation timed out",
            "clickhouse insert failed: connection refused",
            "clickhouse query failed: temporarily unavailable",
        ] {
            assert!(
                is_clickhouse_unavailable_message(message),
                "expected transient classification for {message}"
            );
        }
    }

    #[test]
    fn clickhouse_unavailable_classifier_leaves_query_errors_internal() {
        assert!(!is_clickhouse_unavailable_message(
            "clickhouse query failed: DB::Exception: Unknown identifier metric"
        ));
    }
}
