//! Hosted ClickHouse User Data control-plane storage.
//!
//! This append-only table stores global/user-facing records that must survive
//! tenant service routing: users, orgs, memberships, sessions, API keys, and
//! tenant route metadata. Tenant-owned run data remains in each org's routed
//! ClickHouse database/service.

use chrono::{DateTime, Utc};
use clickhouse::{Client as ClickHouseClient, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    config::AppConfig,
    errors::{AppError, AppResult},
    metric_store::{self, connect_url, MetricStore},
};

#[derive(Row, Serialize, Deserialize, Clone)]
pub struct ControlRecordRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub event_id: Uuid,
    pub scope: String,
    pub kind: String,
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    pub entity_id: String,
    pub payload: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub created_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct ControlStore {
    backing: MetricStore,
}

impl ControlStore {
    pub fn connect(config: &AppConfig) -> AppResult<Option<Self>> {
        let Some(hosted) = &config.hosted_clickhouse else {
            return Ok(None);
        };
        Ok(Some(Self {
            backing: connect_url(
                &hosted.user_data_url,
                "CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT",
            )?,
        }))
    }

    pub fn client(&self) -> &ClickHouseClient {
        self.backing.client()
    }

    pub async fn migrate(&self) -> AppResult<()> {
        metric_store::ensure_database(&self.backing).await?;
        self.client()
            .query(CONTROL_SCHEMA)
            .execute()
            .await
            .map_err(|err| {
                AppError::internal(format!("clickhouse control migration failed: {err}"))
            })
    }

    pub async fn insert_record(&self, row: &ControlRecordRow) -> AppResult<()> {
        let mut inserter = self.client().insert("instantml_user_data").map_err(|err| {
            AppError::internal(format!("clickhouse control insert init failed: {err}"))
        })?;
        inserter.write(row).await.map_err(|err| {
            AppError::internal(format!("clickhouse control insert write failed: {err}"))
        })?;
        inserter.end().await.map_err(|err| {
            AppError::internal(format!("clickhouse control insert flush failed: {err}"))
        })?;
        Ok(())
    }

    /// Load control records, optionally restricted to those strictly newer than
    /// `since`.
    ///
    /// Passing `None` (or a `since` of the unix epoch) performs the legacy
    /// full-table scan. Once the in-process replay state is warm, callers
    /// supply the previously-observed maximum `created_at` so each refresh
    /// only fetches the churn that landed since then. Without this filter,
    /// every authenticated request that called `refresh_control_records`
    /// triggered an unbounded `SELECT` over the whole control table — under
    /// burst load that overwhelmed ClickHouse Cloud and produced transient
    /// `client error (Connect)` failures (PR #32).
    pub async fn load_records(
        &self,
        since: Option<DateTime<Utc>>,
    ) -> AppResult<Vec<ControlRecordRow>> {
        match since {
            // Treat the unix epoch as "no cursor yet" so first-time loads
            // still see every record, matching the legacy full-scan behavior.
            None => self.load_records_full().await,
            Some(cursor) if cursor.timestamp_micros() <= 0 => self.load_records_full().await,
            Some(cursor) => self.load_records_after(cursor).await,
        }
    }

    async fn load_records_full(&self) -> AppResult<Vec<ControlRecordRow>> {
        self.client()
            .query(
                "SELECT event_id, scope, kind, org_id, entity_id, payload, created_at \
                 FROM instantml_user_data \
                 ORDER BY created_at ASC, event_id ASC",
            )
            .fetch_all::<ControlRecordRow>()
            .await
            .map_err(|err| AppError::internal(format!("clickhouse control query failed: {err}")))
    }

    async fn load_records_after(&self, since: DateTime<Utc>) -> AppResult<Vec<ControlRecordRow>> {
        self.client()
            .query(
                "SELECT event_id, scope, kind, org_id, entity_id, payload, created_at \
                 FROM instantml_user_data \
                 WHERE created_at > parseDateTime64BestEffort(?, 6, 'UTC') \
                 ORDER BY created_at ASC, event_id ASC",
            )
            .bind(since.to_rfc3339())
            .fetch_all::<ControlRecordRow>()
            .await
            .map_err(|err| AppError::internal(format!("clickhouse control query failed: {err}")))
    }

    pub async fn ready(&self) -> bool {
        self.client().query("SELECT 1").execute().await.is_ok()
    }
}

const CONTROL_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS instantml_user_data (
    event_id   UUID,
    scope      LowCardinality(String),
    kind       LowCardinality(String),
    org_id     UUID,
    entity_id  String,
    payload    String CODEC(ZSTD(3)),
    created_at DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (scope, kind, org_id, entity_id, created_at, event_id)
SETTINGS index_granularity = 8192";
