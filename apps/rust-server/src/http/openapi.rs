//! Single source of truth for the OpenAPI spec.
//!
//! Handlers in `handlers.rs` carry `#[utoipa::path(...)]` macros. The
//! [`ApiDoc`] struct here collects them via `#[openapi(paths(...), components(schemas(...)))]`.
//! At runtime, `GET /openapi.json` serves `ApiDoc::openapi()` merged on top of the legacy
//! hand-written index (the legacy index covers handlers we have not yet migrated; utoipa
//! paths take precedence wherever both exist).
//!
//! See `docs/design/2026-05-19-utoipa-migration.md` for the migration plan.
use serde::Serialize;
use utoipa::{
    openapi::security::{ApiKey, ApiKeyValue, HttpAuthScheme, SecurityScheme},
    Modify, OpenApi, ToSchema,
};

use crate::domain::{
    ArtifactRow, AttributeInput, AttributeRow, AuthSessionPayload, ClerkAuthRequest,
    ConsoleLogInput, ConsoleLogLine, CreateApiKeyRequest, CreateArtifactRequest,
    CreateAttributesRequest, CreateConsoleLogsRequest, CreateObjectRequest,
    CreateOrganizationRequest, CreateProjectRequest, CreateRunRequest, CreateUserRequest,
    DashboardPreferenceRow, DevGoogleAuthRequest, DeviceCodeClientInfo, DeviceCodeConfirmRequest,
    DeviceCodePollRequest, DeviceCodeStartRequest, LogMetricsRequest, MembershipRow,
    MetricPointRow, MetricSeriesRow, OnboardingApiKey, OrganizationRow, ProjectRow,
    ProvisioningStatusPayload, PublicApiKeyRow, ReserveSeatRequest, RunRow,
    SaveWorkspaceViewRequest, SeatRow, SeatUserRow, ServiceAccountRow,
    UpdateDashboardPreferencesRequest, UpdateRunRequest, UploadArtifactRequest, UserRow,
    UserSessionRow, WorkspaceViewRow, WorkspaceViewSummary,
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
        crate::http::handlers::health,
        crate::http::handlers::readyz,
        crate::http::handlers::auth_config,
        crate::http::handlers::auth_session,
        crate::http::handlers::auth_logout,
        crate::http::handlers::create_project,
        crate::http::handlers::list_projects,
        crate::http::handlers::create_run,
        crate::http::handlers::list_runs,
        crate::http::handlers::get_run,
        crate::http::handlers::update_run,
        crate::http::handlers::log_metrics,
        crate::http::handlers::list_orgs,
        crate::http::handlers::list_seats,
        crate::http::handlers::list_api_keys,
    ),
    components(schemas(
        // envelopes
        HealthResponse,
        AuthConfigResponse,
        AuthSessionUnauthenticated,
        ErrorResponse,
        ErrorBody,
        ProjectEnvelope,
        ProjectsEnvelope,
        RunEnvelope,
        RunsEnvelope,
        InsertedEnvelope,
        SeatEnvelope,
        SeatsEnvelope,
        ApiKeysEnvelope,
        OrganizationEnvelope,
        OrganizationsEnvelope,
        UserEnvelope,
        UsersEnvelope,
        DashboardPreferencesEnvelope,
        WorkspaceViewEnvelope,
        WorkspaceViewSummariesEnvelope,
        // domain
        ArtifactRow,
        AttributeInput,
        AttributeRow,
        AuthSessionPayload,
        ClerkAuthRequest,
        ConsoleLogInput,
        ConsoleLogLine,
        CreateApiKeyRequest,
        CreateArtifactRequest,
        CreateAttributesRequest,
        CreateConsoleLogsRequest,
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
        LogMetricsRequest,
        MembershipRow,
        MetricPointRow,
        MetricSeriesRow,
        OnboardingApiKey,
        OrganizationRow,
        ProjectRow,
        ProvisioningStatusPayload,
        PublicApiKeyRow,
        ReserveSeatRequest,
        RunRow,
        SaveWorkspaceViewRequest,
        SeatRow,
        SeatUserRow,
        ServiceAccountRow,
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
        (name = "orgs", description = "Organizations, memberships, seats, and API keys."),
        (name = "runs", description = "Experiment runs, metrics, attributes, objects, artifacts."),
        (name = "dashboard", description = "Browser dashboard preferences and saved workspace views."),
    ),
)]
pub struct ApiDoc;
