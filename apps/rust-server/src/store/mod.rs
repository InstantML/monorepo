use std::collections::{BTreeMap, BTreeSet, HashMap};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    postgres::{PgPoolOptions, PgRow},
    types::Json,
    FromRow, PgPool, Postgres, QueryBuilder, Row, Transaction,
};
use uuid::Uuid;

use crate::{
    artifact_store::LocalArtifactStore,
    auth::{generate_api_key, generate_session_token, hash_idempotency, hash_secret},
    config::AppConfig,
    domain::{
        validate_account_type, validate_email, validate_json_object, validate_limit,
        validate_membership_role, validate_name, validate_offset, validate_optional_name,
        validate_optional_step, validate_plan_tier, validate_slug, validate_status, validate_step,
        validate_tags, validate_timestamp, ArtifactRow, AttributeInput, AttributeRow, AuthContext,
        AuthSessionPayload, CreateApiKeyRequest, CreateArtifactRequest, CreateAttributesRequest,
        CreateObjectRequest, CreateOrganizationRequest, CreateProjectRequest, CreateRunRequest,
        CreateUserRequest, CreatedAuthSession, DevGoogleAuthRequest, LogMetricsRequest,
        MembershipRow, MetricPointRow, MetricSeriesRow, OrganizationRow, ProjectRow,
        PublicApiKeyRow, RequestContext, ReserveSeatRequest, RunRow, ServiceAccountRow,
        UpdateRunRequest, UploadArtifactRequest, UserRow, UserSessionRow, DEFAULT_METRIC_LIMIT,
        DEFAULT_RUN_LIMIT, MAX_METRICS_PER_BATCH, MAX_METRIC_LIMIT, MAX_METRIC_SERIES_RUN_IDS,
        MAX_RUN_LIMIT, MAX_TEXT_BYTES,
    },
    errors::{AppError, AppResult},
    metric_store::{MetricPointRow as ChMetricPointRow, MetricStore},
};

mod artifacts;
mod auth_admin;
mod comparison;
mod demo;
mod export;
mod imports;
mod metrics;
mod objects;
mod projects;
mod runs;
mod usage;

use artifacts::{
    artifact_row_value, fetch_artifact_for_run_tx, insert_artifact_attribute_tx,
    insert_artifact_tx, validate_artifact_type, validate_size_bytes, ArtifactInsert,
};
use metrics::{build_metric_point_rows_from_pairs, validate_metric_value};
use objects::{
    attribute_row_value, insert_attribute_input_tx, insert_attribute_tx,
    insert_table_object_rows_tx, merge_media_summary, validate_attribute_type,
    validate_attribute_value,
};
use projects::{create_project_inner, create_project_inner_tx, fetch_project_by_id};
use runs::{
    ensure_project_access, ensure_run_access, ensure_unrestricted_org_key, fetch_run,
    metric_series_for_runs_limited, series_row_from_aggregate, side_by_side_attributes,
};

pub use artifacts::{
    create_artifact, get_artifact, get_artifact_for_context, list_artifacts, upload_artifact,
};
pub use auth_admin::{
    authenticate_api_key, authenticate_session, create_api_key, create_api_key_for_user,
    create_dev_google_session, create_organization, create_user, disable_service_account,
    list_api_keys, list_organizations, list_users, require_org_admin, reserve_seat, revoke_api_key,
    revoke_session,
};
pub use comparison::side_by_side;
pub use demo::reset_demo;
pub use export::export_data;
pub use imports::{import_payload, list_imports};
pub use metrics::{get_metrics, log_metrics, metrics_series_batched};
pub use objects::{
    create_attributes, create_object, list_attributes, list_object_rows, list_objects,
};
pub use projects::{create_project, list_projects};
pub use runs::{create_run, get_run, list_runs, overview, runs_summary, update_run};
pub use usage::{
    usage_export, usage_summary, write_usage_daily_snapshot, write_usage_daily_snapshots,
};

pub const LOCAL_ORG_ID: Uuid = Uuid::from_u128(1);
const LOCAL_ORG_SLUG: &str = "local";
const MAX_SIDE_BY_SIDE_RUNS: usize = 50;
const MAX_EXPORT_RUNS: i64 = 500;
const MAX_EXPORT_METRICS: i64 = 100_000;
const MAX_EXPORT_ATTRIBUTES: i64 = 25_000;
const MAX_EXPORT_ARTIFACTS: i64 = 10_000;
const MAX_EXPORT_TABLE_OBJECT_ROWS: i64 = 25_000;
const MAX_ARTIFACT_LIST: i64 = 1_000;
const DEFAULT_OBJECT_LIMIT: i64 = 100;
const MAX_OBJECT_LIMIT: i64 = 500;
const DEFAULT_OBJECT_ROW_LIMIT: i64 = 100;
const MAX_OBJECT_ROW_LIMIT: i64 = 1_000;
const MAX_OBJECT_METADATA_BYTES: usize = 16_384;
const MAX_OBJECT_SUMMARY_BYTES: usize = 16_384;
const MAX_TABLE_ROWS_PER_CREATE: usize = 1_000;
const MAX_TABLE_ROW_BYTES: usize = 16_384;
const MAX_TABLE_COLUMNS: usize = 128;
const MAX_HISTOGRAM_BINS: usize = 1_024;
const MAX_IMPORT_LIST: i64 = 500;
const MAX_SIDE_BY_SIDE_ROWS: usize = 5_000;
const DEMO_RUN_COUNT: usize = 1_000;
const DEMO_STEPS: [i64; 6] = [0, 40, 80, 120, 160, 200];
const DEMO_INSERT_CHUNK: usize = 10_000;
const MAX_SEARCH_TOKENS: usize = 8;
const RUN_CURSOR_VERSION: u8 = 1;
const MAX_RUN_CURSOR_BYTES: usize = 2_048;
const DEFAULT_API_KEY_SCOPES: &[&str] = &[
    "sdk:ingest",
    "artifacts:write",
    "imports:write",
    "export:read",
];
const ALLOWED_SCOPES: &[&str] = &[
    "sdk:ingest",
    "artifacts:write",
    "imports:write",
    "usage:read",
    "export:read",
    "api_keys:write",
];
const ONBOARDING_API_KEY_SCOPES: &[&str] = &["sdk:ingest", "artifacts:write", "export:read"];
const SESSION_TTL_DAYS: i64 = 30;

pub async fn connect(config: &AppConfig) -> AppResult<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(config.database_acquire_timeout)
        .connect(&config.database_url)
        .await?;
    ensure_local_org(&pool).await?;
    Ok(pool)
}

pub async fn migrate(database_url: &str) -> AppResult<()> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|error| {
            tracing::error!(error = ?error, "migration failed");
            AppError::internal("migration failed")
        })?;
    ensure_local_org(&pool).await?;
    Ok(())
}

pub async fn ensure_local_org(pool: &PgPool) -> AppResult<()> {
    sqlx::query(
        r#"
        insert into organizations (id, slug, name, plan_tier, created_at)
        values ($1, $2, 'Local', 'free', '1970-01-01T00:00:00Z')
        on conflict (id) do nothing
        "#,
    )
    .bind(LOCAL_ORG_ID)
    .bind(LOCAL_ORG_SLUG)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn ready(pool: &PgPool) -> bool {
    sqlx::query_scalar::<_, i32>("select 1")
        .fetch_one(pool)
        .await
        .is_ok()
}

pub fn require_unrestricted_org_access(ctx: &RequestContext) -> AppResult<()> {
    runs::ensure_unrestricted_org_key(ctx)
}

pub async fn delete_expired_idempotency(pool: &PgPool) -> AppResult<u64> {
    let result = sqlx::query("delete from idempotency_keys where expires_at < now()")
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

pub async fn delete_expired_or_revoked_sessions(pool: &PgPool) -> AppResult<u64> {
    let result =
        sqlx::query("delete from user_sessions where expires_at < now() or revoked_at is not null")
            .execute(pool)
            .await?;
    Ok(result.rows_affected())
}

async fn audit_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Option<Uuid>,
    action: &str,
    metadata: Value,
) -> AppResult<()> {
    sqlx::query("insert into audit_events (org_id, action, metadata) values ($1, $2, $3)")
        .bind(org_id)
        .bind(action)
        .bind(Json(metadata))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}
