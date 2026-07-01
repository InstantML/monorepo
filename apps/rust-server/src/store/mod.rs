use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    env,
    sync::Arc,
    time::{Duration as StdDuration, Instant},
};

mod access;
mod admin;
mod artifact_versions;
mod auth;
mod billing;
mod console_logs;
mod demo;
mod device_code;
mod embed;
mod export;
mod imports;
mod objects;
mod reports;
mod runs;
mod summaries;
mod system_usage;
mod tenants;
mod usage;
mod validation;
mod workspace_views;

use access::*;
pub use admin::*;
pub use artifact_versions::*;
pub use auth::*;
pub use billing::*;
pub use console_logs::*;
pub use demo::*;
pub use device_code::*;
pub use embed::*;
pub use export::*;
pub use imports::*;
pub use objects::*;
pub use reports::*;
pub use runs::*;
use summaries::*;
pub use system_usage::*;
pub use tenants::TenantRouteRecord;
pub use usage::*;
use validation::*;
pub use workspace_views::*;

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::{
    artifact_store::{prepare_base64_artifact, ArtifactByteStore, StoredArtifact},
    auth::{generate_api_key, generate_session_token, hash_idempotency, hash_secret},
    config::{
        AppConfig, ByocClickHouseConfig, CellRoutingConfig, HostedClickHouseConfig,
        ServicePlaneRole,
    },
    control_db::ControlDb,
    control_repo::{
        ApiKeyWithHash, DataCellWriterLeaseAcquire, DataCellWriterLeaseObservation,
        DataCellWriterLeaseRelease, DataCellWriterLeaseRenewal, NewSession, TenantRoutePlacement,
    },
    domain::{
        is_personal_account_type, plan_tier, validate_account_type, validate_email,
        validate_json_object, validate_limit, validate_membership_role, validate_name,
        validate_offset, validate_optional_name, validate_optional_step, validate_plan_tier,
        validate_slug, validate_status, validate_step, validate_tags, validate_timestamp,
        AbortArtifactUploadRequest, ArtifactAliasRow, ArtifactCollectionRow, ArtifactEdgeRow,
        ArtifactManifestEntriesRecord, ArtifactManifestEntryRow, ArtifactRow, ArtifactUploadFile,
        ArtifactUploadSessionRow, ArtifactVersionRow, AttributeInput, AttributeRow, AuthContext,
        AuthSessionPayload, BillingAccountProjection, BillingCancelRequest, BillingChangeIntent,
        BillingCheckoutInfo, BillingCheckoutIntent, BillingCheckoutRequest,
        BillingCheckoutSyncRequest, BillingEventRecord, BillingPlanChangeRequest,
        BillingPortalRequest, BillingSeatChangeRequest, BillingSubscriptionRecord,
        BillingUsageReportRecord, ClerkAuthRequest, ClickHouseConnectionCreateRequest,
        ClickHouseConnectionRotateCredentialsRequest, ClickHouseConnectionStatus,
        ClickHouseConnectionValidateRequest, ClickHouseConnectionValidationResponse,
        CompareMatchingRunsRequest, CompleteArtifactUploadFile, CompleteArtifactUploadRequest,
        ConsoleLogInput, CreateApiKeyRequest, CreateArtifactInputEdgeRequest,
        CreateArtifactRequest, CreateAttributesRequest, CreateConsoleLogsRequest,
        CreateCurrentUserOrganizationRequest, CreateEmbedSessionRequest,
        CreateEmbedSessionResponse, CreateInvitationRequest, CreateObjectRequest,
        CreateOrganizationRequest, CreateProjectRequest, CreateReportRequest, CreateRunForkRequest,
        CreateRunRequest, CreateUserRequest, CreatedAuthSession,
        CurrentUserOrganizationCreateResponse, DashboardPreferenceRow, DataCellRow,
        DataCellWriterLeaseRow, DeleteArtifactAliasRequest, DeleteArtifactVersionRequest,
        DevGoogleAuthRequest, EmailDeliveryRow, EmbedAuthContext, EmbedCurrentSession,
        EmbedCurrentSessionResponse, EmbedFramePolicy, EmbedFramePolicyResponse,
        EmbedRunsDataRequest, EmbedSessionOptions, EmbedSessionRow, ImportWorkspaceViewRequest,
        InitialInvitationCreateResult, InitialOrganizationInvitation,
        InitiateArtifactUploadRequest, InvitationPreviewPayload, InvitationTokenRequest,
        LogMetricsRequest, LogRankMetricsRequest, MembershipRow, MetricSeriesRow, OnboardingApiKey,
        OrgInvitationRow, OrganizationMembershipSummary, OrganizationRoleCapabilities,
        OrganizationRow, ProjectRow, ProvisioningStatusPayload, PublicApiKeyRow,
        PublicEmbedSession, PublicInvitationRow, RankCoveragePoint, RankHeatmapPoint,
        RankMetricLimits, RankMetricTruncation, RankMetricsSummaryResponse, RankOutlierPoint,
        RankReducerPoint, RenewArtifactUploadRequest, ReportRow, RequestContext,
        ReserveSeatRequest, RunControlRow, RunRow, SaveWorkspaceViewRequest, SeatRow, SeatUserRow,
        ServiceAccountRow, SessionContext, SetArtifactAliasRequest, StopAckRequest, StopRunRequest,
        StopRunsRequest, UpdateArtifactRetentionRequest, UpdateDashboardPreferencesRequest,
        UpdateReportRequest, UpdateRunRequest, UploadArtifactRequest, UserRow, UserSessionRow,
        VersionedArtifactManifestEntryInput, WorkspaceViewData, WorkspaceViewDataLimits,
        WorkspaceViewDataOptions, WorkspaceViewDataPanelResult, WorkspaceViewDataRequest,
        WorkspaceViewDataResponse, WorkspaceViewDeleteResponse, WorkspaceViewExportEnvelope,
        WorkspaceViewExportIntegrity, WorkspaceViewExportSource, WorkspaceViewExportedView,
        WorkspaceViewImportResponse, WorkspaceViewMetricSeries, WorkspaceViewRow,
        WorkspaceViewSummary, BILLING_CANCELED, BILLING_CHECKOUT_PENDING, BILLING_FREE_ACTIVE,
        BILLING_PAID_ACTIVE, BILLING_PAST_DUE_GRACE, BILLING_READ_ONLY_PAYMENT_REQUIRED,
        DEFAULT_CONSOLE_LOG_LIMIT, DEFAULT_METRIC_LIMIT, DEFAULT_RUN_LIMIT, GIB_BYTES,
        MAX_CONSOLE_LOG_LIMIT, MAX_CONSOLE_LOG_LINES_PER_BATCH, MAX_CONSOLE_LOG_MESSAGE_BYTES,
        MAX_METRICS_PER_BATCH, MAX_METRIC_LIMIT, MAX_METRIC_SERIES_RUN_IDS,
        MAX_METRIC_SERIES_TOTAL_POINTS, MAX_RANK_CANONICAL_ROWS, MAX_RANK_HEATMAP_CELLS,
        MAX_RANK_OUTLIERS, MAX_RANK_WORLD_SIZE, MAX_RUN_LIMIT, MAX_TEXT_BYTES, PLAN_FREE,
        PLAN_PREMIUM, PLAN_PRO, STORAGE_CHOICE_CUSTOMER_CLICKHOUSE, STORAGE_CHOICE_HOSTED,
        STORAGE_STATE_LOCKED, STORAGE_STATE_READY, STORAGE_STATE_UNCONFIGURED,
        STORAGE_STATE_VALIDATING,
    },
    errors::{AppError, AppResult},
    metric_store::{
        ConsoleLogInsertRow, ConsoleLogReadRow, M4BucketRow, MetricPointRow as ChMetricPointRow,
        MetricStore, OperationalRecordRow, RankMetricCanonicalRow,
        RankMetricPointRow as ChRankMetricPointRow, RankMetricStepWindow, SeriesReadRow,
        SeriesSortMode, SystemUsageAggregateRow,
    },
};

pub const LOCAL_ORG_ID: Uuid = Uuid::from_u128(1);
const LOCAL_ORG_SLUG: &str = "local";
const DEFAULT_API_KEY_SCOPES: &[&str] = &[
    "sdk:ingest",
    "artifacts:write",
    "imports:write",
    "export:read",
];
const ONBOARDING_API_KEY_SCOPES: &[&str] = &["sdk:ingest", "artifacts:write", "export:read"];
const DEMO_API_KEY_SCOPES: &[&str] = &["export:read"];
const ALLOWED_SCOPES: &[&str] = &[
    "sdk:ingest",
    "artifacts:write",
    "artifacts:manage",
    "imports:write",
    "usage:read",
    "export:read",
    "api_keys:write",
    "runs:control",
];
const MAX_BULK_STOP_RUNS: usize = 100;
const SESSION_TTL_DAYS: i64 = 30;
const MAX_EXPORT_RUNS: usize = 500;
const MAX_RUN_FILTER_CACHE_ENTRIES: usize = 64;
const MAX_EXPORT_SELECTED_RUN_IDS: usize = 100;
const MAX_EXPORT_METRICS: i64 = 100_000;
const MAX_EXPORT_METRIC_SERIES: usize = 25_000;
const MAX_EXPORT_ATTRIBUTES: usize = 25_000;
const MAX_EXPORT_ARTIFACTS: usize = 10_000;
const MAX_EXPORT_TABLE_OBJECT_ROWS: usize = 25_000;
const MAX_EXPORT_CSV_BYTES: usize = 25 * 1024 * 1024;
const MAX_SIDE_BY_SIDE_RUNS: usize = 50;
const MAX_SIDE_BY_SIDE_ROWS: usize = 5_000;
const MAX_ARTIFACT_LIST: i64 = 1_000;
const DEFAULT_OBJECT_LIMIT: i64 = 100;
const MAX_OBJECT_LIMIT: i64 = 500;
const DEFAULT_OBJECT_ROW_LIMIT: i64 = 100;
const MAX_OBJECT_ROW_LIMIT: i64 = 1_000;
const MAX_OBJECT_METADATA_BYTES: usize = 16_384;
const MAX_OBJECT_SUMMARY_BYTES: usize = 16_384;
const MAX_OBJECT_VALUE_BYTES: usize = 64 * 1024;
const MAX_TABLE_ROWS_PER_CREATE: usize = 1_000;
const MAX_TABLE_ROW_BYTES: usize = 16_384;
const MAX_TABLE_COLUMNS: usize = 128;
const MAX_HISTOGRAM_BINS: usize = 1_024;
const MAX_EVAL_JSON_DEPTH: usize = 8;
const MAX_EVAL_STRING_BYTES: usize = 1_024;
const MAX_EVAL_CLASS_NAME_BYTES: usize = 128;
const MAX_EVAL_SAMPLE_COUNT: u64 = 1_000_000;
const MAX_EVAL_CURVE_POINTS: usize = 200;
const MAX_EVAL_PREDICTION_ROWS: usize = 100;
const MAX_EVAL_PREDICTION_ROW_BYTES: usize = 2_048;
const MAX_IMPORT_LIST: i64 = 500;
const DEMO_RUN_COUNT: usize = 1_000;
const DEMO_STEPS: [i64; 6] = [0, 40, 80, 120, 160, 200];

#[derive(Clone)]
pub struct Store {
    metric_store: MetricStore,
    /// Postgres control plane. When present, it is the system of record for
    /// users/orgs/memberships/sessions/keys/billing/tenant routes. `None` is
    /// only allowed for non-hosted local mode, which stores its local bootstrap
    /// records in the primary operational record table.
    control_db: Option<ControlDb>,
    hosted_clickhouse: Option<HostedClickHouseConfig>,
    byoc_clickhouse: ByocClickHouseConfig,
    cell_routing: CellRoutingConfig,
    data_cell_writer_runtime: DataCellWriterLeaseRuntime,
    data_cell_writer_lease: Arc<Mutex<DataCellWriterLeaseState>>,
    data_cell_writer_refresh_lock: Arc<Mutex<()>>,
    tenant_metric_stores: Arc<Mutex<HashMap<Uuid, MetricStore>>>,
    customer_tenant_endpoints: Arc<Mutex<HashMap<Uuid, String>>>,
    tenant_loaded: Arc<Mutex<BTreeSet<Uuid>>>,
    /// MetricStore wired to the shared ClickHouse cell.
    /// All personal/free orgs route here instead of getting a dedicated service.
    shared_cell_metric_store: Option<MetricStore>,
    inflight_idempotency: Arc<Mutex<BTreeSet<(Uuid, String)>>>,
    artifact_upload_capacity_lock: Arc<Mutex<()>>,
    data: Arc<Mutex<StoreData>>,
    record_clock_micros: Arc<Mutex<i64>>,
    control_projection_loaded: Arc<Mutex<bool>>,
    last_control_refresh_error: Arc<Mutex<Option<String>>>,
    /// Coalesces calls to `refresh_control_records` so a burst of explicit
    /// refreshes does not hammer Postgres while a background refresh is already
    /// keeping the data plane current.
    last_control_refresh: Arc<Mutex<Option<Instant>>>,
}

const CONTROL_REFRESH_MIN_INTERVAL: StdDuration = StdDuration::from_secs(2);
const DATA_CELL_WRITER_LEASE_DEFAULT_TTL_SECS: i64 = 30;
const DATA_CELL_WRITER_LEASE_POSITIVE_CACHE: StdDuration = StdDuration::from_millis(500);
const DATA_CELL_WRITER_LEASE_NEGATIVE_CACHE: StdDuration = StdDuration::from_millis(250);

/// Cadence for the data-plane background refresh task.
///
/// 2s matches the throttle in `refresh_control_records` and bounds the worst-case
/// staleness for security-sensitive control changes (api-key revocation, seat
/// removal). If this becomes a load problem, the right fix is push-based
/// invalidation (Tier 3), not a longer interval.
const CONTROL_REFRESH_BACKGROUND_INTERVAL: StdDuration = StdDuration::from_secs(2);

#[derive(Clone, Debug)]
struct DataCellWriterLeaseRuntime {
    holder_instance_id: String,
    service_name: String,
    revision: String,
    ttl: ChronoDuration,
    renew_interval: StdDuration,
}

impl DataCellWriterLeaseRuntime {
    fn from_env() -> AppResult<Self> {
        let ttl_seconds = env::var("INSTANTML_CELL_WRITER_LEASE_TTL_SECONDS")
            .ok()
            .map(|value| {
                value.trim().parse::<i64>().map_err(|_| {
                    AppError::config(
                        "INSTANTML_CELL_WRITER_LEASE_TTL_SECONDS must be a positive integer",
                    )
                })
            })
            .transpose()?
            .unwrap_or(DATA_CELL_WRITER_LEASE_DEFAULT_TTL_SECS);
        if ttl_seconds <= 0 {
            return Err(AppError::config(
                "INSTANTML_CELL_WRITER_LEASE_TTL_SECONDS must be greater than zero",
            ));
        }
        let renew_seconds = (ttl_seconds / 3).clamp(1, 10) as u64;
        Ok(Self {
            holder_instance_id: env_label("INSTANTML_INSTANCE_ID")
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            service_name: env_label("K_SERVICE")
                .or_else(|| env_label("INSTANTML_SERVICE_NAME"))
                .unwrap_or_else(|| "instantml-rust-server".to_string()),
            revision: env_label("K_REVISION")
                .or_else(|| env_label("INSTANTML_REVISION"))
                .unwrap_or_else(|| "local".to_string()),
            ttl: ChronoDuration::seconds(ttl_seconds),
            renew_interval: StdDuration::from_secs(renew_seconds),
        })
    }

    #[cfg(test)]
    fn for_tests() -> Self {
        Self {
            holder_instance_id: Uuid::new_v4().to_string(),
            service_name: "instantml-test".to_string(),
            revision: "test".to_string(),
            ttl: ChronoDuration::seconds(DATA_CELL_WRITER_LEASE_DEFAULT_TTL_SECS),
            renew_interval: StdDuration::from_secs(1),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct DataCellWriterLeaseState {
    lease: Option<DataCellWriterLeaseRow>,
    verified_until: Option<Instant>,
    unavailable_cell_id: Option<String>,
    unavailable_until: Option<Instant>,
}

fn env_label(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Clone, Debug, Serialize)]
pub struct DataCellWriterLeaseReadiness {
    pub required: bool,
    pub ready: bool,
    pub code: Option<String>,
}

impl DataCellWriterLeaseReadiness {
    fn not_required() -> Self {
        Self {
            required: false,
            ready: true,
            code: None,
        }
    }

    fn ready() -> Self {
        Self {
            required: true,
            ready: true,
            code: None,
        }
    }

    fn unavailable(error: AppError) -> Self {
        Self {
            required: true,
            ready: false,
            code: Some(error.safe_code().to_string()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum DataCellWriterLeaseRequirement {
    NotRequired,
    MissingControlDb,
    MissingCellId,
    Required { cell_id: String },
}

fn writer_lease_cache_ttl(lease: &DataCellWriterLeaseRow) -> StdDuration {
    // `expires_at` is stamped by Postgres `clock_timestamp()` while this cache
    // uses the app clock; the 100ms margin assumes normal app/Postgres clock
    // skew stays below that bound.
    let remaining = lease
        .expires_at
        .signed_duration_since(Utc::now())
        .to_std()
        .unwrap_or(StdDuration::ZERO)
        .saturating_sub(StdDuration::from_millis(100));
    remaining.min(DATA_CELL_WRITER_LEASE_POSITIVE_CACHE)
}

impl Store {
    pub async fn connect(
        metric_store: MetricStore,
        control_db: Option<ControlDb>,
        hosted_clickhouse: Option<HostedClickHouseConfig>,
        byoc_clickhouse: ByocClickHouseConfig,
        cell_routing: CellRoutingConfig,
    ) -> AppResult<Self> {
        if hosted_clickhouse.is_some() && control_db.is_none() {
            return Err(AppError::config(
                "DATABASE_URL is required when hosted ClickHouse routing is enabled",
            ));
        }
        // Build the shared-cell MetricStore when INSTANTML_SHARED_CELL_URL is set.
        let shared_cell_metric_store =
            build_shared_cell_metric_store(hosted_clickhouse.as_ref()).await?;
        let data_cell_writer_runtime = DataCellWriterLeaseRuntime::from_env()?;
        let store = Self {
            metric_store,
            control_db,
            hosted_clickhouse,
            byoc_clickhouse,
            cell_routing,
            data_cell_writer_runtime,
            data_cell_writer_lease: Arc::new(Mutex::new(DataCellWriterLeaseState::default())),
            data_cell_writer_refresh_lock: Arc::new(Mutex::new(())),
            tenant_metric_stores: Arc::new(Mutex::new(HashMap::new())),
            customer_tenant_endpoints: Arc::new(Mutex::new(HashMap::new())),
            tenant_loaded: Arc::new(Mutex::new(BTreeSet::new())),
            shared_cell_metric_store,
            inflight_idempotency: Arc::new(Mutex::new(BTreeSet::new())),
            artifact_upload_capacity_lock: Arc::new(Mutex::new(())),
            data: Arc::new(Mutex::new(StoreData::default())),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        };
        if let Some(control_db) = &store.control_db {
            store
                .refresh_current_data_cell_registration(control_db)
                .await?;
        }
        store.rebuild().await?;
        if !store.hosted_clickhouse_enabled() {
            store.ensure_local_org().await?;
        }
        Ok(store)
    }

    /// Returns the MetricStore for the shared cell, if one is configured.
    pub fn shared_cell_metric_store(&self) -> Option<&MetricStore> {
        self.shared_cell_metric_store.as_ref()
    }

    pub fn metric_store(&self) -> &MetricStore {
        &self.metric_store
    }

    /// The Postgres control plane, when configured. Auth/org/billing store
    /// methods route through this; `None` is local non-hosted mode.
    pub fn control_db(&self) -> Option<&ControlDb> {
        self.control_db.as_ref()
    }

    pub async fn ensure_data_cell_writer_lease_for_mutation(
        &self,
        service_plane: ServicePlaneRole,
    ) -> AppResult<bool> {
        self.ensure_data_cell_writer_lease(service_plane)
            .await
            .map(|lease| lease.is_some())
    }

    pub fn data_cell_writer_lease_renew_interval(&self) -> StdDuration {
        self.data_cell_writer_runtime.renew_interval
    }

    pub async fn data_cell_writer_lease_readiness(
        &self,
        service_plane: ServicePlaneRole,
    ) -> DataCellWriterLeaseReadiness {
        let requirement = self.data_cell_writer_lease_requirement(service_plane);
        match requirement {
            DataCellWriterLeaseRequirement::NotRequired => {
                DataCellWriterLeaseReadiness::not_required()
            }
            DataCellWriterLeaseRequirement::MissingControlDb => {
                DataCellWriterLeaseReadiness::unavailable(AppError::cell_writer_unavailable(
                    "hosted data plane requires DATABASE_URL before writes are enabled",
                ))
            }
            DataCellWriterLeaseRequirement::MissingCellId => {
                DataCellWriterLeaseReadiness::unavailable(AppError::cell_writer_unavailable(
                    "hosted data plane requires INSTANTML_CELL_ID before writes are enabled",
                ))
            }
            DataCellWriterLeaseRequirement::Required { cell_id } => {
                if self.cached_data_cell_writer_lease(&cell_id).await.is_some() {
                    return DataCellWriterLeaseReadiness::ready();
                }
                match self.observe_data_cell_writer_lease(&cell_id).await {
                    Ok(true) => DataCellWriterLeaseReadiness::ready(),
                    Ok(false) => DataCellWriterLeaseReadiness::unavailable(
                        AppError::cell_writer_unavailable("data-cell writer lease is not held"),
                    ),
                    Err(error) => DataCellWriterLeaseReadiness::unavailable(error),
                }
            }
        }
    }

    pub async fn release_data_cell_writer_lease(
        &self,
        service_plane: ServicePlaneRole,
    ) -> AppResult<bool> {
        let DataCellWriterLeaseRequirement::Required { cell_id: _ } =
            self.data_cell_writer_lease_requirement(service_plane)
        else {
            return Ok(false);
        };
        let Some(control_db) = &self.control_db else {
            return Err(AppError::cell_writer_unavailable(
                "hosted data plane requires DATABASE_URL before writes are enabled",
            ));
        };
        let _refresh_guard = self.data_cell_writer_refresh_lock.lock().await;
        let lease = {
            let mut state = self.data_cell_writer_lease.lock().await;
            state.verified_until = None;
            state.lease.take()
        };
        let Some(lease) = lease else {
            return Ok(false);
        };
        control_db
            .release_data_cell_writer_lease(&DataCellWriterLeaseRelease {
                cell_id: lease.cell_id.clone(),
                holder_instance_id: lease.holder_instance_id.clone(),
                fence_token: lease.fence_token,
            })
            .await
            .map_err(|error| self.writer_lease_guard_error(&lease.cell_id, error))?;
        Ok(true)
    }

    async fn ensure_data_cell_writer_lease(
        &self,
        service_plane: ServicePlaneRole,
    ) -> AppResult<Option<DataCellWriterLeaseRow>> {
        let cell_id = match self.data_cell_writer_lease_requirement(service_plane) {
            DataCellWriterLeaseRequirement::NotRequired => return Ok(None),
            DataCellWriterLeaseRequirement::MissingControlDb => {
                return Err(AppError::cell_writer_unavailable(
                    "hosted data plane requires DATABASE_URL before writes are enabled",
                ));
            }
            DataCellWriterLeaseRequirement::MissingCellId => {
                return Err(AppError::cell_writer_unavailable(
                    "hosted data plane requires INSTANTML_CELL_ID before writes are enabled",
                ));
            }
            DataCellWriterLeaseRequirement::Required { cell_id } => cell_id,
        };
        let Some(control_db) = &self.control_db else {
            return Err(AppError::cell_writer_unavailable(
                "hosted data plane requires DATABASE_URL before writes are enabled",
            ));
        };
        if let Some(lease) = self.cached_data_cell_writer_lease(&cell_id).await {
            return Ok(Some(lease));
        }
        if self.cached_data_cell_writer_unavailable(&cell_id).await {
            return Err(AppError::cell_writer_unavailable(
                "data-cell writer lease is not available",
            ));
        }
        let _refresh_guard = self.data_cell_writer_refresh_lock.lock().await;
        if let Some(lease) = self.cached_data_cell_writer_lease(&cell_id).await {
            return Ok(Some(lease));
        }
        if self.cached_data_cell_writer_unavailable(&cell_id).await {
            return Err(AppError::cell_writer_unavailable(
                "data-cell writer lease is not available",
            ));
        }
        let previous = {
            let state = self.data_cell_writer_lease.lock().await;
            state
                .lease
                .as_ref()
                .filter(|lease| lease.cell_id == cell_id)
                .cloned()
        };
        let lease = if let Some(previous) = previous {
            match control_db
                .renew_data_cell_writer_lease(&DataCellWriterLeaseRenewal {
                    cell_id: cell_id.clone(),
                    holder_instance_id: previous.holder_instance_id,
                    fence_token: previous.fence_token,
                    ttl: self.data_cell_writer_runtime.ttl,
                })
                .await
            {
                Ok(lease) => lease,
                Err(error) if error.safe_code() == "cell_writer_unavailable" => {
                    self.acquire_data_cell_writer_lease(control_db, &cell_id)
                        .await?
                }
                Err(error) => return Err(self.writer_lease_guard_error(&cell_id, error)),
            }
        } else {
            self.acquire_data_cell_writer_lease(control_db, &cell_id)
                .await?
        };
        self.store_data_cell_writer_lease(lease.clone()).await;
        Ok(Some(lease))
    }

    async fn observe_data_cell_writer_lease(&self, cell_id: &str) -> AppResult<bool> {
        let Some(control_db) = &self.control_db else {
            return Err(AppError::cell_writer_unavailable(
                "hosted data plane requires DATABASE_URL before writes are enabled",
            ));
        };
        let previous = {
            let state = self.data_cell_writer_lease.lock().await;
            state
                .lease
                .as_ref()
                .filter(|lease| lease.cell_id == cell_id)
                .cloned()
        };
        let Some(previous) = previous else {
            return Ok(false);
        };
        let observed = control_db
            .observe_data_cell_writer_lease(&DataCellWriterLeaseObservation {
                cell_id: cell_id.to_string(),
                holder_instance_id: previous.holder_instance_id.clone(),
                fence_token: previous.fence_token,
            })
            .await
            .map_err(|error| self.writer_lease_guard_error(cell_id, error))?;
        match observed {
            Some(lease) => {
                self.store_data_cell_writer_lease(lease).await;
                Ok(true)
            }
            None => {
                let mut state = self.data_cell_writer_lease.lock().await;
                state.verified_until = None;
                Ok(false)
            }
        }
    }

    async fn acquire_data_cell_writer_lease(
        &self,
        control_db: &ControlDb,
        cell_id: &str,
    ) -> AppResult<DataCellWriterLeaseRow> {
        let result = control_db
            .acquire_data_cell_writer_lease(&DataCellWriterLeaseAcquire {
                cell_id: cell_id.to_string(),
                holder_instance_id: self.data_cell_writer_runtime.holder_instance_id.clone(),
                service_name: self.data_cell_writer_runtime.service_name.clone(),
                revision: self.data_cell_writer_runtime.revision.clone(),
                ttl: self.data_cell_writer_runtime.ttl,
            })
            .await
            .map_err(|error| self.writer_lease_guard_error(cell_id, error));
        if result
            .as_ref()
            .is_err_and(|error| error.safe_code() == "cell_writer_unavailable")
        {
            self.store_data_cell_writer_unavailable(cell_id).await;
        }
        result
    }

    async fn cached_data_cell_writer_lease(&self, cell_id: &str) -> Option<DataCellWriterLeaseRow> {
        let state = self.data_cell_writer_lease.lock().await;
        let lease = state
            .lease
            .as_ref()
            .filter(|lease| lease.cell_id == cell_id)?;
        let verified_until = state.verified_until?;
        (verified_until > Instant::now()).then(|| lease.clone())
    }

    async fn cached_data_cell_writer_unavailable(&self, cell_id: &str) -> bool {
        let state = self.data_cell_writer_lease.lock().await;
        state
            .unavailable_cell_id
            .as_deref()
            .filter(|cached_cell_id| *cached_cell_id == cell_id)
            .zip(state.unavailable_until)
            .is_some_and(|(_, unavailable_until)| unavailable_until > Instant::now())
    }

    async fn store_data_cell_writer_lease(&self, lease: DataCellWriterLeaseRow) {
        let mut state = self.data_cell_writer_lease.lock().await;
        state.verified_until = Some(Instant::now() + writer_lease_cache_ttl(&lease));
        state.lease = Some(lease);
        state.unavailable_cell_id = None;
        state.unavailable_until = None;
    }

    async fn store_data_cell_writer_unavailable(&self, cell_id: &str) {
        let mut state = self.data_cell_writer_lease.lock().await;
        state.verified_until = None;
        state.unavailable_cell_id = Some(cell_id.to_string());
        state.unavailable_until = Some(Instant::now() + DATA_CELL_WRITER_LEASE_NEGATIVE_CACHE);
    }

    fn data_cell_writer_lease_requirement(
        &self,
        service_plane: ServicePlaneRole,
    ) -> DataCellWriterLeaseRequirement {
        if service_plane != ServicePlaneRole::Data {
            return DataCellWriterLeaseRequirement::NotRequired;
        }
        if self.control_db.is_none() {
            return DataCellWriterLeaseRequirement::MissingControlDb;
        }
        self.cell_routing
            .heartbeat_data_cell_id
            .clone()
            .map(|cell_id| DataCellWriterLeaseRequirement::Required { cell_id })
            .unwrap_or(DataCellWriterLeaseRequirement::MissingCellId)
    }

    pub async fn ensure_org_routed_to_current_data_cell(
        &self,
        org_id: Uuid,
        service_plane: ServicePlaneRole,
    ) -> AppResult<bool> {
        if service_plane != ServicePlaneRole::Data || !self.hosted_clickhouse_enabled() {
            return Ok(false);
        }
        let Some(current_cell_id) = self.cell_routing.heartbeat_data_cell_id.as_deref() else {
            return Err(AppError::cell_writer_unavailable(
                "hosted data plane requires INSTANTML_CELL_ID before writes are enabled",
            ));
        };
        let route_cell = if let Some(control_db) = &self.control_db {
            control_db
                .load_tenant_route(org_id)
                .await
                .map_err(|error| {
                    tracing::warn!(
                        workflow = "data_cell_writer_lease",
                        operation = "route_cell_verify",
                        outcome = "failure",
                        status = error.status().as_u16(),
                        code = error.safe_code(),
                        error_kind = error.safe_code(),
                        retryable = error.retryable(),
                        safe_summary = error.safe_summary(),
                        "failed to verify tenant route cell before hosted data write"
                    );
                    AppError::cell_writer_unavailable(
                        "organization data-cell route could not be verified",
                    )
                })?
                .and_then(|route| route.cell_id)
        } else {
            let data = self.data.lock().await;
            data.tenant_routes
                .get(&org_id)
                .and_then(|route| route.cell_id.clone())
        };
        if let Some(route_cell) = route_cell {
            if route_cell != current_cell_id {
                return Err(AppError::cell_writer_unavailable(
                    "organization is routed to a different data cell",
                ));
            }
        }
        Ok(true)
    }

    fn writer_lease_guard_error(&self, cell_id: &str, error: AppError) -> AppError {
        if error.safe_code() == "cell_writer_unavailable" {
            return error;
        }
        tracing::warn!(
            workflow = "data_cell_writer_lease",
            operation = "verify",
            outcome = "failure",
            status = error.status().as_u16(),
            code = error.safe_code(),
            error_kind = error.safe_code(),
            retryable = error.retryable(),
            safe_summary = error.safe_summary(),
            cell_id,
            "data-cell writer lease verification failed"
        );
        AppError::cell_writer_unavailable(format!(
            "data cell {cell_id} writer lease could not be verified"
        ))
    }

    async fn rebuild(&self) -> AppResult<()> {
        let (data, latest_record_micros) = if let Some(control_db) = &self.control_db {
            // Postgres is the system of record: load the live control state
            // directly. Unlike the event-log replay, startup cost is bounded by
            // the number of live entities, not the lifetime mutation history.
            (self.load_data_from_postgres(control_db).await?, 0)
        } else {
            let records = self.metric_store.load_operational_records().await?;
            let mut data = StoreData::default();
            let stats = data.apply_operational_records(records, ReplayScope::All)?;
            (data, stats.latest_record_micros)
        };
        *self.data.lock().await = data;
        *self.record_clock_micros.lock().await = latest_record_micros;
        self.mark_control_projection_loaded().await;
        Ok(())
    }

    /// Build the in-memory projection from the Postgres control plane. The
    /// projection is currently kept as a read cache that is write-through via
    /// `persist_locked`; a later step flips reads to SQL and removes it.
    async fn load_data_from_postgres(&self, control_db: &ControlDb) -> AppResult<StoreData> {
        let mut data = StoreData::default();
        for user in control_db.list_users().await? {
            data.insert_user(user);
        }
        for identity in control_db.load_identities().await? {
            data.identities.insert(
                (identity.provider, identity.provider_subject),
                identity.user_id,
            );
        }
        for org in control_db.load_orgs().await? {
            data.insert_org(org);
        }
        for membership in control_db.load_memberships().await? {
            data.insert_membership(membership);
        }
        for account in control_db.load_service_accounts().await? {
            data.service_accounts.insert(account.id, account);
        }
        for key in control_db.load_api_keys().await? {
            data.insert_api_key(ApiKeyRecord {
                row: key.row,
                key_hash: key.key_hash,
            });
        }
        for session in control_db.load_embed_sessions().await? {
            data.insert_embed_session(session);
        }
        for session in control_db.load_sessions().await? {
            data.insert_session(SessionRecord {
                row: session.row,
                token_hash: session.token_hash,
            });
        }
        for invitation in control_db.load_org_invitations().await? {
            data.insert_org_invitation(invitation);
        }
        for delivery in control_db.load_email_deliveries().await? {
            data.insert_email_delivery(delivery);
        }
        for pref in control_db.load_dashboard_preferences().await? {
            data.insert_dashboard_preference(pref);
        }
        for view in control_db.load_workspace_views().await? {
            data.insert_workspace_view(view);
        }
        for account in control_db.load_billing_accounts().await? {
            data.insert_billing_account(account);
        }
        for intent in control_db.load_billing_checkout_intents().await? {
            data.insert_billing_checkout_intent(intent);
        }
        for intent in control_db.load_billing_change_intents().await? {
            data.insert_billing_change_intent(intent);
        }
        for subscription in control_db.load_billing_subscriptions().await? {
            data.insert_billing_subscription(subscription);
        }
        for event in control_db.load_billing_events().await? {
            data.insert_billing_event(event);
        }
        for report in control_db.load_billing_usage_reports().await? {
            data.insert_billing_usage_report(report);
        }
        for cell in control_db.load_data_cells().await? {
            data.insert_data_cell(cell);
        }
        for route in control_db.load_tenant_routes().await? {
            data.insert_tenant_route(route);
        }
        data.recompute_counters();
        Ok(data)
    }

    async fn mark_control_projection_loaded(&self) {
        *self.control_projection_loaded.lock().await = true;
        self.mark_control_refresh_success().await;
    }

    async fn mark_control_refresh_success(&self) {
        *self.last_control_refresh_error.lock().await = None;
    }

    async fn mark_control_refresh_failure(&self, message: &str) {
        *self.last_control_refresh_error.lock().await = Some(message.to_string());
    }

    pub async fn control_projection_health(&self) -> ControlProjectionHealth {
        ControlProjectionHealth {
            loaded: *self.control_projection_loaded.lock().await,
            refresh_degraded: self.last_control_refresh_error.lock().await.is_some(),
        }
    }

    /// Spawn a background task that periodically refreshes the in-memory control
    /// projection from Postgres. Returns the join handle so the
    /// caller (typically `main::serve`) can manage shutdown.
    ///
    /// This is the data plane's mechanism for picking up control mutations
    /// (new org, new api key, revoked api key, etc.) made by the control plane.
    /// No-op when no control database is configured (single-binary local mode).
    pub fn spawn_control_refresh_task(&self) -> Option<JoinHandle<()>> {
        self.control_db.as_ref()?;
        let store = self.clone();
        let handle = tokio::spawn(async move {
            // Stagger the first tick so we don't double up with the startup
            // `rebuild()` that already populated the projection.
            tokio::time::sleep(CONTROL_REFRESH_BACKGROUND_INTERVAL).await;
            loop {
                if let Err(error) = store.refresh_control_records().await {
                    tracing::warn!(
                        workflow = "control_refresh",
                        operation = "background_refresh",
                        outcome = "failure",
                        status = error.status().as_u16(),
                        code = error.safe_code(),
                        error_kind = error.safe_code(),
                        retryable = error.retryable(),
                        safe_summary = error.safe_summary(),
                        "background control-record refresh failed; will retry"
                    );
                }
                tokio::time::sleep(CONTROL_REFRESH_BACKGROUND_INTERVAL).await;
            }
        });
        Some(handle)
    }

    pub async fn refresh_control_records(&self) -> AppResult<()> {
        self.refresh_control_records_inner(false).await
    }

    pub async fn refresh_control_records_for_auth_miss(&self) -> AppResult<()> {
        self.refresh_control_records_inner(true).await
    }

    pub async fn load_embed_session_from_control(
        &self,
        session_id: Uuid,
    ) -> AppResult<Option<EmbedSessionRow>> {
        let Some(control_db) = &self.control_db else {
            return Ok(None);
        };
        control_db.load_embed_session(session_id).await
    }

    async fn refresh_control_records_inner(&self, force: bool) -> AppResult<()> {
        // Postgres is the system of record when configured: the data plane
        // re-reads the live control state from it (there is no event-log cursor).
        if let Some(control_db) = &self.control_db {
            return self.refresh_from_postgres(control_db, force).await;
        }
        Ok(())
    }

    /// Refresh the in-memory control projection from Postgres. Reloads the live
    /// control state (bounded by entity count, not history) and swaps only the
    /// control collections into the projection, preserving the data plane's
    /// lazily-loaded tenant data. Tenant-route changes evict the affected
    /// MetricStore caches, matching the ClickHouse refresh path.
    ///
    /// The lock is released across the Postgres read and only reacquired to
    /// apply the result, per the multi-instance lock guidance.
    async fn refresh_from_postgres(&self, control_db: &ControlDb, force: bool) -> AppResult<()> {
        {
            let mut last = self.last_control_refresh.lock().await;
            if !force {
                if let Some(prev) = *last {
                    if prev.elapsed() < CONTROL_REFRESH_MIN_INTERVAL {
                        return Ok(());
                    }
                }
            }
            *last = Some(Instant::now());
        }
        self.refresh_current_data_cell_registration(control_db)
            .await?;
        let fresh = match self.load_data_from_postgres(control_db).await {
            Ok(data) => data,
            Err(error) => {
                self.mark_control_refresh_failure(error.message()).await;
                return Err(error);
            }
        };
        let changed_tenant_routes = {
            let mut data = self.data.lock().await;
            let previous_routes = data.tenant_routes.clone();
            data.adopt_control_projection(fresh);
            changed_tenant_routes(&previous_routes, &data.tenant_routes)
        };
        if !changed_tenant_routes.is_empty() {
            let mut loaded = self.tenant_loaded.lock().await;
            let mut stores = self.tenant_metric_stores.lock().await;
            for org_id in &changed_tenant_routes {
                loaded.remove(org_id);
                stores.remove(org_id);
            }
        }
        self.mark_control_refresh_success().await;
        Ok(())
    }

    async fn refresh_current_data_cell_registration(
        &self,
        control_db: &ControlDb,
    ) -> AppResult<Option<DataCellRow>> {
        let Some(cell) = self.current_data_cell_heartbeat_row(Utc::now()) else {
            return Ok(None);
        };
        let stored = control_db.heartbeat_data_cell(&cell).await?;
        self.data.lock().await.insert_data_cell(stored.clone());
        Ok(Some(stored))
    }

    fn current_data_cell_heartbeat_row(&self, now: DateTime<Utc>) -> Option<DataCellRow> {
        let cell_id = self.cell_routing.heartbeat_data_cell_id.as_ref()?.clone();
        Some(DataCellRow {
            environment: self.cell_routing.environment.clone(),
            region: infer_data_cell_region(&cell_id),
            tier: "standard".to_string(),
            status: "open".to_string(),
            service_name: format!("instantml-data-{cell_id}"),
            public_api_base: None,
            internal_api_base: None,
            clickhouse_endpoint_secret_ref: None,
            clickhouse_username_secret_ref: None,
            clickhouse_password_secret_ref: None,
            clickhouse_database_mode: Some("per-org-database".to_string()),
            max_orgs: None,
            max_metric_points_monthly: None,
            max_api_requests_monthly: None,
            max_retained_bytes: None,
            max_disk_usage_pct: None,
            reserved_headroom_pct: None,
            last_health_at: Some(now),
            last_backup_at: None,
            notes: Some("auto-registered current data cell".to_string()),
            created_at: now,
            updated_at: now,
            cell_id,
        })
    }

    async fn ensure_local_org(&self) -> AppResult<()> {
        let mut data = self.data.lock().await;
        if let Some(existing) = data.organizations.get(&LOCAL_ORG_ID).cloned() {
            if existing.plan_tier != "premium"
                || existing.seat_limit != plan_tier("premium").included_seats
            {
                let org = OrganizationRow {
                    plan_tier: "premium".to_string(),
                    seat_limit: plan_tier("premium").included_seats,
                    ..existing
                };
                self.persist_locked(
                    "organization",
                    LOCAL_ORG_ID,
                    &LOCAL_ORG_ID.to_string(),
                    &org,
                )
                .await?;
                data.insert_org(org);
            }
            return Ok(());
        }
        let org = OrganizationRow {
            id: LOCAL_ORG_ID,
            slug: LOCAL_ORG_SLUG.to_string(),
            name: "Local".to_string(),
            plan_tier: "premium".to_string(),
            account_type: "customer".to_string(),
            seat_limit: plan_tier("premium").included_seats,
            created_by_user_id: None,
            created_at: epoch(),
            // Local dev org uses dedicated (= local) routing.
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        self.persist_locked(
            "organization",
            LOCAL_ORG_ID,
            &LOCAL_ORG_ID.to_string(),
            &org,
        )
        .await?;
        data.insert_org(org);
        Ok(())
    }

    async fn persist_locked<T: Serialize>(
        &self,
        kind: &str,
        org_id: Uuid,
        entity_id: &str,
        payload: &T,
    ) -> AppResult<()> {
        let row = OperationalRecordRow {
            kind: kind.to_string(),
            org_id,
            entity_id: entity_id.to_string(),
            payload: serde_json::to_string(payload)
                .map_err(|_| AppError::internal("operational payload serialization failed"))?,
            created_at: self.next_record_created_at().await,
        };
        // Postgres control plane: when configured it is the system of record for
        // control-plane kinds, replacing the ClickHouse event-log append. Tenant
        // kinds (run/attribute/artifact/...) still flow to the metric store below.
        if let Some(control_db) = &self.control_db {
            if tenants::is_control_kind(kind) {
                return self
                    .persist_control_to_postgres(control_db, kind, &row.payload)
                    .await;
            }
        }
        #[cfg(test)]
        if self.control_db.is_none() && self.metric_store.database().ends_with("_test") {
            return Ok(());
        }
        let metric_store = self.metric_store_for_persist(org_id).await?;
        metric_store.insert_operational_record(&row).await
    }

    async fn persist_run_controls_locked(
        &self,
        org_id: Uuid,
        controls: &[RunControlRow],
    ) -> AppResult<()> {
        if controls.is_empty() {
            return Ok(());
        }
        let mut rows = Vec::with_capacity(controls.len());
        for control in controls {
            rows.push(OperationalRecordRow {
                kind: "run_control".to_string(),
                org_id,
                entity_id: control.run_id.to_string(),
                payload: serde_json::to_string(control)
                    .map_err(|_| AppError::internal("operational payload serialization failed"))?,
                created_at: self.next_record_created_at().await,
            });
        }
        #[cfg(test)]
        if self.control_db.is_none() && self.metric_store.database().ends_with("_test") {
            return Ok(());
        }
        let metric_store = self.metric_store_for_persist(org_id).await?;
        metric_store.insert_operational_records(&rows).await
    }

    /// Route a serialized control record to the right typed Postgres upsert.
    /// The payload is the same JSON `persist_locked` would have appended to the
    /// ClickHouse log, so call sites are unchanged — only the destination moves.
    async fn persist_control_to_postgres(
        &self,
        control_db: &ControlDb,
        kind: &str,
        payload: &str,
    ) -> AppResult<()> {
        match kind {
            "user" => control_db.upsert_user(&parse_payload(payload)?).await,
            "identity" => {
                let item: IdentityRecord = parse_payload(payload)?;
                control_db
                    .upsert_identity(&item.provider, &item.provider_subject, item.user_id)
                    .await
            }
            "organization" => control_db.upsert_org(&parse_payload(payload)?).await,
            "membership" => control_db.upsert_membership(&parse_payload(payload)?).await,
            "org_invitation" => {
                control_db
                    .upsert_org_invitation(&parse_payload(payload)?)
                    .await
            }
            "email_delivery" => {
                control_db
                    .upsert_email_delivery(&parse_payload(payload)?)
                    .await
            }
            "session" => {
                let item: SessionRecord = parse_payload(payload)?;
                control_db
                    .upsert_session(&NewSession {
                        row: item.row,
                        token_hash: item.token_hash,
                    })
                    .await
            }
            "service_account" => {
                control_db
                    .upsert_service_account(&parse_payload(payload)?)
                    .await
            }
            "api_key" => {
                let item: ApiKeyRecord = parse_payload(payload)?;
                control_db
                    .upsert_api_key(&ApiKeyWithHash {
                        row: item.row,
                        key_hash: item.key_hash,
                    })
                    .await
            }
            "embed_session" => {
                control_db
                    .upsert_embed_session(&parse_payload(payload)?)
                    .await
            }
            "dashboard_preference" => {
                control_db
                    .upsert_dashboard_preference(&parse_payload(payload)?)
                    .await
            }
            "workspace_view" => {
                control_db
                    .upsert_workspace_view(&parse_payload(payload)?)
                    .await
            }
            "billing_account" => {
                control_db
                    .upsert_billing_account(&parse_payload(payload)?)
                    .await
            }
            "billing_checkout_intent" => {
                control_db
                    .upsert_billing_checkout_intent(&parse_payload(payload)?)
                    .await
            }
            "billing_change_intent" => {
                control_db
                    .upsert_billing_change_intent(&parse_payload(payload)?)
                    .await
            }
            "billing_subscription" => {
                control_db
                    .upsert_billing_subscription(&parse_payload(payload)?)
                    .await
            }
            "billing_event" => {
                control_db
                    .upsert_billing_event(&parse_payload(payload)?)
                    .await
            }
            "billing_usage_report" => {
                control_db
                    .upsert_billing_usage_report(&parse_payload(payload)?)
                    .await
            }
            tenants::TENANT_ROUTE_KIND => control_db
                .upsert_tenant_route(&parse_payload(payload)?)
                .await
                .map(|_| ()),
            other => Err(AppError::internal(format!(
                "unknown control kind for postgres persistence: {other}"
            ))),
        }
    }

    async fn next_record_created_at(&self) -> DateTime<Utc> {
        let mut clock = self.record_clock_micros.lock().await;
        let next = Utc::now().timestamp_micros().max(*clock + 1);
        *clock = next;
        datetime_from_micros(next)
    }

    pub(super) async fn reserve_idempotency_key(&self, org_id: Uuid, key: &str) -> AppResult<()> {
        let mut inflight = self.inflight_idempotency.lock().await;
        if !inflight.insert((org_id, key.to_string())) {
            return Err(AppError::conflict(
                "idempotency key is already being processed",
            ));
        }
        Ok(())
    }

    pub(super) async fn release_idempotency_key(&self, org_id: Uuid, key: &str) {
        self.inflight_idempotency
            .lock()
            .await
            .remove(&(org_id, key.to_string()));
    }
}

#[derive(Default)]
struct StoreData {
    users: BTreeMap<Uuid, UserRow>,
    users_by_email: HashMap<String, Uuid>,
    identities: HashMap<(String, String), Uuid>,
    organizations: BTreeMap<Uuid, OrganizationRow>,
    orgs_by_slug: HashMap<String, Uuid>,
    memberships: BTreeMap<Uuid, MembershipRow>,
    org_invitations: BTreeMap<Uuid, OrgInvitationRow>,
    org_invitations_by_token_hash: HashMap<Vec<u8>, Uuid>,
    invitation_token_attempts: HashMap<Vec<u8>, Vec<DateTime<Utc>>>,
    invitation_token_global_attempts: Vec<DateTime<Utc>>,
    invitation_token_client_attempts: HashMap<String, Vec<DateTime<Utc>>>,
    email_deliveries: BTreeMap<Uuid, EmailDeliveryRow>,
    sessions: BTreeMap<Uuid, SessionRecord>,
    sessions_by_hash: HashMap<Vec<u8>, Uuid>,
    service_accounts: BTreeMap<Uuid, ServiceAccountRow>,
    api_keys: BTreeMap<Uuid, ApiKeyRecord>,
    api_keys_by_hash: HashMap<Vec<u8>, Uuid>,
    embed_sessions: BTreeMap<Uuid, EmbedSessionRow>,
    embed_sessions_by_token_hash: HashMap<Vec<u8>, Uuid>,
    embed_create_attempts: HashMap<Uuid, Vec<DateTime<Utc>>>,
    pub(super) device_codes: BTreeMap<Vec<u8>, DeviceCodeRecord>,
    pub(super) device_codes_by_user_code: HashMap<String, Vec<u8>>,
    projects: BTreeMap<Uuid, ProjectRow>,
    projects_by_org_name: HashMap<(Uuid, String), Uuid>,
    runs: BTreeMap<Uuid, RunRow>,
    runs_by_org_created: BTreeMap<(Uuid, DateTime<Utc>, Uuid), Uuid>,
    runs_by_org_project_created: BTreeMap<(Uuid, String, DateTime<Utc>, Uuid), Uuid>,
    runs_by_parent_created: BTreeMap<(Uuid, Uuid, DateTime<Utc>, Uuid), Uuid>,
    run_count_by_org: HashMap<Uuid, usize>,
    run_count_by_org_project: HashMap<(Uuid, String), usize>,
    run_controls: BTreeMap<Uuid, RunControlRow>,
    incomplete_import_runs: HashSet<Uuid>,
    run_search_documents: HashMap<Uuid, Arc<RunSearchDocument>>,
    run_filter_cache: HashMap<RunFilterCacheKey, Vec<Uuid>>,
    run_filter_cache_order: VecDeque<RunFilterCacheKey>,
    attributes: BTreeMap<(Uuid, i64), AttributeRow>,
    attributes_by_run: HashMap<Uuid, Vec<i64>>,
    artifacts: BTreeMap<Uuid, ArtifactRow>,
    artifacts_by_run: HashMap<Uuid, Vec<Uuid>>,
    artifact_collections: BTreeMap<Uuid, ArtifactCollectionRow>,
    artifact_collections_by_project_type_name: HashMap<(Uuid, String, String), Uuid>,
    artifact_versions: BTreeMap<Uuid, ArtifactVersionRow>,
    artifact_versions_by_collection: HashMap<Uuid, Vec<Uuid>>,
    artifact_manifest_chunks: BTreeMap<(Uuid, i64), ArtifactManifestEntriesRecord>,
    artifact_entries_by_id: HashMap<Uuid, (Uuid, i64, usize)>,
    artifact_aliases: BTreeMap<(Uuid, String), ArtifactAliasRow>,
    artifact_edges: BTreeMap<Uuid, ArtifactEdgeRow>,
    artifact_edges_by_version: HashMap<Uuid, Vec<Uuid>>,
    artifact_edges_by_run: HashMap<Uuid, Vec<Uuid>>,
    artifact_upload_sessions: BTreeMap<Uuid, ArtifactUploadSessionRow>,
    table_rows: HashMap<(Uuid, i64), Vec<TableObjectRow>>,
    imports: BTreeMap<(Uuid, i64), ImportRow>,
    import_chunks: BTreeMap<(Uuid, i64, String), ImportChunkRow>,
    active_import_commits: HashSet<(Uuid, i64)>,
    idempotency: HashMap<(Uuid, String), IdempotencyRecord>,
    usage_daily: Vec<Value>,
    api_request_rollups: BTreeMap<String, ApiRequestUsageRollup>,
    api_request_rollup_flushes: HashMap<String, ApiRequestRollupFlush>,
    api_request_rollup_refreshes: HashMap<String, DateTime<Utc>>,
    data_cells: BTreeMap<String, DataCellRow>,
    tenant_routes: BTreeMap<Uuid, TenantRouteRecord>,
    billing_accounts: BTreeMap<Uuid, BillingAccountProjection>,
    billing_checkout_intents: BTreeMap<Uuid, BillingCheckoutIntent>,
    billing_change_intents: BTreeMap<Uuid, BillingChangeIntent>,
    billing_subscriptions: BTreeMap<String, BillingSubscriptionRecord>,
    billing_events: BTreeMap<String, BillingEventRecord>,
    billing_usage_reports: BTreeMap<Uuid, BillingUsageReportRecord>,
    dashboard_preferences: BTreeMap<(Uuid, Option<Uuid>), DashboardPreferenceRow>,
    workspace_views: BTreeMap<Uuid, WorkspaceViewRow>,
    reports: BTreeMap<Uuid, ReportRow>,
    next_attribute_id_by_org: HashMap<Uuid, i64>,
    next_import_id_by_org: HashMap<Uuid, i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunControlPrivacy {
    Public,
    Private,
}

impl StoreData {
    fn apply_operational_records(
        &mut self,
        mut records: Vec<OperationalRecordRow>,
        scope: ReplayScope,
    ) -> AppResult<ReplayStats> {
        records.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.kind.cmp(&right.kind))
                .then_with(|| left.org_id.cmp(&right.org_id))
                .then_with(|| left.entity_id.cmp(&right.entity_id))
                .then_with(|| left.payload.cmp(&right.payload))
        });
        let mut stats = ReplayStats::default();
        for record in records {
            if let ReplayScope::Tenant(expected_org_id) = scope {
                validate_tenant_record_for_replay(expected_org_id, &record)?;
            }
            stats.latest_record_micros = stats
                .latest_record_micros
                .max(record.created_at.timestamp_micros());
            self.apply_record(&record.kind, record.org_id, &record.payload)?;
        }
        self.recompute_counters();
        Ok(stats)
    }

    fn apply_record(&mut self, kind: &str, org_id: Uuid, payload: &str) -> AppResult<()> {
        match kind {
            "user" => self.insert_user(parse_payload(payload)?),
            "identity" => {
                let item: IdentityRecord = parse_payload(payload)?;
                self.identities
                    .insert((item.provider, item.provider_subject), item.user_id);
            }
            "organization" => self.insert_org(parse_payload(payload)?),
            "membership" => self.insert_membership(parse_payload(payload)?),
            "org_invitation" => self.insert_org_invitation(parse_payload(payload)?),
            "email_delivery" => self.insert_email_delivery(parse_payload(payload)?),
            "session" => self.insert_session(parse_payload(payload)?),
            "service_account" => {
                let row: ServiceAccountRow = parse_payload(payload)?;
                self.service_accounts.insert(row.id, row);
            }
            "api_key" => self.insert_api_key(parse_payload(payload)?),
            "embed_session" => self.insert_embed_session(parse_payload(payload)?),
            "project" => self.insert_project(parse_payload(payload)?),
            "project_delete" => self.apply_project_delete(parse_payload(payload)?),
            "run" => self.insert_run(parse_payload(payload)?),
            "run_control" => self.insert_run_control(parse_payload(payload)?),
            "attribute" => self.insert_attribute(parse_payload(payload)?),
            "artifact" => self.insert_artifact(parse_payload(payload)?),
            "artifact_collection" => self.insert_artifact_collection(parse_payload(payload)?),
            "artifact_version" => self.insert_artifact_version(parse_payload(payload)?),
            "artifact_manifest_entries" => {
                self.insert_artifact_manifest_entries(parse_payload(payload)?)
            }
            "artifact_alias" => self.insert_artifact_alias(parse_payload(payload)?),
            "artifact_edge" => self.insert_artifact_edge(parse_payload(payload)?),
            "artifact_upload_session" => {
                self.insert_artifact_upload_session(parse_payload(payload)?)
            }
            "table_rows" => {
                let item: TableRowsRecord = parse_payload(payload)?;
                self.table_rows
                    .insert((org_id, item.attribute_id), item.rows);
            }
            "import" => {
                let item: ImportRow = parse_payload(payload)?;
                self.imports.insert((item.org_id, item.id), item);
            }
            "import_chunk" => {
                let item: ImportChunkRow = parse_payload(payload)?;
                self.import_chunks
                    .insert((item.org_id, item.import_id, item.chunk_id.clone()), item);
            }
            "idempotency" => {
                let item: IdempotencyRecord = parse_payload(payload)?;
                self.idempotency
                    .insert((item.org_id, item.key.clone()), item);
            }
            "usage_daily" => self.usage_daily.push(parse_payload(payload)?),
            "api_usage_monthly" => self.insert_api_request_usage_rollup(parse_payload(payload)?),
            "tenant_route" => self.insert_tenant_route(parse_payload(payload)?),
            "billing_account" => self.insert_billing_account(parse_payload(payload)?),
            "billing_checkout_intent" => {
                self.insert_billing_checkout_intent(parse_payload(payload)?)
            }
            "billing_change_intent" => self.insert_billing_change_intent(parse_payload(payload)?),
            "billing_subscription" => self.insert_billing_subscription(parse_payload(payload)?),
            "billing_event" => self.insert_billing_event(parse_payload(payload)?),
            "billing_usage_report" => self.insert_billing_usage_report(parse_payload(payload)?),
            "dashboard_preference" => self.insert_dashboard_preference(parse_payload(payload)?),
            "workspace_view" => self.insert_workspace_view(parse_payload(payload)?),
            "report" => self.insert_report(parse_payload(payload)?),
            _ => {}
        }
        Ok(())
    }

    /// Replace the control-plane collections from a freshly loaded Postgres
    /// projection while **preserving** the data plane's lazily-loaded tenant
    /// state (runs/attributes/artifacts/imports/projects/reports/usage), the
    /// invitation rate-limit counters, and device codes — none of which live in
    /// Postgres. Used by the data-plane refresh so picking up control changes
    /// (new/revoked keys, route changes) never clobbers loaded tenant data.
    ///
    /// The field set here must mirror `Store::load_data_from_postgres`.
    fn adopt_control_projection(&mut self, fresh: StoreData) {
        self.users = fresh.users;
        self.users_by_email = fresh.users_by_email;
        self.identities = fresh.identities;
        self.organizations = fresh.organizations;
        self.orgs_by_slug = fresh.orgs_by_slug;
        self.memberships = fresh.memberships;
        self.org_invitations = fresh.org_invitations;
        self.org_invitations_by_token_hash = fresh.org_invitations_by_token_hash;
        self.email_deliveries = fresh.email_deliveries;
        self.sessions = fresh.sessions;
        self.sessions_by_hash = fresh.sessions_by_hash;
        self.service_accounts = fresh.service_accounts;
        self.api_keys = fresh.api_keys;
        self.api_keys_by_hash = fresh.api_keys_by_hash;
        self.embed_sessions = fresh.embed_sessions;
        self.embed_sessions_by_token_hash = fresh.embed_sessions_by_token_hash;
        self.data_cells = fresh.data_cells;
        self.tenant_routes = fresh.tenant_routes;
        self.billing_accounts = fresh.billing_accounts;
        self.billing_checkout_intents = fresh.billing_checkout_intents;
        self.billing_change_intents = fresh.billing_change_intents;
        self.billing_subscriptions = fresh.billing_subscriptions;
        self.billing_events = fresh.billing_events;
        self.billing_usage_reports = fresh.billing_usage_reports;
        self.dashboard_preferences = fresh.dashboard_preferences;
        self.workspace_views = fresh.workspace_views;
    }

    fn recompute_counters(&mut self) {
        self.next_attribute_id_by_org.clear();
        for attribute in self.attributes.values() {
            let next = self
                .next_attribute_id_by_org
                .entry(attribute.org_id)
                .or_insert(1);
            *next = (*next).max(attribute.id + 1);
        }
        self.next_import_id_by_org.clear();
        for import in self.imports.values() {
            let next = self.next_import_id_by_org.entry(import.org_id).or_insert(1);
            *next = (*next).max(import.id + 1);
        }
    }

    fn insert_user(&mut self, user: UserRow) {
        if let Some(existing) = self.users.get(&user.id) {
            self.users_by_email
                .remove(&existing.primary_email.to_ascii_lowercase());
        }
        self.users_by_email
            .insert(user.primary_email.to_ascii_lowercase(), user.id);
        self.users.insert(user.id, user);
    }

    fn insert_org(&mut self, org: OrganizationRow) {
        if let Some(existing) = self.organizations.get(&org.id) {
            self.orgs_by_slug.remove(&existing.slug);
        }
        self.orgs_by_slug.insert(org.slug.clone(), org.id);
        self.organizations.insert(org.id, org);
    }

    fn insert_membership(&mut self, membership: MembershipRow) {
        self.memberships.insert(membership.id, membership);
    }

    fn insert_org_invitation(&mut self, invitation: OrgInvitationRow) {
        if let Some(existing) = self.org_invitations.get(&invitation.id) {
            self.org_invitations_by_token_hash
                .remove(&existing.token_hash);
            for token_hash in &existing.previous_token_hashes {
                self.org_invitations_by_token_hash.remove(token_hash);
            }
        }
        if invitation.status == "pending" && invitation.expires_at > Utc::now() {
            self.org_invitations_by_token_hash
                .insert(invitation.token_hash.clone(), invitation.id);
            for token_hash in &invitation.previous_token_hashes {
                self.org_invitations_by_token_hash
                    .insert(token_hash.clone(), invitation.id);
            }
        }
        self.org_invitations.insert(invitation.id, invitation);
    }

    fn insert_email_delivery(&mut self, delivery: EmailDeliveryRow) {
        self.email_deliveries.insert(delivery.id, delivery);
    }

    fn insert_session(&mut self, session: SessionRecord) {
        self.sessions_by_hash
            .insert(session.token_hash.clone(), session.row.id);
        self.sessions.insert(session.row.id, session);
    }

    fn insert_api_key(&mut self, key: ApiKeyRecord) {
        self.api_keys_by_hash
            .insert(key.key_hash.clone(), key.row.id);
        self.api_keys.insert(key.row.id, key);
    }

    fn insert_embed_session(&mut self, row: EmbedSessionRow) {
        if let Some(existing) = self.embed_sessions.get(&row.id) {
            self.embed_sessions_by_token_hash
                .remove(&existing.token_hash);
        }
        if row.deleted_at.is_none() && row.expires_at > Utc::now() {
            self.embed_sessions_by_token_hash
                .insert(row.token_hash.clone(), row.id);
        }
        self.embed_sessions.insert(row.id, row);
    }

    fn insert_project(&mut self, project: ProjectRow) {
        self.projects_by_org_name
            .insert((project.org_id, project.name.clone()), project.id);
        self.projects.insert(project.id, project);
    }

    fn insert_run(&mut self, run: RunRow) {
        if let Some(existing) = self.runs.get(&run.id).cloned() {
            self.runs_by_org_created
                .remove(&(existing.org_id, existing.created_at, existing.id));
            self.runs_by_org_project_created.remove(&(
                existing.org_id,
                existing.project.clone(),
                existing.created_at,
                existing.id,
            ));
            if let Some(parent_run_id) = existing.parent_run_id {
                self.runs_by_parent_created.remove(&(
                    existing.org_id,
                    parent_run_id,
                    existing.created_at,
                    existing.id,
                ));
            }
            if !run_has_incomplete_import_metadata(&existing) {
                self.decrement_run_counts(&existing);
            }
        }
        if run_has_incomplete_import_metadata(&run) {
            self.incomplete_import_runs.insert(run.id);
            self.run_search_documents.remove(&run.id);
        } else {
            self.incomplete_import_runs.remove(&run.id);
            self.increment_run_counts(&run);
            self.runs_by_org_created
                .insert((run.org_id, run.created_at, run.id), run.id);
            self.runs_by_org_project_created.insert(
                (run.org_id, run.project.clone(), run.created_at, run.id),
                run.id,
            );
            if let Some(parent_run_id) = run.parent_run_id {
                self.runs_by_parent_created
                    .insert((run.org_id, parent_run_id, run.created_at, run.id), run.id);
            }
            self.run_search_documents
                .insert(run.id, Arc::new(run_search_document(&run)));
        }
        self.runs.insert(run.id, run);
        self.clear_run_filter_cache();
    }

    fn insert_run_control(&mut self, control: RunControlRow) {
        self.run_controls.insert(control.run_id, control);
        self.clear_run_filter_cache();
    }

    fn insert_attribute(&mut self, attribute: AttributeRow) {
        let next = self
            .next_attribute_id_by_org
            .entry(attribute.org_id)
            .or_insert(1);
        *next = (*next).max(attribute.id + 1);
        self.attributes_by_run
            .entry(attribute.run_id)
            .or_default()
            .retain(|id| *id != attribute.id);
        self.attributes_by_run
            .entry(attribute.run_id)
            .or_default()
            .push(attribute.id);
        self.attributes
            .insert((attribute.org_id, attribute.id), attribute);
    }

    fn insert_artifact(&mut self, artifact: ArtifactRow) {
        self.artifacts_by_run
            .entry(artifact.run_id)
            .or_default()
            .retain(|id| *id != artifact.id);
        self.artifacts_by_run
            .entry(artifact.run_id)
            .or_default()
            .push(artifact.id);
        self.artifacts.insert(artifact.id, artifact);
    }

    fn insert_artifact_collection(&mut self, collection: ArtifactCollectionRow) {
        if let Some(existing) = self.artifact_collections.get(&collection.id) {
            self.artifact_collections_by_project_type_name.remove(&(
                existing.project_id,
                existing.kind.clone(),
                existing.name.clone(),
            ));
        }
        if collection.deleted_at.is_none() {
            self.artifact_collections_by_project_type_name.insert(
                (
                    collection.project_id,
                    collection.kind.clone(),
                    collection.name.clone(),
                ),
                collection.id,
            );
        }
        self.artifact_collections.insert(collection.id, collection);
    }

    fn insert_artifact_version(&mut self, version: ArtifactVersionRow) {
        let collection_id = version.collection_id;
        let version_id = version.id;
        self.artifact_versions.insert(version.id, version);
        self.artifact_versions_by_collection
            .entry(collection_id)
            .or_default()
            .retain(|id| *id != version_id);
        self.artifact_versions_by_collection
            .entry(collection_id)
            .or_default()
            .push(version_id);
        self.artifact_versions_by_collection
            .entry(collection_id)
            .or_default()
            .sort_by_key(|id| {
                self.artifact_versions
                    .get(id)
                    .map(|row| row.version_index)
                    .unwrap_or(i64::MAX)
            });
    }

    fn insert_artifact_manifest_entries(&mut self, record: ArtifactManifestEntriesRecord) {
        for (index, entry) in record.entries.iter().enumerate() {
            self.artifact_entries_by_id.insert(
                entry.id,
                (record.artifact_version_id, record.chunk_index, index),
            );
        }
        self.artifact_manifest_chunks
            .insert((record.artifact_version_id, record.chunk_index), record);
    }

    fn insert_artifact_alias(&mut self, alias: ArtifactAliasRow) {
        if alias.deleted_at.is_some() {
            self.artifact_aliases
                .remove(&(alias.collection_id, alias.alias.clone()));
            return;
        }
        self.artifact_aliases
            .insert((alias.collection_id, alias.alias.clone()), alias);
    }

    fn insert_artifact_edge(&mut self, edge: ArtifactEdgeRow) {
        self.artifact_edges_by_version
            .entry(edge.artifact_version_id)
            .or_default()
            .retain(|id| *id != edge.id);
        self.artifact_edges_by_version
            .entry(edge.artifact_version_id)
            .or_default()
            .push(edge.id);
        self.artifact_edges_by_run
            .entry(edge.run_id)
            .or_default()
            .retain(|id| *id != edge.id);
        self.artifact_edges_by_run
            .entry(edge.run_id)
            .or_default()
            .push(edge.id);
        self.artifact_edges.insert(edge.id, edge);
    }

    fn insert_artifact_upload_session(&mut self, session: ArtifactUploadSessionRow) {
        self.artifact_upload_sessions.insert(session.id, session);
    }

    fn apply_project_delete(&mut self, delete: ProjectDeleteRecord) {
        let Some(project_id) = self
            .projects_by_org_name
            .remove(&(delete.org_id, delete.project_name))
        else {
            return;
        };
        self.projects.remove(&project_id);
        let run_ids = self
            .runs
            .values()
            .filter(|run| run.org_id == delete.org_id && run.project_id == project_id)
            .map(|run| run.id)
            .collect::<Vec<_>>();
        for run_id in run_ids {
            self.remove_run(run_id);
            if let Some(attribute_ids) = self.attributes_by_run.remove(&run_id) {
                for id in attribute_ids {
                    self.attributes.remove(&(delete.org_id, id));
                    self.table_rows.remove(&(delete.org_id, id));
                }
            }
            if let Some(artifact_ids) = self.artifacts_by_run.remove(&run_id) {
                for id in artifact_ids {
                    self.artifacts.remove(&id);
                }
            }
            if let Some(edge_ids) = self.artifact_edges_by_run.remove(&run_id) {
                for id in edge_ids {
                    if let Some(edge) = self.artifact_edges.remove(&id) {
                        if let Some(ids) = self
                            .artifact_edges_by_version
                            .get_mut(&edge.artifact_version_id)
                        {
                            ids.retain(|candidate| *candidate != id);
                        }
                    }
                }
            }
        }
        let collection_ids = self
            .artifact_collections
            .values()
            .filter(|collection| {
                collection.org_id == delete.org_id && collection.project_id == project_id
            })
            .map(|collection| collection.id)
            .collect::<Vec<_>>();
        for collection_id in collection_ids {
            if let Some(collection) = self.artifact_collections.remove(&collection_id) {
                self.artifact_collections_by_project_type_name.remove(&(
                    collection.project_id,
                    collection.kind,
                    collection.name,
                ));
            }
            if let Some(version_ids) = self.artifact_versions_by_collection.remove(&collection_id) {
                for version_id in version_ids {
                    self.artifact_versions.remove(&version_id);
                    self.artifact_manifest_chunks
                        .retain(|(candidate, _), _| *candidate != version_id);
                    self.artifact_entries_by_id
                        .retain(|_, (candidate, _, _)| *candidate != version_id);
                    if let Some(edge_ids) = self.artifact_edges_by_version.remove(&version_id) {
                        for edge_id in edge_ids {
                            self.artifact_edges.remove(&edge_id);
                        }
                    }
                }
            }
            self.artifact_aliases
                .retain(|(candidate, _), _| *candidate != collection_id);
        }
    }

    fn insert_tenant_route(&mut self, route: TenantRouteRecord) {
        self.tenant_routes.insert(route.org_id, route);
    }

    fn insert_data_cell(&mut self, cell: DataCellRow) {
        self.data_cells.insert(cell.cell_id.clone(), cell);
    }

    fn insert_billing_account(&mut self, account: BillingAccountProjection) {
        self.billing_accounts.insert(account.org_id, account);
    }

    fn insert_billing_checkout_intent(&mut self, intent: BillingCheckoutIntent) {
        self.billing_checkout_intents.insert(intent.id, intent);
    }

    fn insert_billing_change_intent(&mut self, intent: BillingChangeIntent) {
        self.billing_change_intents.insert(intent.id, intent);
    }

    fn insert_billing_subscription(&mut self, subscription: BillingSubscriptionRecord) {
        self.billing_subscriptions
            .insert(subscription.stripe_subscription_id.clone(), subscription);
    }

    fn insert_billing_event(&mut self, event: BillingEventRecord) {
        self.billing_events
            .insert(event.stripe_event_id.clone(), event);
    }

    fn insert_billing_usage_report(&mut self, report: BillingUsageReportRecord) {
        self.billing_usage_reports.insert(report.id, report);
    }

    fn insert_dashboard_preference(&mut self, row: DashboardPreferenceRow) {
        self.dashboard_preferences
            .insert((row.org_id, row.user_id), row);
    }

    fn insert_workspace_view(&mut self, row: WorkspaceViewRow) {
        self.workspace_views.insert(row.id, row);
    }

    fn insert_report(&mut self, row: ReportRow) {
        self.reports.insert(row.id, row);
    }

    fn remove_run(&mut self, run_id: Uuid) {
        if let Some(run) = self.runs.remove(&run_id) {
            self.runs_by_org_created
                .remove(&(run.org_id, run.created_at, run.id));
            self.runs_by_org_project_created.remove(&(
                run.org_id,
                run.project.clone(),
                run.created_at,
                run.id,
            ));
            if let Some(parent_run_id) = run.parent_run_id {
                self.runs_by_parent_created.remove(&(
                    run.org_id,
                    parent_run_id,
                    run.created_at,
                    run.id,
                ));
            }
            if !run_has_incomplete_import_metadata(&run) {
                self.decrement_run_counts(&run);
            }
            self.run_search_documents.remove(&run.id);
            self.incomplete_import_runs.remove(&run.id);
            self.run_controls.remove(&run.id);
            self.clear_run_filter_cache();
        }
    }

    fn increment_run_counts(&mut self, run: &RunRow) {
        *self.run_count_by_org.entry(run.org_id).or_insert(0) += 1;
        *self
            .run_count_by_org_project
            .entry((run.org_id, run.project.clone()))
            .or_insert(0) += 1;
    }

    fn decrement_run_counts(&mut self, run: &RunRow) {
        decrement_count(&mut self.run_count_by_org, &run.org_id);
        decrement_count(
            &mut self.run_count_by_org_project,
            &(run.org_id, run.project.clone()),
        );
    }

    fn cached_run_filter_ids(&self, key: &RunFilterCacheKey) -> Option<Vec<Uuid>> {
        self.run_filter_cache.get(key).cloned()
    }

    fn insert_run_filter_cache(&mut self, key: RunFilterCacheKey, ids: Vec<Uuid>) {
        if !self.run_filter_cache.contains_key(&key) {
            self.run_filter_cache_order.push_back(key.clone());
        }
        self.run_filter_cache.insert(key, ids);
        while self.run_filter_cache_order.len() > MAX_RUN_FILTER_CACHE_ENTRIES {
            if let Some(oldest) = self.run_filter_cache_order.pop_front() {
                self.run_filter_cache.remove(&oldest);
            }
        }
    }

    fn clear_run_filter_cache(&mut self) {
        self.run_filter_cache.clear();
        self.run_filter_cache_order.clear();
    }

    fn allocate_attribute_id(&mut self, org_id: Uuid) -> i64 {
        let next = self.next_attribute_id_by_org.entry(org_id).or_insert(1);
        let id = *next;
        *next += 1;
        id
    }

    fn allocate_import_id(&mut self, org_id: Uuid) -> i64 {
        let next = self.next_import_id_by_org.entry(org_id).or_insert(1);
        let id = *next;
        *next += 1;
        id
    }

    fn insert_api_request_usage_rollup(&mut self, rollup: ApiRequestUsageRollup) {
        let entity_id = rollup.entity_id();
        self.api_request_rollups
            .entry(entity_id)
            .and_modify(|existing| {
                if rollup.request_count >= existing.request_count {
                    *existing = rollup.clone();
                }
            })
            .or_insert(rollup);
    }

    fn increment_api_request_rollup(
        &mut self,
        org_id: Uuid,
        class: &str,
        instance_id: &str,
        now: DateTime<Utc>,
    ) -> (ApiRequestUsageRollup, bool) {
        let period = api_request_usage_period_key(now);
        let window_started_at = api_request_usage_window_start(now);
        let rollup_key = format!(
            "{}:{class}:{instance_id}",
            window_started_at.format("%Y-%m-%dT%H:%MZ")
        );
        let entity_id =
            api_request_usage_entity_id(org_id, &period, class, instance_id, window_started_at);
        let rollup = self
            .api_request_rollups
            .entry(entity_id.clone())
            .or_insert_with(|| ApiRequestUsageRollup {
                org_id,
                period: period.clone(),
                rollup_key,
                request_count: 0,
                class: class.to_string(),
                instance_id: instance_id.to_string(),
                window_started_at,
                updated_at: now,
                created_at: window_started_at,
            });
        rollup.request_count = rollup.request_count.saturating_add(1);
        rollup.updated_at = now;
        let flush = self
            .api_request_rollup_flushes
            .entry(entity_id)
            .or_default();
        let should_flush = flush.last_persisted_count == 0
            || (rollup.request_count > flush.last_persisted_count
                && now.signed_duration_since(flush.last_flushed_at) >= ChronoDuration::seconds(10));
        (rollup.clone(), should_flush)
    }

    fn mark_api_request_rollup_persisted(&mut self, rollup: &ApiRequestUsageRollup) {
        let entity_id = rollup.entity_id();
        let flush = self
            .api_request_rollup_flushes
            .entry(entity_id)
            .or_default();
        flush.last_flushed_at = rollup.updated_at;
        flush.last_persisted_count = rollup.request_count;
    }

    fn api_request_usage_for_org_period(&self, org_id: Uuid, period: &str) -> i64 {
        self.api_request_rollups
            .values()
            .filter(|rollup| rollup.org_id == org_id && rollup.period == period)
            .map(|rollup| rollup.request_count)
            .sum()
    }

    fn api_request_rollup_refresh_due(
        &self,
        org_id: Uuid,
        period: &str,
        now: DateTime<Utc>,
    ) -> bool {
        let key = api_request_rollup_refresh_key(org_id, period);
        self.api_request_rollup_refreshes
            .get(&key)
            .is_none_or(|last| now.signed_duration_since(*last) >= ChronoDuration::seconds(2))
    }

    fn mark_api_request_rollups_refreshed(
        &mut self,
        org_id: Uuid,
        period: &str,
        now: DateTime<Utc>,
    ) {
        self.api_request_rollup_refreshes
            .insert(api_request_rollup_refresh_key(org_id, period), now);
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RunFilterCacheKey {
    org_id: Uuid,
    auth_project_id: Option<Uuid>,
    project: String,
    status: String,
    display_status: String,
    q: String,
}

fn run_has_incomplete_import_metadata(run: &RunRow) -> bool {
    run.metadata
        .get("import")
        .and_then(|import| import.get("complete"))
        .and_then(Value::as_bool)
        == Some(false)
}

fn is_visible_run(data: &StoreData, run: &RunRow) -> bool {
    data.incomplete_import_runs.is_empty() || !data.incomplete_import_runs.contains(&run.id)
}

fn run_control_for<'a>(data: &'a StoreData, run: &RunRow) -> Option<&'a RunControlRow> {
    data.run_controls
        .get(&run.id)
        .filter(|control| control.org_id == run.org_id)
}

fn run_control_display_status(run: &RunRow, control: Option<&RunControlRow>) -> &'static str {
    match (
        run.status.as_str(),
        control.map(|item| item.stop_state.as_str()),
    ) {
        ("running", Some("requested" | "acknowledged")) => "stopping",
        ("finished" | "failed", Some("completed")) => "stopped",
        ("running", _) => "running",
        ("finished", _) => "finished",
        ("failed", _) => "failed",
        _ => "failed",
    }
}

fn run_control_summary(
    run: &RunRow,
    control: Option<&RunControlRow>,
    privacy: RunControlPrivacy,
) -> Value {
    let stop_state = control
        .map(|item| item.stop_state.as_str())
        .unwrap_or("none");
    let mut summary = json!({
        "stop_state": stop_state,
        "display_status": run_control_display_status(run, control),
        "stop_request_id": control.and_then(|item| item.stop_request_id),
        "stop_requested": matches!(stop_state, "requested" | "acknowledged" | "completed"),
        "actor": control.and_then(|item| display_stop_actor(item.actor.as_deref())),
        "stop_requested_at": control.and_then(|item| item.requested_at),
        "stop_acknowledged_at": control.and_then(|item| item.acknowledged_at),
        "stop_completed_at": control.and_then(|item| item.completed_at),
        "updated_at": control.map(|item| item.updated_at),
    });
    if privacy == RunControlPrivacy::Private {
        if let Value::Object(map) = &mut summary {
            map.insert(
                "reason".to_string(),
                control
                    .and_then(|item| item.reason.clone())
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            map.insert(
                "completion_message".to_string(),
                control
                    .and_then(|item| item.completion_message.clone())
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
        }
    }
    summary
}

fn can_read_private_run_control(ctx: &RequestContext) -> bool {
    if let Some(auth) = &ctx.auth {
        return auth.scopes.iter().any(|scope| scope == "export:read")
            && auth.scopes.iter().any(|scope| scope == "runs:control");
    }
    if let Some(session) = &ctx.session {
        return !session.demo_read_only
            && matches!(session.role.as_str(), "owner" | "admin" | "member");
    }
    true
}

fn display_stop_actor(actor: Option<&str>) -> Option<&'static str> {
    let actor = actor?;
    if actor.starts_with("user:") {
        Some("user")
    } else if actor.starts_with("api_key:") {
        Some("api_key")
    } else if actor == "local" {
        Some("local")
    } else {
        Some("unknown")
    }
}

fn run_matches_display_status(
    data: &StoreData,
    query: &HashMap<String, String>,
    run: &RunRow,
) -> bool {
    let Some(display_status) = query
        .get("display_status")
        .map(String::as_str)
        .filter(|value| !value.is_empty() && *value != "all")
    else {
        return true;
    };
    run_control_display_status(run, run_control_for(data, run)) == display_status
}

fn decrement_count<K>(counts: &mut HashMap<K, usize>, key: &K)
where
    K: Eq + std::hash::Hash,
{
    if let Some(count) = counts.get_mut(key) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            counts.remove(key);
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiRequestUsageRollup {
    pub org_id: Uuid,
    pub period: String,
    pub rollup_key: String,
    pub request_count: i64,
    pub class: String,
    pub instance_id: String,
    pub window_started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

impl ApiRequestUsageRollup {
    fn entity_id(&self) -> String {
        api_request_usage_entity_id(
            self.org_id,
            &self.period,
            &self.class,
            &self.instance_id,
            self.window_started_at,
        )
    }
}

#[derive(Clone, Copy, Debug)]
struct ApiRequestRollupFlush {
    last_flushed_at: DateTime<Utc>,
    last_persisted_count: i64,
}

impl Default for ApiRequestRollupFlush {
    fn default() -> Self {
        Self {
            last_flushed_at: DateTime::<Utc>::UNIX_EPOCH,
            last_persisted_count: 0,
        }
    }
}

#[derive(Clone, Copy)]
enum ReplayScope {
    All,
    Tenant(Uuid),
}

#[derive(Default)]
struct ReplayStats {
    latest_record_micros: i64,
}

#[derive(Clone, Serialize, Deserialize)]
struct IdentityRecord {
    user_id: Uuid,
    provider: String,
    provider_subject: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct SessionRecord {
    row: UserSessionRow,
    token_hash: Vec<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ApiKeyRecord {
    row: PublicApiKeyRow,
    key_hash: Vec<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
struct IdempotencyRecord {
    org_id: Uuid,
    key: String,
    request_hash: Vec<u8>,
    response_json: Value,
    expires_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ImportRow {
    id: i64,
    org_id: Uuid,
    project_id: Option<Uuid>,
    source_type: String,
    #[serde(default)]
    source_project: Option<String>,
    #[serde(default)]
    target_project: Option<String>,
    #[serde(default = "default_import_schema_version")]
    schema_version: i32,
    status: String,
    #[serde(default = "default_import_dedupe_policy")]
    dedupe_policy: String,
    summary: Value,
    #[serde(default)]
    warnings: Vec<Value>,
    #[serde(default)]
    error_summary: Option<Value>,
    #[serde(default)]
    progress: Value,
    run_ids: Vec<Uuid>,
    #[serde(default)]
    chunk_ids: Vec<String>,
    #[serde(default)]
    accepted_chunk_count: i64,
    #[serde(default)]
    committed_batch_count: i64,
    #[serde(default)]
    created_by_user_id: Option<Uuid>,
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
}

fn default_import_schema_version() -> i32 {
    1
}

fn default_import_dedupe_policy() -> String {
    "legacy".to_string()
}

#[derive(Clone, Serialize, Deserialize)]
struct ImportChunkRow {
    org_id: Uuid,
    import_id: i64,
    chunk_id: String,
    sequence: i64,
    content_hash: String,
    final_chunk: bool,
    payload: Value,
    summary: Value,
    created_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
struct TableObjectRow {
    row_index: i64,
    row: Value,
    created_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
struct TableRowsRecord {
    attribute_id: i64,
    rows: Vec<TableObjectRow>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProjectDeleteRecord {
    org_id: Uuid,
    project_name: String,
}

fn parse_payload<T: for<'de> Deserialize<'de>>(payload: &str) -> AppResult<T> {
    serde_json::from_str(payload)
        .map_err(|_| AppError::internal("stored operational record is invalid"))
}

fn api_request_usage_period_key(now: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", now.year(), now.month())
}

fn api_request_rollup_refresh_key(org_id: Uuid, period: &str) -> String {
    format!("{org_id}:{period}")
}

fn api_request_usage_window_start(now: DateTime<Utc>) -> DateTime<Utc> {
    now.with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .expect("valid UTC minute boundary")
}

fn api_request_usage_entity_id(
    org_id: Uuid,
    period: &str,
    class: &str,
    instance_id: &str,
    window_started_at: DateTime<Utc>,
) -> String {
    format!(
        "{}:{period}:{class}:{instance_id}:{}",
        org_id,
        window_started_at.format("%Y-%m-%dT%H:%MZ")
    )
}

fn validate_tenant_record_for_replay(
    expected_org_id: Uuid,
    record: &OperationalRecordRow,
) -> AppResult<()> {
    if record.org_id != expected_org_id {
        return Err(AppError::internal(
            "tenant operational record belonged to a different org",
        ));
    }
    let payload = serde_json::from_str::<Value>(&record.payload)
        .map_err(|_| AppError::internal("tenant operational record payload is invalid"))?;
    if let Some(payload_org_id) = payload_org_id(&payload)? {
        if payload_org_id != expected_org_id {
            return Err(AppError::internal(
                "tenant operational record payload belonged to a different org",
            ));
        }
    }
    validate_tenant_record_entity(record, &payload)
}

fn payload_org_id(payload: &Value) -> AppResult<Option<Uuid>> {
    payload
        .get("org_id")
        .or_else(|| payload.get("row").and_then(|row| row.get("org_id")))
        .and_then(Value::as_str)
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| AppError::internal("tenant operational record org_id is invalid"))
}

fn validate_tenant_record_entity(record: &OperationalRecordRow, payload: &Value) -> AppResult<()> {
    match record.kind.as_str() {
        "project" | "run" | "artifact" => validate_payload_string_id(record, payload, "id"),
        "run_control" => validate_payload_string_id(record, payload, "run_id"),
        "artifact_collection"
        | "artifact_version"
        | "artifact_edge"
        | "artifact_upload_session" => validate_payload_string_id(record, payload, "id"),
        "artifact_manifest_entries" => validate_manifest_chunk_entity(record, payload),
        "artifact_alias" => validate_alias_entity(record, payload),
        "attribute" | "import" => validate_payload_i64_id(record, payload, "id"),
        "import_chunk" => validate_payload_string_id(record, payload, "chunk_id"),
        "idempotency" => validate_payload_string_id(record, payload, "key"),
        "project_delete" => validate_payload_string_id(record, payload, "project_name"),
        "table_rows" => validate_payload_i64_id(record, payload, "attribute_id"),
        "usage_daily" => validate_usage_daily_orgs(record.org_id, payload),
        "api_usage_monthly" => validate_api_usage_monthly_entity(record, payload),
        _ => Ok(()),
    }
}

fn validate_manifest_chunk_entity(record: &OperationalRecordRow, payload: &Value) -> AppResult<()> {
    let version_id = payload
        .get("artifact_version_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("tenant manifest chunk version id is missing"))?;
    let chunk_index = payload
        .get("chunk_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::internal("tenant manifest chunk index is missing"))?;
    if record.entity_id != format!("{version_id}:{chunk_index}") {
        return Err(AppError::internal(
            "tenant manifest chunk entity id mismatch",
        ));
    }
    Ok(())
}

fn validate_alias_entity(record: &OperationalRecordRow, payload: &Value) -> AppResult<()> {
    let collection_id = payload
        .get("collection_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("tenant artifact alias collection id is missing"))?;
    let alias = payload
        .get("alias")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("tenant artifact alias is missing"))?;
    if record.entity_id != format!("{collection_id}:{alias}") {
        return Err(AppError::internal(
            "tenant artifact alias entity id mismatch",
        ));
    }
    Ok(())
}

fn validate_payload_string_id(
    record: &OperationalRecordRow,
    payload: &Value,
    field: &str,
) -> AppResult<()> {
    let payload_id = payload
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("tenant operational record entity id is missing"))?;
    if payload_id != record.entity_id {
        return Err(AppError::internal(
            "tenant operational record entity id mismatch",
        ));
    }
    Ok(())
}

fn validate_payload_i64_id(
    record: &OperationalRecordRow,
    payload: &Value,
    field: &str,
) -> AppResult<()> {
    let payload_id = payload
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::internal("tenant operational record entity id is missing"))?;
    if payload_id.to_string() != record.entity_id {
        return Err(AppError::internal(
            "tenant operational record entity id mismatch",
        ));
    }
    Ok(())
}

fn validate_usage_daily_orgs(expected_org_id: Uuid, payload: &Value) -> AppResult<()> {
    let Some(organizations) = payload.get("organizations").and_then(Value::as_array) else {
        return Ok(());
    };
    for organization in organizations {
        let Some(raw_org_id) = organization.get("org_id").and_then(Value::as_str) else {
            continue;
        };
        let org_id = Uuid::parse_str(raw_org_id)
            .map_err(|_| AppError::internal("tenant usage snapshot org_id is invalid"))?;
        if org_id != expected_org_id {
            return Err(AppError::internal(
                "tenant usage snapshot belonged to a different org",
            ));
        }
    }
    Ok(())
}

fn validate_api_usage_monthly_entity(
    record: &OperationalRecordRow,
    payload: &Value,
) -> AppResult<()> {
    let rollup: ApiRequestUsageRollup = serde_json::from_value(payload.clone())
        .map_err(|_| AppError::internal("tenant API usage rollup payload is invalid"))?;
    if rollup.entity_id() != record.entity_id {
        return Err(AppError::internal(
            "tenant API usage rollup entity id mismatch",
        ));
    }
    Ok(())
}

pub async fn ready(store: &Store) -> bool {
    if !crate::metric_store::ready(store.metric_store()).await {
        return false;
    }
    control_ready(store).await
}

pub async fn control_ready(store: &Store) -> bool {
    let control_db_ready = match &store.control_db {
        Some(control_db) => control_db.ready().await,
        None => true,
    };
    control_db_ready && store.control_projection_health().await.loaded
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlProjectionHealth {
    pub loaded: bool,
    pub refresh_degraded: bool,
}

fn changed_tenant_routes(
    previous: &BTreeMap<Uuid, TenantRouteRecord>,
    current: &BTreeMap<Uuid, TenantRouteRecord>,
) -> BTreeSet<Uuid> {
    previous
        .keys()
        .chain(current.keys())
        .filter(|org_id| previous.get(org_id) != current.get(org_id))
        .copied()
        .collect()
}

/// Build a MetricStore connected to the shared cell when the env var is set.
/// Applies the schema migration so the shared cell is ready for writes.
async fn build_shared_cell_metric_store(
    hosted: Option<&HostedClickHouseConfig>,
) -> AppResult<Option<MetricStore>> {
    let Some(hosted) = hosted else {
        return Ok(None);
    };
    let Some(url) = hosted.shared_cell_url.as_deref() else {
        return Ok(None);
    };
    use crate::metric_store::{
        self, connect_connection, parse_clickhouse_url, ClickHouseConnection,
    };
    let parsed = parse_clickhouse_url(url, "INSTANTML_SHARED_CELL_URL")?;
    let database = std::env::var("INSTANTML_SHARED_CELL_DATABASE")
        .unwrap_or_else(|_| "instantml_shared".to_string());
    let connection = ClickHouseConnection {
        endpoint: parsed.endpoint,
        username: parsed.username,
        password: parsed.password,
        database,
    };
    let store = connect_connection(&connection)?;
    metric_store::migrate(&store).await?;
    Ok(Some(store))
}

fn infer_data_cell_region(cell_id: &str) -> String {
    let labels = cell_id.split('-').collect::<Vec<_>>();
    if labels.len() >= 3 && labels.last().is_some_and(|zone| zone.len() == 1) {
        return format!("{}-{}", labels[labels.len() - 3], labels[labels.len() - 2]);
    }
    "unknown".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn test_store(database: &str, control_db: Option<ControlDb>) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                &format!("http://default:@127.0.0.1:8123/{database}"),
                "TEST_CLICKHOUSE_URL",
            )
            .unwrap(),
            control_db,
            hosted_clickhouse: None,
            byoc_clickhouse: crate::config::ByocClickHouseConfig {
                egress_cidrs: Vec::new(),
                egress_set_version: "test".to_string(),
                allow_private_endpoints: true,
                credential_store: crate::config::ByocCredentialStoreConfig::Disabled,
            },
            cell_routing: crate::config::CellRoutingConfig {
                environment: "test".to_string(),
                placement_data_cell_id: None,
                heartbeat_data_cell_id: None,
            },
            data_cell_writer_runtime: DataCellWriterLeaseRuntime::for_tests(),
            data_cell_writer_lease: Arc::new(Mutex::new(DataCellWriterLeaseState::default())),
            data_cell_writer_refresh_lock: Arc::new(Mutex::new(())),
            tenant_metric_stores: Arc::new(Mutex::new(HashMap::new())),
            customer_tenant_endpoints: Arc::new(Mutex::new(HashMap::new())),
            tenant_loaded: Arc::new(Mutex::new(BTreeSet::new())),
            shared_cell_metric_store: None,
            inflight_idempotency: Arc::new(Mutex::new(BTreeSet::new())),
            artifact_upload_capacity_lock: Arc::new(Mutex::new(())),
            data: Arc::new(Mutex::new(StoreData::default())),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
    }

    /// Build a `Store` whose control plane is the given Postgres handle, with
    /// the rest of the dependencies stubbed. Used by the Postgres-backed
    /// chokepoint tests.
    fn store_with_control_db(control_db: ControlDb) -> Store {
        test_store("instantml_pg_chokepoint_test", Some(control_db))
    }

    fn store_without_control_db() -> Store {
        test_store("instantml_run_control_test", None)
    }

    fn hosted_clickhouse_config() -> HostedClickHouseConfig {
        HostedClickHouseConfig {
            tenant_base_url: "http://default:@127.0.0.1:8123/instantml_test_route".to_string(),
            provisioner: crate::config::ClickHouseProvisioner::Database,
            allow_stored_tenant_passwords: false,
            cloud: None,
            shared_cell_url: None,
        }
    }

    fn test_data_cell(cell_id: &str) -> DataCellRow {
        let now = Utc::now();
        DataCellRow {
            cell_id: cell_id.to_string(),
            environment: "test".to_string(),
            region: "us-central1".to_string(),
            tier: "standard".to_string(),
            status: "open".to_string(),
            service_name: format!("instantml-data-{cell_id}"),
            public_api_base: None,
            internal_api_base: None,
            clickhouse_endpoint_secret_ref: None,
            clickhouse_username_secret_ref: None,
            clickhouse_password_secret_ref: None,
            clickhouse_database_mode: Some("per-org-database".to_string()),
            max_orgs: None,
            max_metric_points_monthly: None,
            max_api_requests_monthly: None,
            max_retained_bytes: None,
            max_disk_usage_pct: None,
            reserved_headroom_pct: None,
            last_health_at: Some(now),
            last_backup_at: Some(now),
            notes: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn test_tenant_route(org_id: Uuid, cell_id: Option<&str>) -> TenantRouteRecord {
        let now = Utc::now();
        TenantRouteRecord {
            org_id,
            status: "ready".to_string(),
            provisioner: "database".to_string(),
            cell_id: cell_id.map(str::to_string),
            route_version: 1,
            placement_reason: cell_id.map(|_| "test".to_string()),
            assigned_at: cell_id.map(|_| now),
            plan_tier: Some("free".to_string()),
            warehouse_kind: Some("shared".to_string()),
            requested_min_replica_memory_gb: Some(8),
            requested_max_replica_memory_gb: Some(8),
            requested_num_replicas: Some(1),
            applied_min_replica_memory_gb: Some(8),
            applied_max_replica_memory_gb: Some(8),
            applied_num_replicas: Some(1),
            endpoint: "http://default:@127.0.0.1:8123/instantml_test_route".to_string(),
            database: "instantml_test_route".to_string(),
            username: "tenant".to_string(),
            password_secret_ref: Some("secret://tenant".to_string()),
            password_ciphertext: None,
            schema_version: Some(crate::metric_store::METRIC_SCHEMA_VERSION),
            service_id: None,
            created_at: now,
            updated_at: now,
            error: None,
        }
    }

    #[sqlx::test]
    async fn postgres_chokepoint_writes_through_and_rebuilds(pool: sqlx::PgPool) {
        let store = store_with_control_db(ControlDb::from_pool(pool));
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "wt@example.com".to_string(),
            display_name: None,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        // persist_locked is the single chokepoint every control write funnels
        // through; with a control_db set it lands in Postgres, not the CH log.
        store
            .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
            .await
            .unwrap();
        assert!(store
            .control_db()
            .unwrap()
            .get_user(user.id)
            .await
            .unwrap()
            .is_some());

        // The projection rebuild reads live state back from Postgres.
        store.rebuild().await.unwrap();
        assert!(store.data.lock().await.users.contains_key(&user.id));
    }

    #[sqlx::test]
    async fn postgres_chokepoint_rejects_duplicate_org_slug(pool: sqlx::PgPool) {
        let store = store_with_control_db(ControlDb::from_pool(pool));
        let mut org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "acme".to_string(),
            name: "Acme".to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 5,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        store
            .persist_locked("organization", org.id, &org.id.to_string(), &org)
            .await
            .unwrap();

        // A *different* org claiming the same slug is rejected by the DB
        // constraint — the concurrent-signup race the event log lost.
        org.id = Uuid::new_v4();
        let err = store
            .persist_locked("organization", org.id, &org.id.to_string(), &org)
            .await
            .unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::CONFLICT);
    }

    #[sqlx::test]
    async fn create_user_persists_and_is_idempotent_via_postgres(pool: sqlx::PgPool) {
        let store = store_with_control_db(ControlDb::from_pool(pool));
        let request = || CreateUserRequest {
            email: Some("u@example.com".to_string()),
            primary_email: None,
            provider: Some("test".to_string()),
            provider_subject: Some("subj".to_string()),
            email_verified: None,
            display_name: Some("U".to_string()),
            avatar_url: None,
        };
        let first = create_user(&store, request()).await.unwrap();
        // Same identity → same user, no duplicate row.
        let second = create_user(&store, request()).await.unwrap();
        assert_eq!(first.id, second.id);

        let db = store.control_db().unwrap();
        assert_eq!(db.list_users().await.unwrap().len(), 1);
        assert_eq!(db.load_identities().await.unwrap().len(), 1);
        // Projection mirrors Postgres.
        assert!(store.data.lock().await.users.contains_key(&first.id));
    }

    #[sqlx::test]
    async fn data_plane_refresh_picks_up_postgres_and_preserves_tenant_data(pool: sqlx::PgPool) {
        let store = store_with_control_db(ControlDb::from_pool(pool));
        let control_db = store.control_db().unwrap();

        // A tenant run is already lazily loaded into this instance's projection.
        let run_id = Uuid::new_v4();
        {
            let mut data = store.data.lock().await;
            data.insert_run(replay_run(LOCAL_ORG_ID, run_id, "running"));
        }

        // Another instance (the control plane) writes a user straight to Postgres.
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "refresh@example.com".to_string(),
            display_name: None,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        control_db.upsert_user(&user).await.unwrap();

        // Not visible to this instance until it refreshes (no write-through here).
        assert!(!store.data.lock().await.users.contains_key(&user.id));

        // The data-plane refresh pulls the new control state from Postgres...
        store.refresh_control_records_for_auth_miss().await.unwrap();
        assert!(store.data.lock().await.users.contains_key(&user.id));

        // ...without clobbering the already-loaded tenant run.
        assert!(store.data.lock().await.runs.contains_key(&run_id));
    }

    #[sqlx::test]
    async fn current_data_cell_registration_heartbeats_postgres(pool: sqlx::PgPool) {
        let mut store = store_with_control_db(ControlDb::from_pool(pool));
        store.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());
        let control_db = store.control_db().unwrap();

        let stored = store
            .refresh_current_data_cell_registration(control_db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.cell_id, "free-us-central1-a");
        assert_eq!(stored.environment, "test");
        assert_eq!(stored.region, "us-central1");
        assert_eq!(stored.status, "open");
        assert!(stored.last_health_at.is_some());
        assert_eq!(stored.last_backup_at, None);

        assert!(store
            .data
            .lock()
            .await
            .data_cells
            .contains_key("free-us-central1-a"));
        assert_eq!(control_db.load_data_cells().await.unwrap(), vec![stored]);
    }

    #[sqlx::test]
    async fn data_cell_writer_lease_preserves_combined_and_local_write_compatibility(
        pool: sqlx::PgPool,
    ) {
        let local = store_without_control_db();
        assert!(!local
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Combined)
            .await
            .unwrap());

        let hosted_combined = store_with_control_db(ControlDb::from_pool(pool));
        assert!(!hosted_combined
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Combined)
            .await
            .unwrap());
    }

    #[sqlx::test]
    async fn hosted_data_cell_writer_lease_fails_closed_without_cell_id(pool: sqlx::PgPool) {
        let store = store_with_control_db(ControlDb::from_pool(pool));
        let error = store
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Data)
            .await
            .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.safe_code(), "cell_writer_unavailable");

        let readiness = store
            .data_cell_writer_lease_readiness(ServicePlaneRole::Data)
            .await;
        assert!(readiness.required);
        assert!(!readiness.ready);
        assert_eq!(readiness.code.as_deref(), Some("cell_writer_unavailable"));
    }

    #[sqlx::test]
    async fn hosted_data_cell_writer_readiness_does_not_acquire_lease(pool: sqlx::PgPool) {
        let control_db = ControlDb::from_pool(pool);
        let mut store = store_with_control_db(control_db.clone());
        store.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());
        store
            .refresh_current_data_cell_registration(&control_db)
            .await
            .unwrap();

        let readiness = store
            .data_cell_writer_lease_readiness(ServicePlaneRole::Data)
            .await;
        assert!(readiness.required);
        assert!(!readiness.ready);
        assert_eq!(readiness.code.as_deref(), Some("cell_writer_unavailable"));
        assert!(control_db
            .load_data_cell_writer_lease("free-us-central1-a")
            .await
            .unwrap()
            .is_none());
    }

    #[sqlx::test]
    async fn hosted_data_cell_writer_lease_allows_one_store_to_mutate(pool: sqlx::PgPool) {
        let control_db = ControlDb::from_pool(pool);
        let mut first = store_with_control_db(control_db.clone());
        first.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());
        first
            .refresh_current_data_cell_registration(&control_db)
            .await
            .unwrap();

        let mut second = store_with_control_db(control_db.clone());
        second.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());

        assert!(first
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Data)
            .await
            .unwrap());
        let error = second
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Data)
            .await
            .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.safe_code(), "cell_writer_unavailable");

        let readiness = first
            .data_cell_writer_lease_readiness(ServicePlaneRole::Data)
            .await;
        assert!(readiness.required);
        assert!(readiness.ready);
        assert_eq!(readiness.code, None);
    }

    #[sqlx::test]
    async fn hosted_data_cell_writer_lease_rejects_stale_store_after_takeover(pool: sqlx::PgPool) {
        let control_db = ControlDb::from_pool(pool);
        let mut first = store_with_control_db(control_db.clone());
        first.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());
        first
            .refresh_current_data_cell_registration(&control_db)
            .await
            .unwrap();
        assert!(first
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Data)
            .await
            .unwrap());

        sqlx::query(
            "UPDATE data_cell_writer_leases \
             SET heartbeat_at = clock_timestamp() - interval '2 seconds', \
                 expires_at = clock_timestamp() - interval '1 second' \
             WHERE cell_id = $1",
        )
        .bind("free-us-central1-a")
        .execute(control_db.pool())
        .await
        .unwrap();

        let mut second = store_with_control_db(control_db.clone());
        second.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());
        assert!(second
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Data)
            .await
            .unwrap());

        first.data_cell_writer_lease.lock().await.verified_until = None;
        let error = first
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Data)
            .await
            .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.safe_code(), "cell_writer_unavailable");
    }

    #[sqlx::test]
    async fn hosted_data_cell_writer_lease_rejects_disabled_cell_on_renewal(pool: sqlx::PgPool) {
        let control_db = ControlDb::from_pool(pool);
        let mut store = store_with_control_db(control_db.clone());
        store.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());
        store
            .refresh_current_data_cell_registration(&control_db)
            .await
            .unwrap();
        assert!(store
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Data)
            .await
            .unwrap());

        sqlx::query("UPDATE data_cells SET status = 'disabled' WHERE cell_id = $1")
            .bind("free-us-central1-a")
            .execute(control_db.pool())
            .await
            .unwrap();
        store.data_cell_writer_lease.lock().await.verified_until = None;

        let error = store
            .ensure_data_cell_writer_lease_for_mutation(ServicePlaneRole::Data)
            .await
            .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.safe_code(), "cell_writer_unavailable");

        let readiness = store
            .data_cell_writer_lease_readiness(ServicePlaneRole::Data)
            .await;
        assert!(readiness.required);
        assert!(!readiness.ready);
        assert_eq!(readiness.code.as_deref(), Some("cell_writer_unavailable"));
    }

    #[tokio::test]
    async fn hosted_data_cell_writer_rejects_org_routed_to_another_cell() {
        let mut store = store_without_control_db();
        store.hosted_clickhouse = Some(hosted_clickhouse_config());
        store.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());
        let org_id = Uuid::new_v4();
        store
            .data
            .lock()
            .await
            .insert_tenant_route(test_tenant_route(org_id, Some("free-us-central1-b")));

        let error = store
            .ensure_org_routed_to_current_data_cell(org_id, ServicePlaneRole::Data)
            .await
            .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.safe_code(), "cell_writer_unavailable");

        store
            .data
            .lock()
            .await
            .insert_tenant_route(test_tenant_route(org_id, None));
        assert!(store
            .ensure_org_routed_to_current_data_cell(org_id, ServicePlaneRole::Data)
            .await
            .unwrap());
    }

    #[sqlx::test]
    async fn hosted_data_cell_writer_uses_authoritative_control_route(pool: sqlx::PgPool) {
        let control_db = ControlDb::from_pool(pool);
        let org_id = Uuid::new_v4();
        control_db
            .upsert_org(&replay_org(org_id, "free"))
            .await
            .unwrap();
        control_db
            .upsert_data_cell(&test_data_cell("free-us-central1-a"))
            .await
            .unwrap();
        control_db
            .upsert_data_cell(&test_data_cell("free-us-central1-b"))
            .await
            .unwrap();

        let route = test_tenant_route(org_id, None);
        control_db
            .upsert_tenant_route_with_placement(
                &route,
                Some(&TenantRoutePlacement {
                    environment: "test".to_string(),
                    cell_id: "free-us-central1-a".to_string(),
                    actor: "test".to_string(),
                    reason: "test".to_string(),
                }),
            )
            .await
            .unwrap();

        let mut store = store_with_control_db(control_db.clone());
        store.hosted_clickhouse = Some(hosted_clickhouse_config());
        store.cell_routing.heartbeat_data_cell_id = Some("free-us-central1-a".to_string());
        store.rebuild().await.unwrap();
        assert!(store
            .ensure_org_routed_to_current_data_cell(org_id, ServicePlaneRole::Data)
            .await
            .unwrap());

        let mut moved = route;
        moved.cell_id = Some("free-us-central1-b".to_string());
        control_db
            .upsert_tenant_route_with_placement(
                &moved,
                Some(&TenantRoutePlacement {
                    environment: "test".to_string(),
                    cell_id: "free-us-central1-b".to_string(),
                    actor: "test".to_string(),
                    reason: "move".to_string(),
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .data
                .lock()
                .await
                .tenant_routes
                .get(&org_id)
                .and_then(|route| route.cell_id.as_deref()),
            Some("free-us-central1-a")
        );

        let error = store
            .ensure_org_routed_to_current_data_cell(org_id, ServicePlaneRole::Data)
            .await
            .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.safe_code(), "cell_writer_unavailable");
    }

    #[test]
    fn infer_data_cell_region_handles_zone_suffixed_labels() {
        assert_eq!(infer_data_cell_region("us-central1-a"), "us-central1");
        assert_eq!(infer_data_cell_region("free-us-central1-a"), "us-central1");
        assert_eq!(infer_data_cell_region("custom-cell"), "unknown");
    }

    #[sqlx::test]
    async fn create_organization_commits_org_and_owner_atomically(pool: sqlx::PgPool) {
        let store = store_with_control_db(ControlDb::from_pool(pool));
        let owner = UserRow {
            id: Uuid::new_v4(),
            primary_email: "owner@example.com".to_string(),
            display_name: None,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        store
            .control_db()
            .unwrap()
            .create_user_with_identity(
                &owner,
                &crate::control_repo::NewIdentity {
                    provider: "test".to_string(),
                    provider_subject: "owner".to_string(),
                },
            )
            .await
            .unwrap();

        let request = || CreateOrganizationRequest {
            slug: Some("acme".to_string()),
            name: Some("Acme".to_string()),
            plan_tier: None,
            owner_user_id: Some(owner.id),
            storage_choice: None,
        };
        let org = create_organization(&store, request()).await.unwrap();

        let db = store.control_db().unwrap();
        // Org and owner membership both present — never one without the other.
        assert!(db.get_org(org.id).await.unwrap().is_some());
        assert!(db.membership_for(org.id, owner.id).await.unwrap().is_some());

        // A second org with the same slug is rejected and leaves no orphan.
        let err = create_organization(&store, request()).await.unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::CONFLICT);
        assert_eq!(db.load_orgs().await.unwrap().len(), 1);
    }

    fn replay_row<T: Serialize>(
        kind: &str,
        org_id: Uuid,
        entity_id: impl Into<String>,
        payload: &T,
        created_at_micros: i64,
    ) -> OperationalRecordRow {
        OperationalRecordRow {
            kind: kind.to_string(),
            org_id,
            entity_id: entity_id.into(),
            payload: serde_json::to_string(payload).unwrap(),
            created_at: datetime_from_micros(created_at_micros),
        }
    }

    fn replay_project(org_id: Uuid, project_id: Uuid, name: &str) -> ProjectRow {
        ProjectRow {
            id: project_id,
            org_id,
            name: name.to_string(),
            description: None,
            created_at: epoch(),
        }
    }

    fn replay_org(org_id: Uuid, plan: &str) -> OrganizationRow {
        OrganizationRow {
            id: org_id,
            slug: format!("org-{org_id}"),
            name: "Replay Org".to_string(),
            plan_tier: plan.to_string(),
            account_type: "business".to_string(),
            seat_limit: plan_tier(plan).included_seats,
            created_by_user_id: None,
            created_at: epoch(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        }
    }

    fn replay_run(org_id: Uuid, run_id: Uuid, status: &str) -> RunRow {
        RunRow {
            id: run_id,
            org_id,
            project_id: Uuid::from_u128(200),
            project: "project".to_string(),
            name: "train".to_string(),
            status: status.to_string(),
            config: json!({}),
            tags: vec![],
            metadata: json!({}),
            created_at: epoch(),
            started_at: epoch(),
            finished_at: None,
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        }
    }

    fn replay_run_control(org_id: Uuid, run_id: Uuid, state: &str) -> RunControlRow {
        RunControlRow {
            org_id,
            run_id,
            stop_request_id: Some(Uuid::from_u128(9_999)),
            stop_state: state.to_string(),
            reason: Some("bad sweep".to_string()),
            completion_message: None,
            actor: Some("user:reviewer".to_string()),
            requested_at: Some(epoch()),
            acknowledged_at: (state == "acknowledged" || state == "completed").then_some(epoch()),
            completed_at: (state == "completed").then_some(epoch()),
            updated_at: epoch(),
        }
    }

    #[test]
    fn run_control_replay_drives_display_status_without_status_change() {
        let org_id = Uuid::from_u128(1);
        let running_id = Uuid::from_u128(10);
        let failed_id = Uuid::from_u128(11);
        let mut data = StoreData::default();
        data.apply_operational_records(
            vec![
                replay_row(
                    "run",
                    org_id,
                    running_id.to_string(),
                    &replay_run(org_id, running_id, "running"),
                    1,
                ),
                replay_row(
                    "run_control",
                    org_id,
                    running_id.to_string(),
                    &replay_run_control(org_id, running_id, "acknowledged"),
                    2,
                ),
                replay_row(
                    "run",
                    org_id,
                    failed_id.to_string(),
                    &replay_run(org_id, failed_id, "failed"),
                    3,
                ),
                replay_row(
                    "run_control",
                    org_id,
                    failed_id.to_string(),
                    &replay_run_control(org_id, failed_id, "completed"),
                    4,
                ),
            ],
            ReplayScope::All,
        )
        .unwrap();

        let running = data.runs.get(&running_id).unwrap();
        assert_eq!(
            run_control_display_status(running, run_control_for(&data, running)),
            "stopping"
        );
        let failed = data.runs.get(&failed_id).unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(
            run_control_display_status(failed, run_control_for(&data, failed)),
            "stopped"
        );
    }

    #[test]
    fn display_status_filter_matches_derived_control_state() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(10);
        let query = HashMap::from([("display_status".to_string(), "stopping".to_string())]);
        let mut data = StoreData::default();
        data.insert_run(replay_run(org_id, run_id, "running"));
        let run = data.runs.get(&run_id).unwrap().clone();
        data.insert_run_control(replay_run_control(org_id, run_id, "requested"));

        assert!(run_matches_display_status(&data, &query, &run));
    }

    #[tokio::test]
    async fn display_status_search_and_sort_use_run_control_state() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let running_id = Uuid::from_u128(10);
        let stopping_id = Uuid::from_u128(11);
        let stopped_id = Uuid::from_u128(12);
        {
            let mut data = store.data.lock().await;
            let mut running = replay_run(org_id, running_id, "running");
            running.name = "running".to_string();
            let mut stopping = replay_run(org_id, stopping_id, "running");
            stopping.name = "stopping".to_string();
            let mut stopped = replay_run(org_id, stopped_id, "failed");
            stopped.name = "stopped".to_string();
            data.insert_run(running);
            data.insert_run(stopping);
            data.insert_run(stopped);
            data.insert_run_control(replay_run_control(org_id, stopping_id, "requested"));
            data.insert_run_control(replay_run_control(org_id, stopped_id, "completed"));
        }

        let matches = filtered_runs(
            &store,
            &ctx,
            &HashMap::from([("q".to_string(), "status:stopping".to_string())]),
        )
        .await
        .unwrap();
        assert_eq!(
            matches.iter().map(|run| run.id).collect::<Vec<_>>(),
            vec![stopping_id]
        );

        let sorted = filtered_runs(
            &store,
            &ctx,
            &HashMap::from([("sort_by".to_string(), "status".to_string())]),
        )
        .await
        .unwrap();
        assert_eq!(
            sorted.iter().map(|run| run.id).collect::<Vec<_>>(),
            vec![running_id, stopped_id, stopping_id]
        );
    }

    #[tokio::test]
    async fn compare_matching_runs_appends_reference_within_filtered_scope() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let selected_id = Uuid::from_u128(101);
        let reference_id = Uuid::from_u128(102);
        let other_project_id = Uuid::from_u128(103);
        {
            let mut data = store.data.lock().await;
            let mut selected = replay_run(org_id, selected_id, "finished");
            selected.name = "new-candidate".to_string();
            selected.project = "cartpole".to_string();
            selected.created_at = epoch() + ChronoDuration::seconds(30);
            selected.started_at = selected.created_at;
            selected.config = json!({ "lr": 0.001 });

            let mut reference = replay_run(org_id, reference_id, "finished");
            reference.name = "old-reference".to_string();
            reference.project = "cartpole".to_string();
            reference.created_at = epoch() + ChronoDuration::seconds(10);
            reference.started_at = reference.created_at;
            reference.config = json!({ "lr": 0.01 });

            let mut other_project = replay_run(org_id, other_project_id, "finished");
            other_project.name = "wrong-project".to_string();
            other_project.project = "iris".to_string();
            other_project.created_at = epoch() + ChronoDuration::seconds(60);
            other_project.started_at = other_project.created_at;

            data.insert_run(selected);
            data.insert_run(reference);
            data.insert_run(other_project);
        }

        let payload = compare_matching_runs(
            &store,
            &ctx,
            CompareMatchingRunsRequest {
                project: Some("cartpole".to_string()),
                q: None,
                status: None,
                display_status: None,
                sort_by: Some("created".to_string()),
                metric_key: None,
                limit: Some(1),
                reference_run_id: Some(reference_id),
                diff_only: Some(true),
                include_rows: Some(true),
            },
        )
        .await
        .unwrap();

        assert_eq!(payload["total_matching_runs"], json!(2));
        assert_eq!(
            payload["selected_run_ids"],
            json!([selected_id.to_string(), reference_id.to_string()])
        );
        assert_eq!(payload["truncated"]["runs"], json!(true));
        assert_eq!(
            payload["candidates"][1]["selection_reason"],
            json!("reference")
        );
        let rows = payload["rows"].as_array().unwrap();
        assert!(rows
            .iter()
            .any(|row| row["path"] == json!("config/lr") && row["different"] == json!(true)));

        let summary_only = compare_matching_runs(
            &store,
            &ctx,
            CompareMatchingRunsRequest {
                project: Some("cartpole".to_string()),
                q: None,
                status: None,
                display_status: None,
                sort_by: Some("created".to_string()),
                metric_key: None,
                limit: Some(1),
                reference_run_id: Some(reference_id),
                diff_only: Some(false),
                include_rows: Some(false),
            },
        )
        .await
        .unwrap();
        assert_eq!(summary_only["reference_run_id"], json!(reference_id));
        assert_eq!(summary_only["rows"], json!([]));

        let err = compare_matching_runs(
            &store,
            &ctx,
            CompareMatchingRunsRequest {
                project: Some("cartpole".to_string()),
                q: None,
                status: None,
                display_status: None,
                sort_by: Some("created".to_string()),
                metric_key: None,
                limit: Some(1),
                reference_run_id: Some(other_project_id),
                diff_only: Some(false),
                include_rows: Some(false),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn compare_matching_runs_status_evidence_uses_display_status() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let running_id = Uuid::from_u128(111);
        let stopping_id = Uuid::from_u128(112);
        let stopped_id = Uuid::from_u128(113);
        {
            let mut data = store.data.lock().await;
            let mut running = replay_run(org_id, running_id, "running");
            running.name = "running".to_string();
            let mut stopping = replay_run(org_id, stopping_id, "running");
            stopping.name = "stopping".to_string();
            let mut stopped = replay_run(org_id, stopped_id, "failed");
            stopped.name = "stopped".to_string();
            data.insert_run(running);
            data.insert_run(stopping);
            data.insert_run(stopped);
            data.insert_run_control(replay_run_control(org_id, stopping_id, "requested"));
            data.insert_run_control(replay_run_control(org_id, stopped_id, "completed"));
        }

        let payload = compare_matching_runs(
            &store,
            &ctx,
            CompareMatchingRunsRequest {
                project: None,
                q: None,
                status: None,
                display_status: None,
                sort_by: Some("status".to_string()),
                metric_key: None,
                limit: Some(3),
                reference_run_id: None,
                diff_only: Some(false),
                include_rows: Some(false),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            payload["selected_run_ids"],
            json!([
                running_id.to_string(),
                stopped_id.to_string(),
                stopping_id.to_string()
            ])
        );
        let sort_values = payload["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|candidate| candidate["sort_value"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            sort_values,
            vec![json!("running"), json!("stopped"), json!("stopping")]
        );
    }

    #[test]
    fn completed_control_does_not_expose_stopped_for_running_replay() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(10);
        let run = replay_run(org_id, run_id, "running");
        let control = replay_run_control(org_id, run_id, "completed");

        assert_eq!(run_control_display_status(&run, Some(&control)), "running");
    }

    #[test]
    fn run_control_summary_redacts_actor_identifiers() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(10);
        let run = replay_run(org_id, run_id, "running");
        let mut control = replay_run_control(org_id, run_id, "requested");

        control.actor = Some("user:2c8b6f5c-0f8d-4ce0-8f3c-34bdc2c7f72d".to_string());
        assert_eq!(
            run_control_summary(&run, Some(&control), RunControlPrivacy::Public)["actor"],
            json!("user")
        );

        control.actor = Some("api_key:7f9d7c64-4663-49db-b268-b9da6464da52".to_string());
        assert_eq!(
            run_control_summary(&run, Some(&control), RunControlPrivacy::Public)["actor"],
            json!("api_key")
        );

        control.actor = Some("local".to_string());
        assert_eq!(
            run_control_summary(&run, Some(&control), RunControlPrivacy::Public)["actor"],
            json!("local")
        );

        control.actor = Some("unexpected".to_string());
        assert_eq!(
            run_control_summary(&run, Some(&control), RunControlPrivacy::Public)["actor"],
            json!("unknown")
        );
    }

    #[test]
    fn run_control_summary_keeps_reason_private_by_default() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(10);
        let run = replay_run(org_id, run_id, "running");
        let mut control = replay_run_control(org_id, run_id, "requested");
        control.completion_message = Some("checkpoint saved".to_string());

        let public = run_control_summary(&run, Some(&control), RunControlPrivacy::Public);
        assert!(public.get("reason").is_none());
        assert!(public.get("completion_message").is_none());

        let private = run_control_summary(&run, Some(&control), RunControlPrivacy::Private);
        assert_eq!(private["reason"], json!("bad sweep"));
        assert_eq!(private["completion_message"], json!("checkpoint saved"));
    }

    #[tokio::test]
    async fn completed_stop_ack_is_idempotent_and_preserves_request_audit() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let run_id = Uuid::from_u128(42);
        {
            let mut data = store.data.lock().await;
            data.insert_run(replay_run(org_id, run_id, "running"));
        }

        let requested = request_run_stop(
            &store,
            &ctx,
            run_id,
            json!({"reason": "bad sweep"}),
            StopRunRequest {
                reason: Some("bad sweep".to_string()),
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(requested["run_control"]["actor"], json!("local"));
        let stop_request_id = Uuid::parse_str(
            requested["run_control"]["stop_request_id"]
                .as_str()
                .unwrap(),
        )
        .unwrap();

        let completed = acknowledge_run_stop(
            &store,
            &ctx,
            run_id,
            StopAckRequest {
                stop_request_id,
                state: "completed".to_string(),
                message: Some("sdk cleanup".to_string()),
            },
        )
        .await
        .unwrap();
        assert_eq!(completed["run_control"]["display_status"], json!("stopped"));
        assert_eq!(completed["run_control"]["reason"], json!("bad sweep"));

        let first_control = {
            let data = store.data.lock().await;
            let run = data.runs.get(&run_id).unwrap();
            assert_eq!(run.status, "failed");
            data.run_controls.get(&run_id).cloned().unwrap()
        };

        let retried = acknowledge_run_stop(
            &store,
            &ctx,
            run_id,
            StopAckRequest {
                stop_request_id,
                state: "completed".to_string(),
                message: Some("do not overwrite".to_string()),
            },
        )
        .await
        .unwrap();
        assert_eq!(retried["run_control"]["display_status"], json!("stopped"));
        assert_eq!(retried["run_control"]["reason"], json!("bad sweep"));

        let retry_control = store
            .data
            .lock()
            .await
            .run_controls
            .get(&run_id)
            .cloned()
            .unwrap();
        assert_eq!(retry_control.completed_at, first_control.completed_at);
        assert_eq!(retry_control.updated_at, first_control.updated_at);
        assert_eq!(retry_control.reason.as_deref(), Some("bad sweep"));
        assert_eq!(
            retry_control.completion_message.as_deref(),
            Some("sdk cleanup")
        );
    }

    #[tokio::test]
    async fn stop_request_idempotency_replays_and_rejects_different_body() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let run_id = Uuid::from_u128(45);
        {
            let mut data = store.data.lock().await;
            data.insert_run(replay_run(org_id, run_id, "running"));
        }

        let raw = json!({"reason": "bad sweep"});
        let first = request_run_stop(
            &store,
            &ctx,
            run_id,
            raw.clone(),
            StopRunRequest {
                reason: Some("bad sweep".to_string()),
            },
            Some("stop-key".to_string()),
        )
        .await
        .unwrap();
        let retried = request_run_stop(
            &store,
            &ctx,
            run_id,
            raw,
            StopRunRequest {
                reason: Some("bad sweep".to_string()),
            },
            Some("stop-key".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(
            first["run_control"]["stop_request_id"],
            retried["run_control"]["stop_request_id"]
        );

        let err = request_run_stop(
            &store,
            &ctx,
            run_id,
            json!({"reason": "different"}),
            StopRunRequest {
                reason: Some("different".to_string()),
            },
            Some("stop-key".to_string()),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn stop_request_idempotency_waits_for_inflight_replay() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let run_id = Uuid::from_u128(47);
        let key = "stop-inflight".to_string();
        let raw = json!({"reason": "bad sweep"});
        let request_hash = hash_idempotency(run_id, &raw).unwrap();
        {
            let mut data = store.data.lock().await;
            data.insert_run(replay_run(org_id, run_id, "running"));
        }
        store.reserve_idempotency_key(org_id, &key).await.unwrap();

        let writer = store.clone();
        let writer_key = key.clone();
        let writer_hash = request_hash.clone();
        tokio::spawn(async move {
            tokio::time::sleep(StdDuration::from_millis(50)).await;
            writer.data.lock().await.idempotency.insert(
                (org_id, writer_key.clone()),
                IdempotencyRecord {
                    org_id,
                    key: writer_key.clone(),
                    request_hash: writer_hash,
                    response_json: json!({
                        "run_id": run_id,
                        "ok": true,
                        "run_control": {"stop_request_id": "inflight-stop"},
                    }),
                    expires_at: Utc::now() + ChronoDuration::days(7),
                },
            );
            writer.release_idempotency_key(org_id, &writer_key).await;
        });

        let replayed = request_run_stop(
            &store,
            &ctx,
            run_id,
            raw,
            StopRunRequest {
                reason: Some("bad sweep".to_string()),
            },
            Some(key),
        )
        .await
        .unwrap();

        assert_eq!(
            replayed["run_control"]["stop_request_id"],
            json!("inflight-stop")
        );
    }

    #[tokio::test]
    async fn stop_idempotency_replay_rechecks_project_scope() {
        let store = store_without_control_db();
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(47);
        let allowed_project_id = Uuid::from_u128(100);
        let blocked_project_id = Uuid::from_u128(101);
        let mut run = replay_run(org_id, run_id, "running");
        run.project_id = allowed_project_id;
        let blocked_ctx = RequestContext {
            org_id,
            auth: Some(AuthContext {
                org_id,
                api_key_id: Uuid::from_u128(200),
                service_account_id: Uuid::from_u128(201),
                project_id: Some(blocked_project_id),
                scopes: vec!["runs:control".to_string()],
            }),
            session: None,
        };
        {
            store.data.lock().await.insert_run(run);
        }

        let single_key = "stop-single-project-scope".to_string();
        let single_raw = json!({"reason": "bad sweep"});
        let single_hash = hash_idempotency(run_id, &single_raw).unwrap();
        store.data.lock().await.idempotency.insert(
            (org_id, single_key.clone()),
            IdempotencyRecord {
                org_id,
                key: single_key.clone(),
                request_hash: single_hash,
                response_json: json!({
                    "run_id": run_id,
                    "ok": true,
                    "run_control": {"stop_request_id": "cached-single-stop"},
                }),
                expires_at: Utc::now() + ChronoDuration::days(7),
            },
        );
        let single_error = request_run_stop(
            &store,
            &blocked_ctx,
            run_id,
            single_raw,
            StopRunRequest {
                reason: Some("bad sweep".to_string()),
            },
            Some(single_key),
        )
        .await
        .unwrap_err();
        assert_eq!(single_error.status(), axum::http::StatusCode::FORBIDDEN);

        let bulk_key = "stop-bulk-project-scope".to_string();
        let bulk_raw = json!({"reason": "bad sweep", "run_ids": [run_id]});
        let bulk_hash = hash_idempotency(Uuid::nil(), &bulk_raw).unwrap();
        store.data.lock().await.idempotency.insert(
            (org_id, bulk_key.clone()),
            IdempotencyRecord {
                org_id,
                key: bulk_key.clone(),
                request_hash: bulk_hash,
                response_json: json!({
                    "results": [{
                        "run_id": run_id,
                        "ok": true,
                        "run_control": {"stop_request_id": "cached-bulk-stop"},
                    }],
                    "limit": MAX_BULK_STOP_RUNS,
                }),
                expires_at: Utc::now() + ChronoDuration::days(7),
            },
        );
        let bulk_error = request_bulk_run_stop(
            &store,
            &blocked_ctx,
            bulk_raw,
            StopRunsRequest {
                run_ids: vec![run_id],
                reason: Some("bad sweep".to_string()),
            },
            Some(bulk_key),
        )
        .await
        .unwrap_err();
        assert_eq!(bulk_error.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn stop_request_bypasses_billing_write_gate() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let run_id = Uuid::from_u128(46);
        {
            let mut data = store.data.lock().await;
            data.insert_billing_account(BillingAccountProjection {
                schema_version: 1,
                org_id,
                access_state: BILLING_CHECKOUT_PENDING.to_string(),
                plan_tier: "pro".to_string(),
                effective_plan_tier: "free".to_string(),
                requested_plan_tier: Some("pro".to_string()),
                paid_extra_seats: 0,
                stripe_customer_id: None,
                stripe_subscription_id: None,
                subscription_status: None,
                current_period_start: None,
                current_period_end: None,
                cancel_at_period_end: false,
                grace_until: None,
                pending_intent_id: None,
                message: Some("checkout pending".to_string()),
                updated_at: Utc::now(),
            });
            data.insert_run(replay_run(org_id, run_id, "running"));
        }

        let response = request_run_stop(
            &store,
            &ctx,
            run_id,
            json!({"reason": "stop spend"}),
            StopRunRequest {
                reason: Some("stop spend".to_string()),
            },
            None,
        )
        .await
        .unwrap();

        assert_eq!(response["ok"], json!(true));
        assert_eq!(response["run_control"]["display_status"], json!("stopping"));
    }

    #[tokio::test]
    async fn stop_signal_poll_interval_uses_plan_tier() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let run_id = Uuid::from_u128(48);
        {
            let mut data = store.data.lock().await;
            data.insert_org(replay_org(org_id, "premium"));
            data.insert_run(replay_run(org_id, run_id, "running"));
        }

        request_run_stop(
            &store,
            &ctx,
            run_id,
            json!({"reason": "bad sweep"}),
            StopRunRequest {
                reason: Some("bad sweep".to_string()),
            },
            None,
        )
        .await
        .unwrap();

        let premium = run_stop_signal(&store, &ctx, run_id).await.unwrap();
        assert_eq!(premium["poll_after_seconds"], json!(10));

        store
            .data
            .lock()
            .await
            .insert_org(replay_org(org_id, "pro"));
        let pro = run_stop_signal(&store, &ctx, run_id).await.unwrap();
        assert_eq!(pro["poll_after_seconds"], json!(15));

        store
            .data
            .lock()
            .await
            .insert_org(replay_org(org_id, "free"));
        let free = run_stop_signal(&store, &ctx, run_id).await.unwrap();
        assert_eq!(free["poll_after_seconds"], json!(30));
    }

    #[tokio::test]
    async fn terminal_patch_marks_active_stop_without_completion() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let run_id = Uuid::from_u128(43);
        {
            let mut data = store.data.lock().await;
            data.insert_run(replay_run(org_id, run_id, "running"));
        }

        request_run_stop(
            &store,
            &ctx,
            run_id,
            json!({"reason": "bad sweep"}),
            StopRunRequest {
                reason: Some("bad sweep".to_string()),
            },
            None,
        )
        .await
        .unwrap();
        update_run(
            &store,
            &ctx,
            run_id,
            UpdateRunRequest {
                status: Some("finished".to_string()),
                tags: None,
                notes: None,
            },
        )
        .await
        .unwrap();

        let signal = run_stop_signal(&store, &ctx, run_id).await.unwrap();
        assert_eq!(signal["stop_requested"], json!(false));
        let control = store
            .data
            .lock()
            .await
            .run_controls
            .get(&run_id)
            .cloned()
            .unwrap();
        assert_eq!(control.stop_state, "terminal_without_completion");

        let repaired = acknowledge_run_stop(
            &store,
            &ctx,
            run_id,
            StopAckRequest {
                stop_request_id: control.stop_request_id.unwrap(),
                state: "completed".to_string(),
                message: Some("late cleanup".to_string()),
            },
        )
        .await
        .unwrap();
        assert_eq!(repaired["run_control"]["display_status"], json!("stopped"));
        assert_eq!(
            store.data.lock().await.runs.get(&run_id).unwrap().status,
            "finished"
        );
    }

    #[tokio::test]
    async fn bulk_stop_dedupes_duplicate_run_ids() {
        let store = store_without_control_db();
        let ctx = RequestContext::local();
        let org_id = ctx.org_id;
        let run_id = Uuid::from_u128(44);
        {
            let mut data = store.data.lock().await;
            data.insert_run(replay_run(org_id, run_id, "running"));
        }

        let result = request_bulk_run_stop(
            &store,
            &ctx,
            json!({"run_ids": [run_id], "reason": "bad sweep"}),
            StopRunsRequest {
                run_ids: vec![run_id, run_id],
                reason: Some("bad sweep".to_string()),
            },
            None,
        )
        .await
        .unwrap();

        assert_eq!(result["results"].as_array().unwrap().len(), 1);
        assert_eq!(
            store
                .data
                .lock()
                .await
                .run_controls
                .get(&run_id)
                .unwrap()
                .stop_state,
            "requested"
        );
    }

    #[test]
    fn tenant_local_integer_ids_are_keyed_by_org() {
        let org_a = Uuid::from_u128(1);
        let org_b = Uuid::from_u128(2);
        let run_a = Uuid::from_u128(10);
        let run_b = Uuid::from_u128(20);
        let mut data = StoreData::default();

        data.insert_attribute(AttributeRow {
            id: 1,
            org_id: org_a,
            run_id: run_a,
            path: "score".to_string(),
            kind: "float_series".to_string(),
            step: Some(1.0),
            logged_at: Some(epoch()),
            value: json!(0.8),
            summary: json!({}),
            artifact_id: None,
            created_at: epoch(),
        });
        data.insert_attribute(AttributeRow {
            id: 1,
            org_id: org_b,
            run_id: run_b,
            path: "score".to_string(),
            kind: "float_series".to_string(),
            step: Some(1.0),
            logged_at: Some(epoch()),
            value: json!(0.9),
            summary: json!({}),
            artifact_id: None,
            created_at: epoch(),
        });

        assert_eq!(data.attributes.len(), 2);
        assert_eq!(data.attributes[&(org_a, 1)].run_id, run_a);
        assert_eq!(data.attributes[&(org_b, 1)].run_id, run_b);
        assert_eq!(data.allocate_attribute_id(org_a), 2);
        assert_eq!(data.allocate_attribute_id(org_b), 2);
    }

    #[test]
    fn operational_replay_sorts_records_and_keeps_latest_projection() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(10);
        let older = replay_run(org_id, run_id, "running");
        let newer = replay_run(org_id, run_id, "finished");
        let mut data = StoreData::default();

        let stats = data
            .apply_operational_records(
                vec![
                    replay_row("run", org_id, run_id.to_string(), &newer, 20),
                    replay_row("run", org_id, run_id.to_string(), &older, 10),
                ],
                ReplayScope::All,
            )
            .unwrap();

        assert_eq!(stats.latest_record_micros, 20);
        assert_eq!(data.runs.len(), 1);
        assert_eq!(data.runs[&run_id].status, "finished");
        assert_eq!(
            data.runs_by_org_created
                .get(&(org_id, epoch(), run_id))
                .copied(),
            Some(run_id)
        );
    }

    #[test]
    fn operational_replay_is_deterministic_for_equal_timestamps() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(10);
        let first = replay_row(
            "run",
            org_id,
            run_id.to_string(),
            &replay_run(org_id, run_id, "alpha"),
            10,
        );
        let second = replay_row(
            "run",
            org_id,
            run_id.to_string(),
            &replay_run(org_id, run_id, "zulu"),
            10,
        );
        let mut left = StoreData::default();
        let mut right = StoreData::default();

        left.apply_operational_records(vec![first.clone(), second.clone()], ReplayScope::All)
            .unwrap();
        right
            .apply_operational_records(vec![second, first], ReplayScope::All)
            .unwrap();

        assert_eq!(left.runs[&run_id].status, right.runs[&run_id].status);
    }

    #[test]
    fn record_clock_micros_roundtrip_preserves_microsecond_precision() {
        // Tenant operational records still use microsecond timestamps for
        // deterministic replay ordering.
        let original = DateTime::<Utc>::from_timestamp(1_700_000_000, 123_456_000).unwrap();
        let micros = original.timestamp_micros();
        let restored = datetime_from_micros(micros);
        assert_eq!(restored, original);
        assert_eq!(restored.timestamp_micros(), micros);
    }

    #[test]
    fn changed_tenant_routes_returns_only_final_route_differences() {
        fn test_route(org_id: Uuid, endpoint: &str) -> TenantRouteRecord {
            TenantRouteRecord {
                org_id,
                status: "ready".to_string(),
                provisioner: "database".to_string(),
                cell_id: None,
                route_version: 1,
                placement_reason: None,
                assigned_at: None,
                plan_tier: Some("free".to_string()),
                warehouse_kind: Some("shared".to_string()),
                requested_min_replica_memory_gb: Some(8),
                requested_max_replica_memory_gb: Some(8),
                requested_num_replicas: Some(1),
                applied_min_replica_memory_gb: Some(8),
                applied_max_replica_memory_gb: Some(8),
                applied_num_replicas: Some(1),
                endpoint: endpoint.to_string(),
                database: "default".to_string(),
                username: "default".to_string(),
                password_secret_ref: Some("config:tenant_base_url_password".to_string()),
                password_ciphertext: None,
                schema_version: Some(crate::metric_store::METRIC_SCHEMA_VERSION),
                service_id: None,
                created_at: epoch(),
                updated_at: epoch(),
                error: None,
            }
        }

        let stable_org_id = Uuid::from_u128(1);
        let changed_org_id = Uuid::from_u128(2);
        let new_org_id = Uuid::from_u128(3);
        let stable = test_route(stable_org_id, "https://stable.example.com:8443");
        let changed_before = test_route(changed_org_id, "https://old.example.com:8443");
        let changed_after = test_route(changed_org_id, "https://new.example.com:8443");
        let new_route = test_route(new_org_id, "https://new.example.com:8443");
        let previous = BTreeMap::from([
            (stable_org_id, stable.clone()),
            (changed_org_id, changed_before),
        ]);
        let current = BTreeMap::from([
            (stable_org_id, stable),
            (changed_org_id, changed_after),
            (new_org_id, new_route),
        ]);

        assert_eq!(
            changed_tenant_routes(&previous, &current),
            BTreeSet::from([changed_org_id, new_org_id])
        );
    }

    #[test]
    fn tenant_replay_rejects_record_from_another_org() {
        let expected = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let project_id = Uuid::from_u128(20);
        let project = replay_project(other, project_id, "other");
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row(
                    "project",
                    other,
                    project_id.to_string(),
                    &project,
                    10,
                )],
                ReplayScope::Tenant(expected),
            )
            .is_err());
    }

    #[test]
    fn tenant_replay_rejects_payload_from_another_org() {
        let expected = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let project_id = Uuid::from_u128(20);
        let project = replay_project(other, project_id, "misrouted");
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row(
                    "project",
                    expected,
                    project_id.to_string(),
                    &project,
                    10,
                )],
                ReplayScope::Tenant(expected),
            )
            .is_err());
    }

    #[test]
    fn tenant_replay_rejects_table_rows_entity_mismatch() {
        let org_id = Uuid::from_u128(1);
        let rows = TableRowsRecord {
            attribute_id: 7,
            rows: Vec::new(),
        };
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row("table_rows", org_id, "8", &rows, 10)],
                ReplayScope::Tenant(org_id),
            )
            .is_err());
    }

    #[test]
    fn tenant_replay_rejects_usage_snapshot_for_another_org() {
        let expected = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let snapshot = json!({
            "organizations": [{
                "org_id": other.to_string(),
                "usage": {}
            }]
        });
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row("usage_daily", expected, "daily", &snapshot, 10)],
                ReplayScope::Tenant(expected),
            )
            .is_err());
    }

    #[test]
    fn api_usage_rollup_replay_keeps_latest_absolute_count() {
        let org_id = Uuid::from_u128(1);
        let window_started_at = Utc
            .with_ymd_and_hms(2026, 5, 23, 18, 42, 0)
            .single()
            .unwrap();
        let mut older = ApiRequestUsageRollup {
            org_id,
            period: "2026-05".to_string(),
            rollup_key: "2026-05-23T18:42Z:general:instance-a".to_string(),
            request_count: 3,
            class: "general".to_string(),
            instance_id: "instance-a".to_string(),
            window_started_at,
            updated_at: window_started_at,
            created_at: window_started_at,
        };
        let mut newer = older.clone();
        newer.request_count = 8;
        newer.updated_at = window_started_at + ChronoDuration::seconds(7);
        let entity_id = newer.entity_id();
        let mut data = StoreData::default();

        data.apply_operational_records(
            vec![
                replay_row("api_usage_monthly", org_id, &entity_id, &newer, 20),
                replay_row("api_usage_monthly", org_id, &entity_id, &older, 10),
            ],
            ReplayScope::All,
        )
        .unwrap();

        assert_eq!(data.api_request_usage_for_org_period(org_id, "2026-05"), 8);

        older.request_count = 2;
        data.insert_api_request_usage_rollup(older);
        assert_eq!(data.api_request_usage_for_org_period(org_id, "2026-05"), 8);
    }

    #[test]
    fn tenant_replay_rejects_api_usage_entity_mismatch() {
        let org_id = Uuid::from_u128(1);
        let window_started_at = Utc
            .with_ymd_and_hms(2026, 5, 23, 18, 42, 0)
            .single()
            .unwrap();
        let rollup = ApiRequestUsageRollup {
            org_id,
            period: "2026-05".to_string(),
            rollup_key: "2026-05-23T18:42Z:general:instance-a".to_string(),
            request_count: 3,
            class: "general".to_string(),
            instance_id: "instance-a".to_string(),
            window_started_at,
            updated_at: window_started_at,
            created_at: window_started_at,
        };
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row(
                    "api_usage_monthly",
                    org_id,
                    "wrong-entity",
                    &rollup,
                    10,
                )],
                ReplayScope::Tenant(org_id),
            )
            .is_err());
    }

    // -----------------------------------------------------------------------
    // Shared-cell cross-org isolation regression test (non-negotiable).
    //
    // This test verifies that operational records for org A and org B can
    // coexist in the same StoreData (as they do in the shared cell) without
    // leaking across tenant boundaries.
    //
    // The shared cell stores records for many orgs in one ClickHouse database,
    // isolated only by org_id predicates. The `ReplayScope::Tenant` guard
    // already enforces org_id on replay; this test verifies the in-process
    // index also keeps them separate for every entity type we use today.
    // -----------------------------------------------------------------------
    #[test]
    fn shared_cell_cross_org_isolation_in_process_index() {
        let org_a = Uuid::from_u128(0xAAAA);
        let org_b = Uuid::from_u128(0xBBBB);
        let project_a = Uuid::from_u128(0xA000);
        let project_b = Uuid::from_u128(0xB000);
        let run_a = Uuid::from_u128(0xA001);
        let run_b = Uuid::from_u128(0xB001);

        // Build shared-cell records for both orgs using ReplayScope::All
        // (the shared cell replays all orgs together on startup).
        let mut data = StoreData::default();

        let project_a_row = replay_project(org_a, project_a, "project-a");
        let project_b_row = replay_project(org_b, project_b, "project-b");
        let run_a_row = replay_run(org_a, run_a, "finished");
        let run_b_row = replay_run(org_b, run_b, "running");

        data.apply_operational_records(
            vec![
                replay_row("project", org_a, project_a.to_string(), &project_a_row, 1),
                replay_row("project", org_b, project_b.to_string(), &project_b_row, 2),
                replay_row("run", org_a, run_a.to_string(), &run_a_row, 3),
                replay_row("run", org_b, run_b.to_string(), &run_b_row, 4),
            ],
            ReplayScope::All,
        )
        .unwrap();

        // Org A can see its own run.
        let a_runs: Vec<_> = data.runs.values().filter(|r| r.org_id == org_a).collect();
        assert_eq!(a_runs.len(), 1, "org A should see exactly 1 run");
        assert_eq!(a_runs[0].id, run_a);
        assert_eq!(a_runs[0].status, "finished");

        // Org A cannot see org B's run.
        let a_sees_b = data
            .runs
            .values()
            .any(|r| r.org_id == org_a && r.id == run_b);
        assert!(!a_sees_b, "org A must not see org B's run");

        // Org B can see its own run.
        let b_runs: Vec<_> = data.runs.values().filter(|r| r.org_id == org_b).collect();
        assert_eq!(b_runs.len(), 1, "org B should see exactly 1 run");
        assert_eq!(b_runs[0].id, run_b);
        assert_eq!(b_runs[0].status, "running");

        // Org B cannot see org A's run.
        let b_sees_a = data
            .runs
            .values()
            .any(|r| r.org_id == org_b && r.id == run_a);
        assert!(!b_sees_a, "org B must not see org A's run");

        // Projects are also isolated.
        let a_projects: Vec<_> = data
            .projects
            .values()
            .filter(|p| p.org_id == org_a)
            .collect();
        let b_projects: Vec<_> = data
            .projects
            .values()
            .filter(|p| p.org_id == org_b)
            .collect();
        assert_eq!(a_projects.len(), 1);
        assert_eq!(b_projects.len(), 1);
        assert_eq!(a_projects[0].id, project_a);
        assert_eq!(b_projects[0].id, project_b);

        // Attributes are keyed by (org_id, attribute_id), so the same
        // attribute_id value for two different orgs must not collide.
        data.insert_attribute(AttributeRow {
            id: 1,
            org_id: org_a,
            run_id: run_a,
            path: "loss".to_string(),
            kind: "float_series".to_string(),
            step: Some(1.0),
            logged_at: Some(epoch()),
            value: json!(0.1),
            summary: json!({}),
            artifact_id: None,
            created_at: epoch(),
        });
        data.insert_attribute(AttributeRow {
            id: 1,
            org_id: org_b,
            run_id: run_b,
            path: "loss".to_string(),
            kind: "float_series".to_string(),
            step: Some(1.0),
            logged_at: Some(epoch()),
            value: json!(0.9),
            summary: json!({}),
            artifact_id: None,
            created_at: epoch(),
        });

        // Each org has its own attribute slot with id=1.
        assert_eq!(data.attributes.len(), 2);
        assert_eq!(data.attributes[&(org_a, 1)].run_id, run_a);
        assert_eq!(data.attributes[&(org_b, 1)].run_id, run_b);
        // Values do not cross.
        assert_ne!(
            data.attributes[&(org_a, 1)].value,
            data.attributes[&(org_b, 1)].value
        );
    }

    #[test]
    fn shared_cell_tenant_replay_validation_rejects_cross_org_records() {
        // When replaying a specific org from the shared cell, records from
        // another org must be rejected by ReplayScope::Tenant.
        let org_a = Uuid::from_u128(0xAAAA);
        let org_b = Uuid::from_u128(0xBBBB);
        let project_b = Uuid::from_u128(0xB000);
        let project_b_row = replay_project(org_b, project_b, "project-b");
        let mut data = StoreData::default();

        // Trying to replay an org_b record while scoped to org_a must fail.
        let result = data.apply_operational_records(
            vec![replay_row(
                "project",
                org_b,
                project_b.to_string(),
                &project_b_row,
                10,
            )],
            ReplayScope::Tenant(org_a),
        );
        assert!(
            result.is_err(),
            "replaying a cross-org record in shared cell must be rejected"
        );

        // And the record must not have been inserted into the index.
        assert!(
            data.projects.is_empty(),
            "cross-org project must not leak into org_a index"
        );
    }

    fn replay_report(
        org_id: Uuid,
        report_id: Uuid,
        title: &str,
        visibility: &str,
        deleted: bool,
    ) -> ReportRow {
        ReportRow {
            schema_version: 1,
            id: report_id,
            org_id,
            project_id: None,
            title: title.to_string(),
            description: None,
            blocks: json!([{ "kind": "horizontal_rule" }]),
            created_at: epoch(),
            updated_at: epoch(),
            author_user_id: None,
            share_token: None,
            share_token_issued_at: None,
            visibility: visibility.to_string(),
            deleted_at: if deleted { Some(epoch()) } else { None },
        }
    }

    #[test]
    fn report_replay_keeps_latest_revision_and_honors_soft_delete() {
        let org_id = Uuid::from_u128(1);
        let report_id = Uuid::from_u128(101);
        let initial = replay_report(org_id, report_id, "draft", "private", false);
        let renamed = replay_report(org_id, report_id, "final", "org", false);
        let removed = replay_report(org_id, report_id, "final", "org", true);
        let mut data = StoreData::default();
        data.apply_operational_records(
            vec![
                replay_row("report", org_id, report_id.to_string(), &initial, 10),
                replay_row("report", org_id, report_id.to_string(), &renamed, 20),
                replay_row("report", org_id, report_id.to_string(), &removed, 30),
            ],
            ReplayScope::All,
        )
        .unwrap();
        let row = data.reports.get(&report_id).expect("report present");
        assert_eq!(row.title, "final");
        assert_eq!(row.visibility, "org");
        assert!(row.deleted_at.is_some(), "tombstone retained on replay");
    }

    #[test]
    fn report_replay_rejects_cross_org_record_in_tenant_scope() {
        // Confirm the tenant-replay invariant: an operational record whose
        // outer `org_id` does not match the expected tenant must be rejected
        // (even before any per-kind payload validation). This is what keeps
        // a leaky record from one org's table from being applied into
        // another's in-memory projection during shared-cell replay.
        let expected_org = Uuid::from_u128(1);
        let other_org = Uuid::from_u128(2);
        let report_id = Uuid::from_u128(202);
        let cross_org = replay_report(other_org, report_id, "leak", "private", false);
        let mut data = StoreData::default();
        let result = data.apply_operational_records(
            vec![replay_row(
                "report",
                other_org,
                report_id.to_string(),
                &cross_org,
                10,
            )],
            ReplayScope::Tenant(expected_org),
        );
        assert!(
            result.is_err(),
            "tenant-scoped replay must reject reports from a different org_id"
        );
        assert!(
            data.reports.is_empty(),
            "rejected report must not leak into tenant index"
        );
    }
}
