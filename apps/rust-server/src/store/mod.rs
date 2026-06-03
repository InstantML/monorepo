use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
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
mod export;
mod imports;
mod objects;
mod reports;
mod runs;
mod summaries;
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
pub use export::*;
pub use imports::*;
pub use objects::*;
pub use reports::*;
pub use runs::*;
use summaries::*;
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
    config::{AppConfig, ByocClickHouseConfig, HostedClickHouseConfig},
    control_db::ControlDb,
    control_repo::{ApiKeyWithHash, NewSession},
    control_store::{ControlRecordRow, ControlStore},
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
        CompleteArtifactUploadFile, CompleteArtifactUploadRequest, ConsoleLogInput,
        CreateApiKeyRequest, CreateArtifactInputEdgeRequest, CreateArtifactRequest,
        CreateAttributesRequest, CreateConsoleLogsRequest, CreateCurrentUserOrganizationRequest,
        CreateInvitationRequest, CreateObjectRequest, CreateOrganizationRequest,
        CreateProjectRequest, CreateReportRequest, CreateRunForkRequest, CreateRunRequest,
        CreateUserRequest, CreatedAuthSession, CurrentUserOrganizationCreateResponse,
        DashboardPreferenceRow, DeleteArtifactAliasRequest, DeleteArtifactVersionRequest,
        DevGoogleAuthRequest, EmailDeliveryRow, InitialInvitationCreateResult,
        InitialOrganizationInvitation, InitiateArtifactUploadRequest, InvitationPreviewPayload,
        InvitationTokenRequest, LogMetricsRequest, LogRankMetricsRequest, MembershipRow,
        MetricSeriesRow, OnboardingApiKey, OrgInvitationRow, OrganizationMembershipSummary,
        OrganizationRoleCapabilities, OrganizationRow, ProjectRow, ProvisioningStatusPayload,
        PublicApiKeyRow, PublicInvitationRow, RankCoveragePoint, RankHeatmapPoint,
        RankMetricLimits, RankMetricTruncation, RankMetricsSummaryResponse, RankOutlierPoint,
        RankReducerPoint, RenewArtifactUploadRequest, ReportRow, RequestContext,
        ReserveSeatRequest, RunRow, SaveWorkspaceViewRequest, SeatRow, SeatUserRow,
        ServiceAccountRow, SessionContext, SetArtifactAliasRequest, UpdateArtifactRetentionRequest,
        UpdateDashboardPreferencesRequest, UpdateReportRequest, UpdateRunRequest,
        UploadArtifactRequest, UserRow, UserSessionRow, VersionedArtifactManifestEntryInput,
        WorkspaceViewRow, WorkspaceViewSummary, BILLING_CANCELED, BILLING_CHECKOUT_PENDING,
        BILLING_FREE_ACTIVE, BILLING_PAID_ACTIVE, BILLING_PAST_DUE_GRACE,
        BILLING_READ_ONLY_PAYMENT_REQUIRED, DEFAULT_CONSOLE_LOG_LIMIT, DEFAULT_METRIC_LIMIT,
        DEFAULT_RUN_LIMIT, GIB_BYTES, MAX_CONSOLE_LOG_LIMIT, MAX_CONSOLE_LOG_LINES_PER_BATCH,
        MAX_CONSOLE_LOG_MESSAGE_BYTES, MAX_METRICS_PER_BATCH, MAX_METRIC_LIMIT,
        MAX_METRIC_SERIES_RUN_IDS, MAX_METRIC_SERIES_TOTAL_POINTS, MAX_RANK_CANONICAL_ROWS,
        MAX_RANK_HEATMAP_CELLS, MAX_RANK_OUTLIERS, MAX_RANK_WORLD_SIZE, MAX_RUN_LIMIT,
        MAX_TEXT_BYTES, PLAN_FREE, PLAN_PREMIUM, PLAN_PRO, STORAGE_CHOICE_CUSTOMER_CLICKHOUSE,
        STORAGE_CHOICE_HOSTED, STORAGE_STATE_LOCKED, STORAGE_STATE_READY,
        STORAGE_STATE_UNCONFIGURED, STORAGE_STATE_VALIDATING,
    },
    errors::{AppError, AppResult},
    metric_store::{
        ConsoleLogInsertRow, ConsoleLogReadRow, M4BucketRow, MetricPointRow as ChMetricPointRow,
        MetricStore, OperationalRecordRow, RankMetricCanonicalRow,
        RankMetricPointRow as ChRankMetricPointRow, RankMetricStepWindow, SeriesReadRow,
        SeriesSortMode,
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
];
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
    control_store: Option<ControlStore>,
    /// Postgres control plane. When present, it is the system of record for
    /// users/orgs/memberships/sessions/keys/billing/tenant routes, replacing the
    /// in-memory `StoreData` projection. `None` keeps the legacy ClickHouse
    /// event-log + projection path (single-binary local mode and not-yet-migrated
    /// tests).
    control_db: Option<ControlDb>,
    hosted_clickhouse: Option<HostedClickHouseConfig>,
    byoc_clickhouse: ByocClickHouseConfig,
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
    /// Coalesces calls to `refresh_control_records`. Reading the entire
    /// control table on every authenticated request hammered ClickHouse Cloud
    /// under burst load, causing transient `client error (Connect)` failures.
    /// We skip the refresh if the last one ran within `CONTROL_REFRESH_MIN_INTERVAL`.
    last_control_refresh: Arc<Mutex<Option<Instant>>>,
}

const CONTROL_REFRESH_MIN_INTERVAL: StdDuration = StdDuration::from_secs(2);

/// Cadence for the data-plane background refresh task.
///
/// 2s matches the throttle in `refresh_control_records` and bounds the worst-case
/// staleness for security-sensitive control changes (api-key revocation, seat
/// removal). If this becomes a load problem, the right fix is push-based
/// invalidation (Tier 3), not a longer interval.
const CONTROL_REFRESH_BACKGROUND_INTERVAL: StdDuration = StdDuration::from_secs(2);

impl Store {
    pub async fn connect(
        metric_store: MetricStore,
        control_store: Option<ControlStore>,
        control_db: Option<ControlDb>,
        hosted_clickhouse: Option<HostedClickHouseConfig>,
        byoc_clickhouse: ByocClickHouseConfig,
    ) -> AppResult<Self> {
        // Build the shared-cell MetricStore when INSTANTML_SHARED_CELL_URL is set.
        let shared_cell_metric_store =
            build_shared_cell_metric_store(hosted_clickhouse.as_ref()).await?;
        let store = Self {
            metric_store,
            control_store,
            control_db,
            hosted_clickhouse,
            byoc_clickhouse,
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
    /// methods route through this; `None` falls back to the in-memory
    /// projection during the migration.
    pub fn control_db(&self) -> Option<&ControlDb> {
        self.control_db.as_ref()
    }

    async fn rebuild(&self) -> AppResult<()> {
        let (data, latest_record_micros) = if let Some(control_db) = &self.control_db {
            // Postgres is the system of record: load the live control state
            // directly. Unlike the event-log replay, startup cost is bounded by
            // the number of live entities, not the lifetime mutation history.
            (self.load_data_from_postgres(control_db).await?, 0)
        } else if let Some(control_store) = &self.control_store {
            // First load: no cursor, so this still pulls every control record.
            let records = control_store.load_records(None).await?;
            let mut data = StoreData::default();
            let stats = data.apply_control_records(records)?;
            (data, stats.latest_record_micros)
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
    /// projection from the control-plane table. Returns the join handle so the
    /// caller (typically `main::serve`) can manage shutdown.
    ///
    /// This is the data plane's mechanism for picking up control mutations
    /// (new org, new api key, revoked api key, etc.) made by the control plane.
    /// Before Tier 2, every authenticated request on the data plane invoked
    /// `refresh_control_records` synchronously — moving it off the hot path
    /// removes a per-request ClickHouse round trip and the burst-load failure
    /// mode that PR #32 had to mask with a throttle.
    ///
    /// No-op when no control store is configured (single-binary local mode).
    pub fn spawn_control_refresh_task(&self) -> Option<JoinHandle<()>> {
        // Refresh against whichever control backing is configured: Postgres when
        // present (the data plane re-reads control state from it), else the
        // legacy ClickHouse control store.
        if self.control_store.is_none() && self.control_db.is_none() {
            return None;
        }
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

    async fn refresh_control_records_inner(&self, force: bool) -> AppResult<()> {
        // Postgres is the system of record when configured: the data plane
        // re-reads the live control state from it (there is no event-log cursor).
        if let Some(control_db) = &self.control_db {
            return self.refresh_from_postgres(control_db, force).await;
        }
        let Some(control_store) = &self.control_store else {
            return Ok(());
        };
        // Coalesce bursty calls — explicit on-demand refreshes from mutation
        // handlers (e.g. just after revoking an api key) may overlap with the
        // background task. Without the throttle a sustained write burst could
        // issue a full-table SELECT per request and trip ClickHouse Cloud rate
        // limits. PR #32 introduced this guard; Tier 2 moved the polling off
        // the request hot path, but the guard is still cheap insurance for
        // explicit callers.
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
        // Snapshot the current record clock and only ask for records strictly
        // newer than it. The clock is microsecond-precision and matches the
        // ClickHouse `DateTime64(6, 'UTC')` column.
        //
        // Concurrent refreshes are bounded by `CONTROL_REFRESH_MIN_INTERVAL`,
        // so at most one fetch can be in flight per the throttle window.
        // Either way, the post-fetch `max` against the live clock keeps it
        // monotonic — replaying records we already applied is idempotent.
        let since_micros = *self.record_clock_micros.lock().await;
        let since = if since_micros > 0 {
            Some(datetime_from_micros(since_micros))
        } else {
            None
        };
        let records = match control_store.load_records(since).await {
            Ok(records) => records,
            Err(error) => {
                self.mark_control_refresh_failure(error.message()).await;
                return Err(error);
            }
        };
        if records.is_empty() {
            self.mark_control_refresh_success().await;
            return Ok(());
        }
        let applied = {
            let mut data = self.data.lock().await;
            let previous_routes = data.tenant_routes.clone();
            data.apply_control_records(records).map(|stats| {
                let changed_routes = changed_tenant_routes(&previous_routes, &data.tenant_routes);
                (stats, changed_routes)
            })
        };
        let (stats, changed_tenant_routes) = match applied {
            Ok(applied) => applied,
            Err(error) => {
                self.mark_control_refresh_failure(error.message()).await;
                return Err(error);
            }
        };
        if !changed_tenant_routes.is_empty() {
            let mut loaded = self.tenant_loaded.lock().await;
            let mut stores = self.tenant_metric_stores.lock().await;
            for org_id in &changed_tenant_routes {
                loaded.remove(org_id);
                stores.remove(org_id);
            }
        }
        let mut clock = self.record_clock_micros.lock().await;
        *clock = (*clock).max(stats.latest_record_micros);
        self.mark_control_refresh_success().await;
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
        if self.control_store.is_none()
            && self.control_db.is_none()
            && self.metric_store.database().ends_with("_test")
        {
            return Ok(());
        }
        if self.is_control_record_kind(kind) {
            if let Some(control_store) = &self.control_store {
                let scope = control_record_scope(kind);
                let control = ControlRecordRow {
                    event_id: Uuid::new_v4(),
                    scope: scope.to_string(),
                    kind: row.kind,
                    org_id: if scope == "global" {
                        Uuid::nil()
                    } else {
                        org_id
                    },
                    entity_id: row.entity_id,
                    payload: row.payload,
                    created_at: row.created_at,
                };
                return control_store.insert_record(&control).await;
            }
            // Hosted control records are global/control-plane data. If a test
            // or legacy hosted configuration lacks a dedicated control store,
            // keep the legacy primary-store fallback local to `metric_store`
            // instead of routing through `metric_store_for_persist`, which may
            // consult tenant routing and try to re-lock StoreData.
            return self.metric_store.insert_operational_record(&row).await;
        }
        let metric_store = self.metric_store_for_persist(org_id).await?;
        metric_store.insert_operational_record(&row).await
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
            tenants::TENANT_ROUTE_KIND => {
                control_db
                    .upsert_tenant_route(&parse_payload(payload)?)
                    .await
            }
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

    fn apply_control_records(
        &mut self,
        mut records: Vec<ControlRecordRow>,
    ) -> AppResult<ReplayStats> {
        records.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        let mut stats = ReplayStats::default();
        for record in records {
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
            "project" => self.insert_project(parse_payload(payload)?),
            "project_delete" => self.apply_project_delete(parse_payload(payload)?),
            "run" => self.insert_run(parse_payload(payload)?),
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
    let backing_ready = match &store.control_store {
        Some(control_store) => control_store.ready().await,
        None => true,
    };
    // Probe Postgres too: once it is the system of record (control_store may be
    // unset post-cutover) a Postgres outage must surface as not-ready rather
    // than being masked by a `None` ClickHouse backing.
    let control_db_ready = match &store.control_db {
        Some(control_db) => control_db.ready().await,
        None => true,
    };
    backing_ready && control_db_ready && store.control_projection_health().await.loaded
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlProjectionHealth {
    pub loaded: bool,
    pub refresh_degraded: bool,
}

fn control_record_scope(kind: &str) -> &'static str {
    match kind {
        "user" | "identity" => "global",
        _ => "org",
    }
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

/// One control entity that could not be written to Postgres during backfill —
/// almost always a uniqueness collision (two orgs sharing a slug, two users a
/// email) that the old append-only log allowed but the constraints reject, or a
/// dangling foreign key. Reported rather than fatal so a single bad row does not
/// abort the whole migration; the operator resolves these before cutover.
#[derive(Debug, Clone, Serialize)]
pub struct BackfillIssue {
    pub kind: String,
    pub entity_id: String,
    pub message: String,
}

#[derive(Debug, Default, Serialize)]
pub struct BackfillReport {
    pub written: usize,
    pub issues: Vec<BackfillIssue>,
}

impl BackfillReport {
    fn note(&mut self, kind: &str, entity_id: String, result: AppResult<()>) {
        match result {
            Ok(()) => self.written += 1,
            Err(err) => self.issues.push(BackfillIssue {
                kind: kind.to_string(),
                entity_id,
                message: err.message().to_string(),
            }),
        }
    }
}

/// Backfill the ClickHouse control log into Postgres. Replays the full log into
/// a final-state projection (last-writer-wins per entity, keyed by id so
/// slug/email collisions are preserved rather than collapsed), then upserts each
/// entity. Idempotent — safe to re-run after resolving reported issues.
pub async fn run_control_backfill(
    control_store: &ControlStore,
    control_db: &ControlDb,
) -> AppResult<BackfillReport> {
    let records = control_store.load_records(None).await?;
    let mut data = StoreData::default();
    data.apply_control_records(records)?;
    backfill_data_to_postgres(&data, control_db).await
}

/// Write a materialized control projection to Postgres in foreign-key dependency
/// order, collecting per-row failures into the report instead of aborting.
async fn backfill_data_to_postgres(
    data: &StoreData,
    control_db: &ControlDb,
) -> AppResult<BackfillReport> {
    let mut report = BackfillReport::default();

    // users → identities (FK user) → orgs (FK created_by user) → memberships →
    // service accounts → api keys → sessions → the rest.
    for user in data.users.values() {
        report.note(
            "user",
            user.id.to_string(),
            control_db.upsert_user(user).await,
        );
    }
    for ((provider, subject), user_id) in &data.identities {
        report.note(
            "identity",
            format!("{provider}:{subject}"),
            control_db
                .upsert_identity(provider, subject, *user_id)
                .await,
        );
    }
    for org in data.organizations.values() {
        report.note(
            "organization",
            org.id.to_string(),
            control_db.upsert_org(org).await,
        );
    }
    for membership in data.memberships.values() {
        report.note(
            "membership",
            membership.id.to_string(),
            control_db.upsert_membership(membership).await,
        );
    }
    for account in data.service_accounts.values() {
        report.note(
            "service_account",
            account.id.to_string(),
            control_db.upsert_service_account(account).await,
        );
    }
    for key in data.api_keys.values() {
        report.note(
            "api_key",
            key.row.id.to_string(),
            control_db
                .upsert_api_key(&ApiKeyWithHash {
                    row: key.row.clone(),
                    key_hash: key.key_hash.clone(),
                })
                .await,
        );
    }
    for session in data.sessions.values() {
        report.note(
            "session",
            session.row.id.to_string(),
            control_db
                .upsert_session(&NewSession {
                    row: session.row.clone(),
                    token_hash: session.token_hash.clone(),
                })
                .await,
        );
    }
    for invitation in data.org_invitations.values() {
        report.note(
            "org_invitation",
            invitation.id.to_string(),
            control_db.upsert_org_invitation(invitation).await,
        );
    }
    for delivery in data.email_deliveries.values() {
        report.note(
            "email_delivery",
            delivery.id.to_string(),
            control_db.upsert_email_delivery(delivery).await,
        );
    }
    for pref in data.dashboard_preferences.values() {
        report.note(
            "dashboard_preference",
            format!("{}:{:?}", pref.org_id, pref.user_id),
            control_db.upsert_dashboard_preference(pref).await,
        );
    }
    for view in data.workspace_views.values() {
        report.note(
            "workspace_view",
            view.id.to_string(),
            control_db.upsert_workspace_view(view).await,
        );
    }
    for account in data.billing_accounts.values() {
        report.note(
            "billing_account",
            account.org_id.to_string(),
            control_db.upsert_billing_account(account).await,
        );
    }
    for intent in data.billing_checkout_intents.values() {
        report.note(
            "billing_checkout_intent",
            intent.id.to_string(),
            control_db.upsert_billing_checkout_intent(intent).await,
        );
    }
    for intent in data.billing_change_intents.values() {
        report.note(
            "billing_change_intent",
            intent.id.to_string(),
            control_db.upsert_billing_change_intent(intent).await,
        );
    }
    for subscription in data.billing_subscriptions.values() {
        report.note(
            "billing_subscription",
            subscription.stripe_subscription_id.clone(),
            control_db.upsert_billing_subscription(subscription).await,
        );
    }
    for event in data.billing_events.values() {
        report.note(
            "billing_event",
            event.stripe_event_id.clone(),
            control_db.upsert_billing_event(event).await,
        );
    }
    for usage_report in data.billing_usage_reports.values() {
        report.note(
            "billing_usage_report",
            usage_report.id.to_string(),
            control_db.upsert_billing_usage_report(usage_report).await,
        );
    }
    for route in data.tenant_routes.values() {
        report.note(
            "tenant_route",
            route.org_id.to_string(),
            control_db.upsert_tenant_route(route).await,
        );
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// Build a `Store` whose control plane is the given Postgres handle, with
    /// the rest of the dependencies stubbed. Used by the Postgres-backed
    /// chokepoint tests.
    fn store_with_control_db(control_db: ControlDb) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_pg_chokepoint_test",
                "TEST_CLICKHOUSE_URL",
            )
            .unwrap(),
            control_store: None,
            control_db: Some(control_db),
            hosted_clickhouse: None,
            byoc_clickhouse: crate::config::ByocClickHouseConfig {
                egress_cidrs: Vec::new(),
                egress_set_version: "test".to_string(),
                allow_private_endpoints: true,
                credential_store: crate::config::ByocCredentialStoreConfig::Disabled,
            },
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

    fn backfill_org(slug: &str) -> OrganizationRow {
        OrganizationRow {
            id: Uuid::new_v4(),
            slug: slug.to_string(),
            name: slug.to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 5,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        }
    }

    #[sqlx::test]
    async fn backfill_writes_projection_and_reports_slug_collision(pool: sqlx::PgPool) {
        let control_db = ControlDb::from_pool(pool);
        let mut data = StoreData::default();
        data.insert_user(UserRow {
            id: Uuid::new_v4(),
            primary_email: "bf@example.com".to_string(),
            display_name: None,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        });
        // Two distinct orgs sharing a slug — the silent duplication the old
        // append-only log allowed. The projection keeps both (keyed by id); the
        // backfill must persist one and report the other, not lose it quietly.
        data.insert_org(backfill_org("dup"));
        data.insert_org(backfill_org("dup"));

        let report = backfill_data_to_postgres(&data, &control_db).await.unwrap();

        // user + exactly one org written; the colliding org is reported.
        assert_eq!(report.written, 2);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].kind, "organization");
        assert_eq!(control_db.load_orgs().await.unwrap().len(), 1);
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

    fn control_replay_row<T: Serialize>(
        kind: &str,
        org_id: Uuid,
        entity_id: impl Into<String>,
        event_id: Uuid,
        payload: &T,
        created_at_micros: i64,
    ) -> ControlRecordRow {
        ControlRecordRow {
            event_id,
            scope: "org".to_string(),
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

    #[test]
    fn control_record_scope_keeps_user_identity_global() {
        assert_eq!(control_record_scope("user"), "global");
        assert_eq!(control_record_scope("identity"), "global");
        assert_eq!(control_record_scope("organization"), "org");
        assert_eq!(control_record_scope("api_key"), "org");
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
        // The record clock is `i64` microseconds since epoch. ClickHouse's
        // `DateTime64(6, 'UTC')` column is also microsecond-precision. The
        // incremental `load_records` path converts the clock into a
        // `DateTime<Utc>` via `datetime_from_micros` before binding it into
        // the `WHERE created_at > ?` predicate; if that conversion loses
        // resolution we'd silently re-fetch records we've already applied
        // (slow but safe) or, worse, skip records (silent data loss).
        //
        // Lock in the round-trip: a clock value computed from a real
        // `DateTime<Utc>` should produce a `DateTime<Utc>` equal to the
        // original when converted back.
        let original = DateTime::<Utc>::from_timestamp(1_700_000_000, 123_456_000).unwrap();
        let micros = original.timestamp_micros();
        let restored = datetime_from_micros(micros);
        assert_eq!(restored, original);
        assert_eq!(restored.timestamp_micros(), micros);
    }

    #[test]
    fn incremental_refresh_advances_clock_to_latest_record_micros() {
        // Simulates the per-refresh contract that `refresh_control_records`
        // depends on: after applying a batch of records, the clock advances
        // to the max `created_at` observed. A subsequent refresh would then
        // bind `since = datetime_from_micros(clock)` and only ask ClickHouse
        // for records strictly greater than that timestamp.
        let org_id = Uuid::from_u128(1);
        let mut data = StoreData::default();

        // First batch: full load (clock starts at 0, so `since = None` and
        // the query runs the legacy full scan).
        let stats_first = data
            .apply_control_records(vec![
                control_replay_row(
                    "organization",
                    org_id,
                    org_id.to_string(),
                    Uuid::from_u128(1),
                    &OrganizationRow {
                        id: org_id,
                        slug: "org".to_string(),
                        name: "First".to_string(),
                        plan_tier: "free".to_string(),
                        account_type: "business".to_string(),
                        seat_limit: 1,
                        created_by_user_id: None,
                        created_at: epoch(),
                        tenant_routing_tier: "dedicated".to_string(),
                        storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
                        storage_state: STORAGE_STATE_READY.to_string(),
                    },
                    100,
                ),
                control_replay_row(
                    "organization",
                    org_id,
                    org_id.to_string(),
                    Uuid::from_u128(2),
                    &OrganizationRow {
                        id: org_id,
                        slug: "org".to_string(),
                        name: "Second".to_string(),
                        plan_tier: "free".to_string(),
                        account_type: "business".to_string(),
                        seat_limit: 1,
                        created_by_user_id: None,
                        created_at: epoch(),
                        tenant_routing_tier: "dedicated".to_string(),
                        storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
                        storage_state: STORAGE_STATE_READY.to_string(),
                    },
                    200,
                ),
            ])
            .unwrap();
        let mut clock: i64 = 0;
        clock = clock.max(stats_first.latest_record_micros);
        assert_eq!(clock, 200);
        assert_eq!(data.organizations[&org_id].name, "Second");

        // Second batch: emulates what the next refresh would see — ClickHouse
        // returns only records with `created_at > since`, i.e. strictly newer
        // than the previous clock. Empty results (no churn) must not regress
        // the clock; new records must advance it.
        let stats_empty = data.apply_control_records(vec![]).unwrap();
        assert_eq!(stats_empty.latest_record_micros, 0);
        clock = clock.max(stats_empty.latest_record_micros);
        assert_eq!(
            clock, 200,
            "empty incremental refresh must not regress clock"
        );

        let stats_third = data
            .apply_control_records(vec![control_replay_row(
                "organization",
                org_id,
                org_id.to_string(),
                Uuid::from_u128(3),
                &OrganizationRow {
                    id: org_id,
                    slug: "org".to_string(),
                    name: "Third".to_string(),
                    plan_tier: "free".to_string(),
                    account_type: "business".to_string(),
                    seat_limit: 1,
                    created_by_user_id: None,
                    created_at: epoch(),
                    tenant_routing_tier: "dedicated".to_string(),
                    storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
                    storage_state: STORAGE_STATE_READY.to_string(),
                },
                300,
            )])
            .unwrap();
        clock = clock.max(stats_third.latest_record_micros);
        assert_eq!(clock, 300);
        assert_eq!(data.organizations[&org_id].name, "Third");
    }

    #[test]
    fn control_replay_uses_event_id_as_equal_timestamp_tiebreaker() {
        let org_id = Uuid::from_u128(1);
        let older = OrganizationRow {
            id: org_id,
            slug: "org".to_string(),
            name: "Older".to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 1,
            created_by_user_id: None,
            created_at: epoch(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        let newer = OrganizationRow {
            name: "Newer".to_string(),
            ..older.clone()
        };
        let older_event_id = Uuid::from_u128(1);
        let newer_event_id = Uuid::from_u128(2);
        let mut data = StoreData::default();

        let stats = data
            .apply_control_records(vec![
                control_replay_row(
                    "organization",
                    org_id,
                    org_id.to_string(),
                    newer_event_id,
                    &newer,
                    10,
                ),
                control_replay_row(
                    "organization",
                    org_id,
                    org_id.to_string(),
                    older_event_id,
                    &older,
                    10,
                ),
            ])
            .unwrap();

        assert_eq!(data.organizations[&org_id].name, "Newer");
        assert_eq!(stats.latest_record_micros, 10);
    }

    #[test]
    fn changed_tenant_routes_returns_only_final_route_differences() {
        fn test_route(org_id: Uuid, endpoint: &str) -> TenantRouteRecord {
            TenantRouteRecord {
                org_id,
                status: "ready".to_string(),
                provisioner: "database".to_string(),
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
