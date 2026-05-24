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
use serde::Serialize;
use utoipa::{
    openapi::security::{ApiKey, ApiKeyValue, HttpAuthScheme, SecurityScheme},
    Modify, OpenApi, ToSchema,
};

use serde_json::Value;

use crate::domain::{
    AdminApiKeySummary, AdminBillingSummary, AdminOrgCounts, AdminOrganizationSummary,
    AdminOverviewQuerySummary, AdminOverviewResponse, AdminOverviewTotals, AdminRiskItem,
    AdminStorageSummary, AdminUsageGauge, AdminUserIdentity, AdminUserOrgMembership,
    AdminUserSummary, AttributeInput, AttributeRow, AuthSessionPayload, BillingAccountProjection,
    BillingCancelRequest, BillingChangeIntent, BillingCheckoutInfo, BillingCheckoutIntent,
    BillingCheckoutRequest, BillingCheckoutSyncRequest, BillingEventRecord,
    BillingPlanChangeRequest, BillingPortalRequest, BillingSeatChangeRequest,
    BillingSubscriptionRecord, BillingUsageReportRecord, ClerkAuthRequest,
    ClickHouseConnectionCreateRequest, ClickHouseConnectionRotateCredentialsRequest,
    ClickHouseConnectionStatus, ClickHouseConnectionValidateRequest,
    ClickHouseConnectionValidationResponse, ConsoleLogInput, ConsoleLogLine, CreateApiKeyRequest,
    CreateArtifactRequest, CreateAttributesRequest, CreateConsoleLogsRequest,
    CreateInvitationRequest, CreateObjectRequest, CreateOrganizationRequest, CreateProjectRequest,
    CreateRunRequest, CreateUserRequest, DashboardPreferenceRow, DevGoogleAuthRequest,
    DeviceCodeClientInfo, DeviceCodeConfirmRequest, DeviceCodePollRequest, DeviceCodeStartRequest,
    InvitationPreviewPayload, InvitationTokenRequest, LogMetricsRequest, LogRankMetricsRequest,
    MembershipRow, MetricPointRow, MetricSeriesRow, OnboardingApiKey,
    OrganizationMembershipSummary, OrganizationRow, ProjectRow, ProvisioningStatusPayload,
    PublicApiKeyRow, PublicArtifactRow, PublicInvitationRow, RankCoveragePoint, RankHeatmapPoint,
    RankMetricLimits, RankMetricTruncation, RankMetricsSummaryResponse, RankOutlierPoint,
    RankReducerPoint, ReserveSeatRequest, RunRow, SaveWorkspaceViewRequest, SeatRow, SeatUserRow,
    ServiceAccountRow, SwitchOrganizationRequest, UpdateDashboardPreferencesRequest,
    UpdateRunRequest, UploadArtifactRequest, UserRow, UserSessionRow, WorkspaceViewRow,
    WorkspaceViewSummary,
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

#[derive(Serialize, ToSchema)]
pub struct RunsEnvelope {
    pub runs: Vec<RunRow>,
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
    pub error: ErrorBody,
}

#[derive(Serialize, ToSchema)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Serialize, ToSchema)]
pub struct DashboardPreferencesEnvelope {
    pub preferences: DashboardPreferenceRow,
}

#[derive(Serialize, ToSchema)]
pub struct WorkspaceViewEnvelope {
    pub view: WorkspaceViewRow,
}

#[derive(Serialize, ToSchema)]
pub struct WorkspaceViewSummariesEnvelope {
    pub views: Vec<WorkspaceViewSummary>,
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
        // admin
        crate::http::handlers::admin::admin_overview,
        // orgs / users
        crate::http::handlers::orgs::create_user,
        crate::http::handlers::orgs::list_users,
        crate::http::handlers::orgs::create_org,
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
        crate::http::handlers::runs::update_run,
        crate::http::handlers::runs::log_metrics,
        crate::http::handlers::runs::get_metrics,
        crate::http::handlers::runs::log_rank_metrics,
        crate::http::handlers::runs::rank_metrics_summary,
        crate::http::handlers::runs::log_console_logs,
        crate::http::handlers::runs::list_console_logs,
        crate::http::handlers::metrics::metrics_series,
        // dashboard analytics
        crate::http::handlers::runs::overview,
        crate::http::handlers::runs::runs_summary,
        crate::http::handlers::runs::side_by_side,
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
        // export / usage / imports
        crate::http::handlers::usage::export_data,
        crate::http::handlers::usage::usage_summary,
        crate::http::handlers::usage::usage_export,
        crate::http::handlers::usage::reset_demo,
        crate::http::handlers::imports::list_imports,
        crate::http::handlers::imports::import_neptune,
        crate::http::handlers::imports::import_wandb,
        crate::http::handlers::imports::import_mlflow,
    ),
    components(schemas(
        // envelopes
        HealthResponse,
        AuthConfigResponse,
        AuthSessionUnauthenticated,
        AuthSessionWithOnboardingKey,
        ErrorResponse,
        ErrorBody,
        ProjectEnvelope,
        ProjectsEnvelope,
        RunEnvelope,
        RunsEnvelope,
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
        AttributesEnvelope,
        ObjectEnvelope,
        ArtifactEnvelope,
        ArtifactsEnvelope,
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
        AdminBillingSummary,
        // domain
        PublicArtifactRow,
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
        ConsoleLogInput,
        ConsoleLogLine,
        CreateApiKeyRequest,
        CreateArtifactRequest,
        CreateAttributesRequest,
        CreateConsoleLogsRequest,
        CreateInvitationRequest,
        CreateObjectRequest,
        CreateOrganizationRequest,
        CreateProjectRequest,
        CreateRunRequest,
        CreateUserRequest,
        DashboardPreferenceRow,
        DevGoogleAuthRequest,
        DeviceCodeClientInfo,
        DeviceCodeConfirmRequest,
        DeviceCodePollRequest,
        DeviceCodeStartRequest,
        InvitationPreviewPayload,
        InvitationTokenRequest,
        LogMetricsRequest,
        LogRankMetricsRequest,
        MembershipRow,
        MetricPointRow,
        MetricSeriesRow,
        OnboardingApiKey,
        OrganizationMembershipSummary,
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
        RunRow,
        SaveWorkspaceViewRequest,
        SeatRow,
        SeatUserRow,
        ServiceAccountRow,
        SwitchOrganizationRequest,
        UpdateDashboardPreferencesRequest,
        UpdateRunRequest,
        UploadArtifactRequest,
        UserRow,
        UserSessionRow,
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
    ),
)]
pub struct ApiDoc;
