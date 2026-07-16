//! Single source of truth for the OpenAPI spec.
//!
//! Handlers in `handlers.rs` carry `#[utoipa::path(...)]` macros. The
//! [`ApiDoc`] struct here collects them via `#[openapi(paths(...), components(schemas(...)))]`.
//! At runtime, `GET /openapi.json` serves `ApiDoc::openapi()` filtered to the routes
//! the active service plane actually exposes.
//!
//! Adding a new endpoint:
//!  1. Annotate the handler with `#[utoipa::path(...)]` (method, path, security,
//!     `request_body`, `responses`, `tag`).
//!  2. Add the handler identifier to the `paths(...)` list below.
//!  3. If the handler introduces a new request or response shape, derive
//!     `ToSchema` on the type and add it to `components(schemas(...))`. For
//!     handlers that still build dynamic `serde_json::Value` blobs in the
//!     store layer, point the response at `JsonObjectResponse` rather than
//!     re-typing the dynamic structure here.
//!  4. Run `npm run codegen:api` and commit the regenerated
//!     `apps/rust-server/openapi.generated.json` and
//!     `apps/web/src/types/api.generated.ts`. CI's `verify:api-types` step
//!     fails the build if these are out of date.
//!
//! See `docs/design/2026-05-19-utoipa-migration.md` for context on why this
//! pattern replaced the legacy hand-rolled `openapi_json` index.
use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::{
    openapi::security::{ApiKey, ApiKeyValue, HttpAuthScheme, SecurityScheme},
    Modify, OpenApi, ToSchema,
};

use serde_json::Value;
use uuid::Uuid;

use crate::domain::{
    AbortArtifactUploadRequest, AdminApiKeySummary, AdminBillingSummary, AdminDataCellRouteCounts,
    AdminDataCellSummary, AdminDataCellsResponse, AdminOrgCounts, AdminOrganizationSummary,
    AdminOverviewQuerySummary, AdminOverviewResponse, AdminOverviewTotals, AdminPlanChangeRequest,
    AdminRiskItem, AdminStorageSummary, AdminUsageGauge, AdminUserIdentity, AdminUserOrgMembership,
    AdminUserSummary, ArtifactAliasRow, ArtifactCollectionInput, ArtifactCollectionRow,
    ArtifactEdgeRow, ArtifactManifestEntriesRecord, ArtifactManifestEntryRow, ArtifactUploadFile,
    ArtifactUploadSessionRow, ArtifactVersionRow, AttributeInput, AttributeRow, AuthSessionPayload,
    BillingAccountProjection, BillingCancelRequest, BillingChangeIntent, BillingCheckoutInfo,
    BillingCheckoutIntent, BillingCheckoutRequest, BillingCheckoutSyncRequest, BillingEventRecord,
    BillingPlanChangeRequest, BillingPortalRequest, BillingSeatChangeRequest,
    BillingSubscriptionRecord, BillingUsageReportRecord, ClerkAuthRequest,
    ClickHouseConnectionCreateRequest, ClickHouseConnectionRotateCredentialsRequest,
    ClickHouseConnectionStatus, ClickHouseConnectionValidateRequest,
    ClickHouseConnectionValidationResponse, CompareMatchingRunsRequest, CompleteArtifactUploadFile,
    CompleteArtifactUploadPart, CompleteArtifactUploadRequest, ConsoleLogInput, ConsoleLogLine,
    CreateApiKeyRequest, CreateArtifactInputEdgeRequest, CreateArtifactRequest,
    CreateAttributesRequest, CreateConsoleLogsRequest, CreateCurrentUserOrganizationRequest,
    CreateEmbedSessionRequest, CreateEmbedSessionResponse, CreateInvitationRequest,
    CreateObjectRequest, CreateOrganizationRequest, CreateProjectRequest, CreateReportRequest,
    CreateRunForkRequest, CreateRunRequest, CreateTraceEventsRequest, CreateUserRequest,
    CurrentUserOrganizationCreateResponse, DashboardPreferenceRow, DeleteArtifactAliasRequest,
    DeleteArtifactVersionRequest, DevGoogleAuthRequest, DeviceCodeClientInfo,
    DeviceCodeConfirmRequest, DeviceCodePollRequest, DeviceCodeStartRequest, EmbedCurrentSession,
    EmbedCurrentSessionResponse, EmbedFramePolicy, EmbedFramePolicyResponse, EmbedRunsDataRequest,
    EmbedSessionOptions, ImportWorkspaceViewRequest, InitialInvitationCreateResult,
    InitialOrganizationInvitation, InitiateArtifactUploadRequest, InvitationPreviewPayload,
    InvitationTokenRequest, LifecycleTransition, LogMetricsBatchPoint, LogMetricsBatchRequest,
    LogMetricsRequest, LogRankMetricsRequest, MembershipRow, MetricPointRow, MetricSeriesRow,
    OnboardingApiKey, OrganizationMembershipSummary, OrganizationRoleCapabilities, OrganizationRow,
    ProjectRow, ProvisioningStatusPayload, PublicApiKeyRow, PublicArtifactCollectionRow,
    PublicArtifactManifestEntryRow, PublicArtifactRow, PublicArtifactVersionRow,
    PublicEmbedSession, PublicInvitationRow, RankCoveragePoint, RankHeatmapPoint, RankMetricLimits,
    RankMetricTruncation, RankMetricsSummaryResponse, RankOutlierPoint, RankReducerPoint,
    RenewArtifactUploadRequest, ReportRow, ReportSummary, ReserveSeatRequest, RunControlRow,
    RunRow, SaveWorkspaceViewRequest, SeatRow, SeatUserRow, ServiceAccountRow,
    SetArtifactAliasRequest, StopAckRequest, StopRunRequest, StopRunsRequest,
    SwitchOrganizationRequest, TraceChildrenResponse, TraceDetailLimits, TraceDetailResponse,
    TraceDetailSummary, TraceDetailTruncation, TraceEventInput, TraceIngestResponse,
    TraceListResponse, TraceSpanItem, TraceStepBucket, TraceStepSummaryResponse, TraceSummaryItem,
    UpdateArtifactRetentionRequest, UpdateDashboardPreferencesRequest, UpdateReportRequest,
    UpdateRunRequest, UploadArtifactRequest, UserRow, UserSessionRow,
    VersionedArtifactManifestEntryInput, VersionedArtifactManifestInput, WorkspaceViewData,
    WorkspaceViewDataLimits, WorkspaceViewDataOptions, WorkspaceViewDataPanelResult,
    WorkspaceViewDataRequest, WorkspaceViewDataResponse, WorkspaceViewDeleteResponse,
    WorkspaceViewExportEnvelope, WorkspaceViewExportIntegrity, WorkspaceViewExportSource,
    WorkspaceViewExportedView, WorkspaceViewImportResponse, WorkspaceViewMetricSeries,
    WorkspaceViewRow, WorkspaceViewSummary,
};

// ============================================================================
// Envelope response types.
//
// Handlers return wrapped JSON (`{ "run": ... }`, `{ "projects": [...] }`).
// We model each envelope as a tiny struct here so utoipa emits a real
// `$ref`-backed schema for every endpoint.
// ============================================================================

#[derive(Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Serialize, ToSchema)]
pub struct WriterLeaseReadinessResponse {
    pub required: bool,
    pub ready: bool,
    pub code: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct ReadyzResponse {
    pub status: String,
    pub control_projection_loaded: bool,
    pub control_refresh_degraded: bool,
    pub write_ready: bool,
    pub writer_lease: WriterLeaseReadinessResponse,
}

#[derive(Serialize, ToSchema)]
pub struct AuthConfigResponse {
    pub dev_auth_enabled: bool,
    pub managed_clerk_enabled: bool,
    pub service_plane: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clerk_jwt_issuer: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct ProjectEnvelope {
    pub project: ProjectRow,
}

#[derive(Serialize, ToSchema)]
pub struct ProjectsEnvelope {
    pub projects: Vec<ProjectRow>,
}

#[derive(Serialize, ToSchema)]
pub struct RunEnvelope {
    pub run: RunRow,
}

/// Response for `POST /runs`. `created` is `false` for idempotent replay,
/// `mode="auto"` attach, or `mode="resume"`.
#[derive(Serialize, ToSchema)]
pub struct RunCreatedEnvelope {
    pub run: RunRow,
    pub created: bool,
}

#[derive(Serialize, ToSchema)]
pub struct RunSummaryEnvelope {
    pub run: RunSummaryRow,
}

#[derive(Serialize, ToSchema)]
pub struct RunsEnvelope {
    pub runs: Vec<RunRow>,
}

#[derive(Serialize, ToSchema)]
pub struct RunSummariesEnvelope {
    pub runs: Vec<RunSummaryRow>,
}

#[derive(Serialize, ToSchema)]
pub struct RunMetricAggregate {
    pub latest: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    pub variance: Option<f64>,
    pub count: i64,
    pub best_step: Option<f64>,
}

#[derive(Serialize, ToSchema)]
pub struct RunSummaryRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub project_id: Uuid,
    pub project: String,
    pub name: String,
    pub status: String,
    #[schema(value_type = Object)]
    pub config: Value,
    pub tags: Vec<String>,
    #[schema(value_type = Object)]
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_step: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_artifact_id: Option<Uuid>,
    pub latest_metrics: BTreeMap<String, Option<f64>>,
    pub metric_aggregates: BTreeMap<String, RunMetricAggregate>,
    pub metric_keys: Vec<String>,
    pub artifact_counts: BTreeMap<String, i64>,
    pub run_control: RunControlSummary,
}

#[derive(Serialize, ToSchema)]
pub struct RunControlSummary {
    pub stop_state: String,
    pub display_status: String,
    pub stop_request_id: Option<Uuid>,
    pub stop_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_message: Option<String>,
    pub actor: Option<String>,
    pub stop_requested_at: Option<DateTime<Utc>>,
    pub stop_acknowledged_at: Option<DateTime<Utc>>,
    pub stop_completed_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsagePeriod {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub range: String,
    pub timezone: String,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageFilters {
    pub group_by: String,
    pub project: Option<String>,
    pub actor: Option<String>,
    pub gpu_model: Option<String>,
    pub min_coverage_pct: f64,
    pub limit: usize,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageBucket {
    pub bucket: String,
    pub gpu_hours: f64,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageSummary {
    pub observed_gpu_hours: f64,
    pub utilized_gpu_hours: f64,
    pub low_utilization_gpu_hours: f64,
    pub avg_gpu_utilization_percent: Option<f64>,
    pub max_gpu_memory_percent: Option<f64>,
    pub energy_kwh: f64,
    pub sample_count: u64,
    pub run_count: usize,
    pub coverage_pct: Option<f64>,
    pub utilization_buckets: Vec<SystemUsageBucket>,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageCoverage {
    pub runs_in_scope: usize,
    pub runs_with_gpu_metrics: usize,
    pub runs_missing_gpu_metrics: usize,
    pub sample_count: u64,
    pub coverage_pct: Option<f64>,
    pub aggregate_truncated: bool,
    pub low_confidence_attribution_rows: usize,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageBreakdownRow {
    pub key: String,
    pub label: String,
    pub kind: String,
    pub actor_source: Option<String>,
    pub actor_confidence: Option<String>,
    pub run_count: usize,
    pub observed_gpu_hours: f64,
    pub utilized_gpu_hours: f64,
    pub low_utilization_gpu_hours: f64,
    pub avg_gpu_utilization_percent: Option<f64>,
    pub avg_gpu_memory_percent: Option<f64>,
    pub max_gpu_memory_percent: Option<f64>,
    pub energy_kwh: f64,
    pub sample_count: u64,
    pub coverage_pct: Option<f64>,
    pub utilization_buckets: Vec<SystemUsageBucket>,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageRunRow {
    pub run_id: Uuid,
    pub run_name: String,
    pub project: String,
    pub status: String,
    pub actor_label: String,
    pub actor_source: String,
    pub actor_confidence: String,
    pub gpu_model: String,
    pub observed_gpu_hours: f64,
    pub utilized_gpu_hours: f64,
    pub low_utilization_gpu_hours: f64,
    pub avg_gpu_utilization_percent: Option<f64>,
    pub avg_gpu_memory_percent: Option<f64>,
    pub max_gpu_memory_percent: Option<f64>,
    pub avg_cpu_percent: Option<f64>,
    pub energy_kwh: f64,
    pub sample_count: u64,
    pub coverage_pct: f64,
    pub utilization_buckets: Vec<SystemUsageBucket>,
    pub first_logged_at: Option<DateTime<Utc>>,
    pub last_logged_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageAttentionCard {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub message: String,
    pub metric: String,
    pub value: f64,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageFilterOption {
    pub label: String,
    pub value: String,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageAvailableFilters {
    pub projects: Vec<SystemUsageFilterOption>,
    pub actors: Vec<SystemUsageFilterOption>,
    pub gpu_models: Vec<SystemUsageFilterOption>,
}

#[derive(Serialize, ToSchema)]
pub struct SystemUsageInsightsEnvelope {
    pub family: String,
    pub generated_at: DateTime<Utc>,
    pub is_invoice_grade: bool,
    pub period: SystemUsagePeriod,
    pub filters: SystemUsageFilters,
    pub summary: SystemUsageSummary,
    pub coverage: SystemUsageCoverage,
    pub groups: Vec<SystemUsageBreakdownRow>,
    pub top_runs: Vec<SystemUsageRunRow>,
    pub attention: Vec<SystemUsageAttentionCard>,
    pub available_filters: SystemUsageAvailableFilters,
    pub notes: Vec<String>,
}

#[derive(Serialize, ToSchema)]
pub struct RunStopEnvelope {
    pub run_id: Uuid,
    pub ok: Option<bool>,
    pub already_requested: Option<bool>,
    pub already_terminal: Option<bool>,
    pub run_control: RunControlSummary,
}

#[derive(Serialize, ToSchema)]
pub struct RunStopResult {
    pub run_id: Uuid,
    pub ok: bool,
    pub already_requested: Option<bool>,
    pub already_terminal: Option<bool>,
    pub run_control: Option<RunControlSummary>,
    pub error: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct RunStopBulkEnvelope {
    pub results: Vec<RunStopResult>,
    pub limit: usize,
}

#[derive(Serialize, ToSchema)]
pub struct StopSignalRequestSummary {
    pub stop_request_id: Option<Uuid>,
    pub requested_at: Option<DateTime<Utc>>,
    pub acknowledged_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, ToSchema)]
pub struct StopSignalEnvelope {
    pub run_id: Uuid,
    pub run_status: String,
    pub terminal: bool,
    pub stop_requested: bool,
    pub poll_after_seconds: i64,
    pub stop_request: Option<StopSignalRequestSummary>,
}

#[derive(Serialize, ToSchema)]
pub struct RunForkContext {
    pub parent_run_id: Uuid,
    pub forked_from_step: Option<f64>,
    pub forked_from_artifact_id: Option<Uuid>,
    pub message: String,
}

#[derive(Serialize, ToSchema)]
pub struct RunForkEnvelope {
    pub run: RunSummaryRow,
    pub fork: RunForkContext,
}

#[derive(Serialize, ToSchema)]
pub struct RunLineageEnvelope {
    pub run: RunSummaryRow,
    pub parent: Option<RunSummaryRow>,
    pub children: Vec<RunSummaryRow>,
    pub checkpoint_artifact: Option<PublicArtifactRow>,
    pub children_total: usize,
    pub has_more_children: bool,
    pub limit: usize,
}

#[derive(Serialize, ToSchema)]
pub struct InsertedEnvelope {
    pub inserted: i64,
}

#[derive(Serialize, ToSchema)]
pub struct SeatEnvelope {
    pub seat: SeatRow,
}

#[derive(Serialize, ToSchema)]
pub struct SeatsEnvelope {
    pub seats: Vec<SeatRow>,
}

#[derive(Serialize, ToSchema)]
pub struct InvitationEnvelope {
    pub invitation: PublicInvitationRow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_error: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct InvitationsEnvelope {
    pub invitations: Vec<PublicInvitationRow>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Serialize, ToSchema)]
pub struct InvitationPreviewEnvelope {
    pub invitation: InvitationPreviewPayload,
}

#[derive(Serialize, ToSchema)]
pub struct ApiKeysEnvelope {
    pub api_keys: Vec<PublicApiKeyRow>,
}

#[derive(Serialize, ToSchema)]
pub struct OrganizationEnvelope {
    pub organization: OrganizationRow,
}

#[derive(Serialize, ToSchema)]
pub struct OrganizationsEnvelope {
    pub organizations: Vec<OrganizationRow>,
}

#[derive(Serialize, ToSchema)]
pub struct UserEnvelope {
    pub user: UserRow,
}

#[derive(Serialize, ToSchema)]
pub struct UsersEnvelope {
    pub users: Vec<UserRow>,
}

#[derive(Serialize, ToSchema)]
pub struct AuthSessionUnauthenticated {
    pub authenticated: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ErrorResponse {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(minimum = 1)]
    pub position: Option<usize>,
}

#[derive(Serialize, ToSchema)]
pub struct DashboardPreferencesEnvelope {
    pub preferences: DashboardPreferenceRow,
}

#[derive(Serialize, ToSchema)]
pub struct WorkspaceViewEnvelope {
    #[serde(rename = "workspace_view")]
    pub view: WorkspaceViewRow,
}

#[derive(Serialize, ToSchema)]
pub struct WorkspaceViewSummariesEnvelope {
    #[serde(rename = "workspace_views")]
    pub views: Vec<WorkspaceViewSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct ReportEnvelope {
    pub report: ReportRow,
}

#[derive(Serialize, ToSchema)]
pub struct ReportSummariesEnvelope {
    pub reports: Vec<ReportSummary>,
    pub limit: usize,
    pub offset: usize,
    pub total: usize,
}

#[derive(Serialize, ToSchema)]
pub struct PanelInventoryEntry {
    pub report_id: Uuid,
    pub report_title: String,
    pub panel_index: usize,
    #[schema(value_type = Object)]
    pub panel_spec: serde_json::Value,
}

#[derive(Serialize, ToSchema)]
pub struct PanelInventoryEnvelope {
    pub panels: Vec<PanelInventoryEntry>,
}

/// Wrapper for `auth_dev_google` / `auth_clerk` responses, which serialize
/// `AuthSessionPayload` plus an optional `onboarding_api_key` produced for
/// brand-new accounts.
#[derive(Serialize, ToSchema)]
pub struct AuthSessionWithOnboardingKey {
    #[serde(flatten)]
    pub session: AuthSessionPayload,
    pub onboarding_api_key: Option<OnboardingApiKey>,
}

#[derive(Serialize, ToSchema)]
pub struct OrgMembershipsEnvelope {
    pub memberships: Vec<OrganizationMembershipSummary>,
}

/// Free-form key/value response payload used by handlers that build dynamic
/// JSON objects in the store layer (overview, usage, exports, etc.). Modeled
/// as an opaque object so the OpenAPI spec is honest about the shape without
/// duplicating the dynamic structure here.
#[derive(Serialize, ToSchema)]
#[serde(transparent)]
pub struct JsonObjectResponse {
    #[schema(value_type = Object)]
    pub data: Value,
}

#[derive(Serialize, ToSchema)]
pub struct ApiKeyCreatedEnvelope {
    /// Plaintext key shown once on creation.
    pub api_key: String,
    pub key: PublicApiKeyRow,
}

#[derive(Serialize, ToSchema)]
pub struct ApiKeyEnvelope {
    pub key: PublicApiKeyRow,
}

#[derive(Serialize, ToSchema)]
pub struct ServiceAccountEnvelope {
    pub service_account: ServiceAccountRow,
}

#[derive(Serialize, ToSchema)]
pub struct OrganizationNameAvailability {
    pub available: bool,
    pub slug: String,
}

#[derive(Serialize, ToSchema)]
pub struct ClickHouseConnectionStatusEnvelope {
    pub connection: ClickHouseConnectionStatus,
}

#[derive(Serialize, ToSchema)]
pub struct ClickHouseConnectionValidationEnvelope {
    pub validation: ClickHouseConnectionValidationResponse,
}

#[derive(Serialize, ToSchema)]
pub struct DeviceCodeStartResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: i64,
    pub interval: i64,
}

#[derive(Serialize, ToSchema)]
pub struct DeviceCodePollResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<PublicApiKeyRow>,
}

#[derive(Serialize, ToSchema)]
pub struct DeviceCodeConfirmResponse {
    pub confirmed: bool,
}

#[derive(Serialize, ToSchema)]
pub struct AttributesEnvelope {
    pub attributes: Vec<AttributeRow>,
}

#[derive(Serialize, ToSchema)]
pub struct ObjectEnvelope {
    #[schema(value_type = Object)]
    pub object: Value,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactEnvelope {
    pub artifact: PublicArtifactRow,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactsEnvelope {
    pub artifacts: Vec<PublicArtifactRow>,
}

#[derive(Serialize, ToSchema)]
#[schema(value_type = String, format = Binary)]
pub struct BinaryBody(pub Vec<u8>);

#[derive(Serialize, ToSchema)]
pub struct ImportJobCreateRequest {
    pub source_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<i32>,
}

#[derive(Serialize, ToSchema)]
pub struct ImportJobSummary {
    pub runs: u64,
    pub metrics: u64,
    pub attributes: u64,
    pub artifacts: u64,
    pub warnings: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_runs: Option<u64>,
}

#[derive(Serialize, ToSchema)]
pub struct ImportWarning {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct ImportJobProgress {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunks: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_chunk_received: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_write_started: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumable: Option<bool>,
}

#[derive(Serialize, ToSchema)]
pub struct ImportJobRow {
    pub id: i64,
    pub org_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
    pub source_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_project: Option<String>,
    pub schema_version: i32,
    pub status: String,
    pub dedupe_policy: String,
    pub summary: ImportJobSummary,
    pub warnings: Vec<ImportWarning>,
    #[schema(value_type = Object)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_summary: Option<Value>,
    pub progress: ImportJobProgress,
    pub run_ids: Vec<Uuid>,
    pub chunk_ids: Vec<String>,
    pub accepted_chunk_count: i64,
    pub committed_batch_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_user_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, ToSchema)]
pub struct ImportsEnvelope {
    pub imports: Vec<ImportJobRow>,
}

#[derive(Serialize, ToSchema)]
pub struct ImportJobEnvelope {
    pub job: ImportJobRow,
}

#[derive(Serialize, ToSchema)]
pub struct CanonicalImportChunk {
    pub schema_version: i32,
    pub source_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_project: Option<String>,
    pub target_project: String,
    pub job_id: i64,
    pub chunk_id: String,
    pub sequence: i64,
    #[serde(rename = "final", skip_serializing_if = "Option::is_none")]
    pub final_chunk: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    pub runs: Vec<Value>,
    pub metric_points: Vec<Value>,
    pub attributes: Vec<Value>,
    pub artifact_refs: Vec<Value>,
    pub warnings: Vec<ImportWarning>,
}

#[derive(Serialize, ToSchema)]
pub struct ImportChunkRow {
    pub org_id: Uuid,
    pub import_id: i64,
    pub chunk_id: String,
    pub sequence: i64,
    pub content_hash: String,
    pub final_chunk: bool,
    #[schema(value_type = Object)]
    pub payload: Value,
    pub summary: ImportJobSummary,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, ToSchema)]
pub struct ImportChunkAppendResponse {
    pub job: ImportJobRow,
    pub chunk: ImportChunkRow,
    pub duplicate: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactCollectionSummary {
    pub id: Uuid,
    pub org_id: Uuid,
    pub project_id: Uuid,
    pub project: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub description: Option<String>,
    #[schema(value_type = Object)]
    pub metadata: Value,
    pub versions_count: usize,
    pub retained_bytes: i64,
    pub pending_delete_bytes: i64,
    pub latest_version: Option<PublicArtifactVersionRow>,
    pub best_version: Option<PublicArtifactVersionRow>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactCollectionsEnvelope {
    pub collections: Vec<ArtifactCollectionSummary>,
    pub limit: usize,
    pub offset: usize,
    pub total: usize,
    pub has_more: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactCollectionEnvelope {
    pub collection: ArtifactCollectionSummary,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactVersionsEnvelope {
    pub versions: Vec<PublicArtifactVersionRow>,
    pub limit: usize,
    pub offset: usize,
    pub total: usize,
    pub has_more: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactVersionEnvelope {
    pub artifact_version: PublicArtifactVersionRow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deduplicated: Option<bool>,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactManifestEnvelope {
    pub artifact_version_id: Uuid,
    pub entries: Vec<PublicArtifactManifestEntryRow>,
    pub limit: usize,
    pub offset: usize,
    pub total: usize,
    pub has_more: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactLineageNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub state: Option<String>,
    #[schema(value_type = Object)]
    pub summary: Value,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactLineageEdge {
    pub from: String,
    pub to: String,
    pub direction: String,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactLineageEnvelope {
    pub nodes: Vec<ArtifactLineageNode>,
    pub edges: Vec<ArtifactLineageEdge>,
    pub truncated: bool,
    pub limit: usize,
    pub depth: usize,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactUploadPartEnvelope {
    pub part_number: i64,
    pub url: String,
    pub expires_at: DateTime<Utc>,
    pub required_headers: BTreeMap<String, String>,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactUploadFileEnvelope {
    pub entry_id: Uuid,
    pub path: String,
    pub upload_kind: String,
    pub part_size_bytes: i64,
    pub part_count: i64,
    pub parts: Vec<ArtifactUploadPartEnvelope>,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactUploadSessionSummary {
    pub id: Uuid,
    pub artifact_version_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub part_size_bytes: i64,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactUploadSessionEnvelope {
    pub upload_session: ArtifactUploadSessionSummary,
    pub files: Vec<ArtifactUploadFileEnvelope>,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactUploadRenewEnvelope {
    #[schema(value_type = Object)]
    pub upload_session: Value,
    pub entry_id: Uuid,
    pub parts: Vec<ArtifactUploadPartEnvelope>,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactUploadAbortEnvelope {
    #[schema(value_type = Object)]
    pub upload_session: Value,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactAliasDeletedEnvelope {
    pub deleted: bool,
}

#[derive(Serialize, ToSchema)]
pub struct ArtifactEdgesEnvelope {
    pub edges: Vec<ArtifactEdgeRow>,
    pub limit: usize,
}

// ============================================================================
// SecurityScheme registration via Modify.
// ============================================================================

struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi
            .components
            .as_mut()
            .expect("utoipa always generates a components block when schemas are registered");
        components.add_security_scheme(
            "bearerApiKey",
            SecurityScheme::Http(
                utoipa::openapi::security::HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .description(Some(
                        "InstantML SDK API key sent as Authorization: Bearer instantml_...",
                    ))
                    .build(),
            ),
        );
        components.add_security_scheme(
            "bearerEmbedToken",
            SecurityScheme::Http(
                utoipa::openapi::security::HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .description(Some(
                        "Short-lived iframe embed token sent as Authorization: Bearer instantml_embed_...",
                    ))
                    .build(),
            ),
        );
        components.add_security_scheme(
            "browserSession",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::with_description(
                "instantml_session",
                "HttpOnly browser session cookie issued by /api/auth/dev/google or /api/auth/clerk",
            ))),
        );
        components.add_security_scheme(
            "bootstrapToken",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::with_description(
                "X-InstantML-Bootstrap-Token",
                "Operator-only bootstrap token for initial users, orgs, and admin key paths",
            ))),
        );
    }
}

// ============================================================================
// ApiDoc — the single OpenAPI definition.
//
// Add handler paths to `paths(...)` and any new request/response types to
// `components(schemas(...))` as you annotate them.
// ============================================================================

#[derive(OpenApi)]
#[openapi(
    info(
        title = "InstantML Rust API",
        description = "Current Rust/ClickHouse API. See docs/architecture/current-api.md for examples and operational notes.",
        version = env!("CARGO_PKG_VERSION"),
    ),
    paths(
        // platform
        crate::http::handlers::platform::health,
        crate::http::handlers::platform::readyz,
        // auth
        crate::http::handlers::platform::auth_config,
        crate::http::handlers::auth::auth_dev_google,
        crate::http::handlers::auth::auth_clerk,
        crate::http::handlers::auth::auth_session,
        crate::http::handlers::auth::auth_logout,
        crate::http::handlers::auth::auth_switch_organization,
        crate::http::handlers::auth::device_code_start,
        crate::http::handlers::auth::device_code_poll,
        crate::http::handlers::auth::device_code_confirm,
        // billing
        crate::http::handlers::billing::billing_status,
        crate::http::handlers::billing::billing_checkout,
        crate::http::handlers::billing::billing_checkout_sync,
        crate::http::handlers::billing::billing_portal,
        crate::http::handlers::billing::billing_change_plan,
        crate::http::handlers::billing::billing_add_seat,
        crate::http::handlers::billing::billing_cancel,
        crate::http::handlers::billing::billing_report_storage_overage,
        crate::http::handlers::billing::billing_report_usage_overage,
        crate::http::handlers::billing::billing_webhook,
        // dashboard
        crate::http::handlers::dashboard::get_dashboard_preferences,
        crate::http::handlers::dashboard::update_dashboard_preferences,
        crate::http::handlers::dashboard::list_workspace_views,
        crate::http::handlers::dashboard::create_workspace_view,
        crate::http::handlers::dashboard::get_workspace_view,
        crate::http::handlers::dashboard::update_workspace_view,
        crate::http::handlers::dashboard::export_workspace_view,
        crate::http::handlers::dashboard::import_workspace_view,
        crate::http::handlers::dashboard::delete_workspace_view,
        crate::http::handlers::dashboard::workspace_view_data,
        // embeds
        crate::http::handlers::embed::create_embed_session,
        crate::http::handlers::embed::embed_frame_policy,
        crate::http::handlers::embed::embed_current_session,
        crate::http::handlers::embed::embed_runs_data,
        // reports
        crate::http::handlers::reports::create_report,
        crate::http::handlers::reports::list_reports,
        crate::http::handlers::reports::get_report,
        crate::http::handlers::reports::update_report,
        crate::http::handlers::reports::delete_report,
        crate::http::handlers::reports::rotate_report_share_token,
        crate::http::handlers::reports::get_report_by_share_token,
        crate::http::handlers::reports::export_report_markdown,
        crate::http::handlers::reports::list_org_panels,
        // admin
        crate::http::handlers::admin::admin_overview,
        crate::http::handlers::admin::admin_data_cells,
        crate::http::handlers::admin::admin_change_plan,
        // orgs / users
        crate::http::handlers::orgs::create_user,
        crate::http::handlers::orgs::list_users,
        crate::http::handlers::orgs::create_org,
        crate::http::handlers::orgs::create_current_user_org,
        crate::http::handlers::orgs::list_orgs,
        crate::http::handlers::orgs::list_org_memberships,
        crate::http::handlers::orgs::org_name_availability,
        crate::http::handlers::orgs::create_api_key,
        crate::http::handlers::orgs::list_api_keys,
        crate::http::handlers::orgs::revoke_api_key,
        crate::http::handlers::orgs::disable_service_account,
        crate::http::handlers::orgs::reserve_seat,
        crate::http::handlers::orgs::list_seats,
        crate::http::handlers::orgs::customer_clickhouse_connection_status,
        crate::http::handlers::orgs::validate_customer_clickhouse_connection,
        crate::http::handlers::orgs::create_customer_clickhouse_connection,
        crate::http::handlers::orgs::rotate_customer_clickhouse_credentials,
        crate::http::handlers::invitations::list_invitations,
        crate::http::handlers::invitations::create_invitation,
        crate::http::handlers::invitations::resend_invitation,
        crate::http::handlers::invitations::revoke_invitation,
        crate::http::handlers::invitations::preview_invitation,
        crate::http::handlers::invitations::accept_invitation,
        // runs core
        crate::http::handlers::runs::create_project,
        crate::http::handlers::runs::list_projects,
        crate::http::handlers::runs::create_run,
        crate::http::handlers::runs::list_runs,
        crate::http::handlers::runs::get_run,
        crate::http::handlers::runs::get_run_lineage,
        crate::http::handlers::runs::fork_run,
        crate::http::handlers::runs::update_run,
        crate::http::handlers::runs::stop_run,
        crate::http::handlers::runs::stop_runs,
        crate::http::handlers::runs::stop_signal,
        crate::http::handlers::runs::stop_ack,
        crate::http::handlers::runs::log_metrics,
        crate::http::handlers::runs::log_metrics_batch,
        crate::http::handlers::runs::get_metrics,
        crate::http::handlers::runs::log_rank_metrics,
        crate::http::handlers::runs::rank_metrics_summary,
        crate::http::handlers::runs::log_console_logs,
        crate::http::handlers::runs::list_console_logs,
        crate::http::handlers::traces::log_trace_events,
        crate::http::handlers::traces::list_traces,
        crate::http::handlers::traces::get_trace_detail,
        crate::http::handlers::traces::get_trace_children,
        crate::http::handlers::traces::get_trace_step_summary,
        crate::http::handlers::metrics::metrics_series,
        // dashboard analytics
        crate::http::handlers::runs::overview,
        crate::http::handlers::runs::runs_summary,
        crate::http::handlers::runs::side_by_side,
        crate::http::handlers::runs::compare_matching_runs,
        crate::http::handlers::insights::system_usage_insights,
        // attributes / objects
        crate::http::handlers::runs::create_attributes,
        crate::http::handlers::runs::list_attributes,
        crate::http::handlers::runs::create_object,
        crate::http::handlers::runs::list_objects,
        crate::http::handlers::runs::list_object_rows,
        // artifacts
        crate::http::handlers::artifacts::create_artifact,
        crate::http::handlers::artifacts::list_artifacts,
        crate::http::handlers::artifacts::upload_artifact,
        crate::http::handlers::artifacts::download_artifact,
        crate::http::handlers::artifacts::list_artifact_collections,
        crate::http::handlers::artifacts::get_artifact_collection,
        crate::http::handlers::artifacts::list_artifact_collection_versions,
        crate::http::handlers::artifacts::resolve_artifact_version,
        crate::http::handlers::artifacts::get_artifact_version,
        crate::http::handlers::artifacts::list_artifact_manifest,
        crate::http::handlers::artifacts::artifact_version_lineage,
        crate::http::handlers::artifacts::initiate_artifact_upload,
        crate::http::handlers::artifacts::renew_artifact_upload,
        crate::http::handlers::artifacts::complete_artifact_upload,
        crate::http::handlers::artifacts::abort_artifact_upload,
        crate::http::handlers::artifacts::set_artifact_alias,
        crate::http::handlers::artifacts::delete_artifact_alias,
        crate::http::handlers::artifacts::update_artifact_retention,
        crate::http::handlers::artifacts::delete_artifact_version,
        crate::http::handlers::artifacts::create_artifact_input_edge,
        crate::http::handlers::artifacts::run_artifact_edges,
        crate::http::handlers::artifacts::download_artifact_entry,
        // export / usage / imports
        crate::http::handlers::usage::export_data,
        crate::http::handlers::usage::usage_summary,
        crate::http::handlers::usage::usage_export,
        crate::http::handlers::usage::reset_demo,
        crate::http::handlers::imports::list_imports,
        crate::http::handlers::imports::create_import_job,
        crate::http::handlers::imports::get_import_job,
        crate::http::handlers::imports::append_import_chunk,
        crate::http::handlers::imports::commit_import_job,
        crate::http::handlers::imports::cancel_import_job,
        crate::http::handlers::imports::import_neptune,
        crate::http::handlers::imports::import_wandb,
        crate::http::handlers::imports::import_mlflow,
    ),
    components(schemas(
        // envelopes
        HealthResponse,
        ReadyzResponse,
        WriterLeaseReadinessResponse,
        AuthConfigResponse,
        AuthSessionUnauthenticated,
        AuthSessionWithOnboardingKey,
        ErrorResponse,
        ProjectEnvelope,
        ProjectsEnvelope,
        RunEnvelope,
        RunCreatedEnvelope,
        RunsEnvelope,
        RunSummaryEnvelope,
        RunSummariesEnvelope,
        RunControlRow,
        RunControlSummary,
        RunStopEnvelope,
        RunStopResult,
        RunStopBulkEnvelope,
        StopSignalRequestSummary,
        StopSignalEnvelope,
        RunMetricAggregate,
        RunSummaryRow,
        SystemUsagePeriod,
        SystemUsageFilters,
        SystemUsageBucket,
        SystemUsageSummary,
        SystemUsageCoverage,
        SystemUsageBreakdownRow,
        SystemUsageRunRow,
        SystemUsageAttentionCard,
        SystemUsageFilterOption,
        SystemUsageAvailableFilters,
        SystemUsageInsightsEnvelope,
        RunForkContext,
        RunForkEnvelope,
        RunLineageEnvelope,
        InsertedEnvelope,
        SeatEnvelope,
        SeatsEnvelope,
        InvitationEnvelope,
        InvitationsEnvelope,
        InvitationPreviewEnvelope,
        ApiKeysEnvelope,
        ApiKeyCreatedEnvelope,
        ApiKeyEnvelope,
        ServiceAccountEnvelope,
        OrganizationEnvelope,
        OrganizationsEnvelope,
        OrgMembershipsEnvelope,
        OrganizationNameAvailability,
        ClickHouseConnectionStatusEnvelope,
        ClickHouseConnectionValidationEnvelope,
        DeviceCodeStartResponse,
        DeviceCodePollResponse,
        DeviceCodeConfirmResponse,
        UserEnvelope,
        UsersEnvelope,
        DashboardPreferencesEnvelope,
        WorkspaceViewEnvelope,
        WorkspaceViewSummariesEnvelope,
        ReportEnvelope,
        ReportSummariesEnvelope,
        PanelInventoryEnvelope,
        PanelInventoryEntry,
        AttributesEnvelope,
        ObjectEnvelope,
        ArtifactEnvelope,
        ArtifactsEnvelope,
        BinaryBody,
        ImportJobCreateRequest,
        ImportJobSummary,
        ImportWarning,
        ImportJobProgress,
        ImportJobRow,
        ImportsEnvelope,
        ImportJobEnvelope,
        CanonicalImportChunk,
        ImportChunkRow,
        ImportChunkAppendResponse,
        ArtifactCollectionSummary,
        ArtifactCollectionsEnvelope,
        ArtifactCollectionEnvelope,
        ArtifactVersionsEnvelope,
        ArtifactVersionEnvelope,
        ArtifactManifestEnvelope,
        ArtifactLineageNode,
        ArtifactLineageEdge,
        ArtifactLineageEnvelope,
        ArtifactUploadPartEnvelope,
        ArtifactUploadFileEnvelope,
        ArtifactUploadSessionSummary,
        ArtifactUploadSessionEnvelope,
        ArtifactUploadRenewEnvelope,
        ArtifactUploadAbortEnvelope,
        ArtifactAliasDeletedEnvelope,
        ArtifactEdgesEnvelope,
        JsonObjectResponse,
        AdminOverviewResponse,
        AdminOverviewQuerySummary,
        AdminOverviewTotals,
        AdminOrganizationSummary,
        AdminUserSummary,
        AdminApiKeySummary,
        AdminRiskItem,
        AdminUserIdentity,
        AdminUserOrgMembership,
        AdminOrgCounts,
        AdminUsageGauge,
        AdminStorageSummary,
        AdminDataCellsResponse,
        AdminDataCellSummary,
        AdminDataCellRouteCounts,
        AdminBillingSummary,
        AdminPlanChangeRequest,
        // domain
        PublicArtifactRow,
        PublicArtifactCollectionRow,
        PublicArtifactVersionRow,
        PublicArtifactManifestEntryRow,
        ArtifactCollectionInput,
        VersionedArtifactManifestInput,
        VersionedArtifactManifestEntryInput,
        InitiateArtifactUploadRequest,
        RenewArtifactUploadRequest,
        CompleteArtifactUploadPart,
        CompleteArtifactUploadFile,
        CompleteArtifactUploadRequest,
        AbortArtifactUploadRequest,
        SetArtifactAliasRequest,
        DeleteArtifactAliasRequest,
        UpdateArtifactRetentionRequest,
        DeleteArtifactVersionRequest,
        CreateArtifactInputEdgeRequest,
        ArtifactCollectionRow,
        ArtifactVersionRow,
        ArtifactManifestEntriesRecord,
        ArtifactManifestEntryRow,
        ArtifactAliasRow,
        ArtifactEdgeRow,
        ArtifactUploadFile,
        ArtifactUploadSessionRow,
        AttributeInput,
        AttributeRow,
        AuthSessionPayload,
        BillingAccountProjection,
        BillingCancelRequest,
        BillingChangeIntent,
        BillingCheckoutInfo,
        BillingCheckoutIntent,
        BillingCheckoutRequest,
        BillingCheckoutSyncRequest,
        BillingEventRecord,
        BillingPlanChangeRequest,
        BillingPortalRequest,
        BillingSeatChangeRequest,
        BillingSubscriptionRecord,
        BillingUsageReportRecord,
        ClerkAuthRequest,
        ClickHouseConnectionCreateRequest,
        ClickHouseConnectionRotateCredentialsRequest,
        ClickHouseConnectionStatus,
        ClickHouseConnectionValidateRequest,
        ClickHouseConnectionValidationResponse,
        CompareMatchingRunsRequest,
        ConsoleLogInput,
        ConsoleLogLine,
        CreateApiKeyRequest,
        CreateArtifactRequest,
        CreateAttributesRequest,
        CreateConsoleLogsRequest,
        CreateCurrentUserOrganizationRequest,
        CreateInvitationRequest,
        CreateObjectRequest,
        CreateOrganizationRequest,
        CreateProjectRequest,
        CreateReportRequest,
        CreateRunForkRequest,
        CreateRunRequest,
        CreateUserRequest,
        CurrentUserOrganizationCreateResponse,
        DashboardPreferenceRow,
        DevGoogleAuthRequest,
        DeviceCodeClientInfo,
        DeviceCodeConfirmRequest,
        DeviceCodePollRequest,
        DeviceCodeStartRequest,
        CreateEmbedSessionRequest,
        CreateEmbedSessionResponse,
        EmbedCurrentSession,
        EmbedCurrentSessionResponse,
        EmbedFramePolicy,
        EmbedFramePolicyResponse,
        EmbedRunsDataRequest,
        EmbedSessionOptions,
        PublicEmbedSession,
        ImportWorkspaceViewRequest,
        InitialInvitationCreateResult,
        InitialOrganizationInvitation,
        InvitationPreviewPayload,
        InvitationTokenRequest,
        LogMetricsBatchPoint,
        LogMetricsBatchRequest,
        LogMetricsRequest,
        LogRankMetricsRequest,
        CreateTraceEventsRequest,
        TraceEventInput,
        TraceIngestResponse,
        TraceSummaryItem,
        TraceListResponse,
        TraceDetailSummary,
        TraceSpanItem,
        TraceDetailLimits,
        TraceDetailTruncation,
        TraceDetailResponse,
        TraceChildrenResponse,
        TraceStepBucket,
        TraceStepSummaryResponse,
        MembershipRow,
        MetricPointRow,
        MetricSeriesRow,
        OnboardingApiKey,
        OrganizationMembershipSummary,
        OrganizationRoleCapabilities,
        OrganizationRow,
        ProjectRow,
        ProvisioningStatusPayload,
        PublicApiKeyRow,
        ReserveSeatRequest,
        PublicInvitationRow,
        RankCoveragePoint,
        RankHeatmapPoint,
        RankMetricLimits,
        RankMetricTruncation,
        RankMetricsSummaryResponse,
        RankOutlierPoint,
        RankReducerPoint,
        ReportRow,
        ReportSummary,
        LifecycleTransition,
        RunRow,
        SaveWorkspaceViewRequest,
        SeatRow,
        SeatUserRow,
        ServiceAccountRow,
        StopAckRequest,
        StopRunRequest,
        StopRunsRequest,
        SwitchOrganizationRequest,
        UpdateDashboardPreferencesRequest,
        UpdateReportRequest,
        UpdateRunRequest,
        UploadArtifactRequest,
        UserRow,
        UserSessionRow,
        WorkspaceViewDataOptions,
        WorkspaceViewData,
        WorkspaceViewDataLimits,
        WorkspaceViewDataPanelResult,
        WorkspaceViewDataRequest,
        WorkspaceViewDataResponse,
        WorkspaceViewDeleteResponse,
        WorkspaceViewExportEnvelope,
        WorkspaceViewExportIntegrity,
        WorkspaceViewExportSource,
        WorkspaceViewExportedView,
        WorkspaceViewImportResponse,
        WorkspaceViewMetricSeries,
        WorkspaceViewRow,
        WorkspaceViewSummary,
    )),
    modifiers(&SecurityAddon),
    security(
        ("bearerApiKey" = []),
        ("browserSession" = []),
    ),
    tags(
        (name = "platform", description = "Health, readiness, OpenAPI spec, and other unauthenticated endpoints."),
        (name = "auth", description = "Browser session and device-code authentication."),
        (name = "billing", description = "Stripe Checkout, subscriptions, portal, and billing webhooks."),
        (name = "orgs", description = "Organizations, memberships, seats, and API keys."),
        (name = "storage", description = "Workspace storage setup and customer-owned ClickHouse connection validation."),
        (name = "invitations", description = "Token-backed organization invitations."),
        (name = "runs", description = "Experiment runs, metrics, attributes, objects, artifacts."),
        (name = "dashboard", description = "Browser dashboard preferences and saved workspace views."),
        (name = "embeds", description = "Short-lived read-only iframe run embeds."),
        (name = "reports", description = "Notion-style report documents with live PanelGrids and legacy LLM-summary rendering."),
    ),
)]
pub struct ApiDoc;
