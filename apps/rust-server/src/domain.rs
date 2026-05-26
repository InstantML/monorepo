use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    errors::{AppError, AppResult},
    store::LOCAL_ORG_ID,
};

pub const MAX_TEXT_BYTES: usize = 512;
pub const MAX_METRICS_PER_BATCH: usize = 1_000;
pub const DEFAULT_METRIC_LIMIT: i64 = 1_000;
pub const MAX_METRIC_LIMIT: i64 = 5_000;
pub const MAX_RANK_WORLD_SIZE: u32 = 512;
pub const MAX_RANK_HEATMAP_CELLS: usize = 16_384;
pub const MAX_RANK_CANONICAL_ROWS: usize = 65_536;
pub const MAX_RANK_OUTLIERS: usize = 20;
pub const DEFAULT_RUN_LIMIT: i64 = 100;
pub const MAX_RUN_LIMIT: i64 = 1_000;
pub const MAX_METRIC_SERIES_RUN_IDS: usize = 2_000;
pub const MAX_METRIC_SERIES_TOTAL_POINTS: i64 = 120_000;
pub const DEFAULT_CONSOLE_LOG_LIMIT: i64 = 250;
pub const MAX_CONSOLE_LOG_LIMIT: i64 = 1_000;
pub const MAX_CONSOLE_LOG_LINES_PER_BATCH: usize = 50;
pub const MAX_CONSOLE_LOG_MESSAGE_BYTES: usize = 16 * 1024;
pub const GIB_BYTES: i64 = 1024 * 1024 * 1024;

pub const STORAGE_CHOICE_HOSTED: &str = "instantml-hosted";
pub const STORAGE_CHOICE_CUSTOMER_CLICKHOUSE: &str = "customer-clickhouse";
pub const STORAGE_STATE_UNCONFIGURED: &str = "storage_unconfigured";
pub const STORAGE_STATE_VALIDATING: &str = "storage_validating";
pub const STORAGE_STATE_READY: &str = "storage_ready";
pub const STORAGE_STATE_LOCKED: &str = "storage_locked";

#[derive(Clone, Copy, Debug, Serialize)]
pub struct PlanTier {
    pub id: &'static str,
    pub label: &'static str,
    pub monthly_base_usd: i64,
    pub included_seats: i32,
    pub included_storage_bytes: i64,
    pub projects: i64,
    pub runs: i64,
    pub metric_points: i64,
    pub api_requests: i64,
    pub api_request_overage_cents_per_million: Option<i64>,
    pub rate_limit_rps: u32,
    pub rate_limit_burst: u32,
    pub ingest_rate_limit_rps: u32,
    pub warehouse_kind: &'static str,
    pub min_replica_memory_gb: u32,
    pub max_replica_memory_gb: u32,
    pub num_replicas: u32,
}

pub const PLAN_FREE: PlanTier = PlanTier {
    id: "free",
    label: "Free",
    monthly_base_usd: 0,
    included_seats: 2,
    included_storage_bytes: 2 * GIB_BYTES,
    projects: 2,
    runs: 100,
    metric_points: 1_000_000,
    api_requests: 500_000,
    api_request_overage_cents_per_million: None,
    rate_limit_rps: 5,
    rate_limit_burst: 30,
    ingest_rate_limit_rps: 2,
    warehouse_kind: "shared",
    min_replica_memory_gb: 8,
    max_replica_memory_gb: 8,
    num_replicas: 1,
};

pub const PLAN_PRO: PlanTier = PlanTier {
    id: "pro",
    label: "Pro",
    monthly_base_usd: 199,
    included_seats: 3,
    included_storage_bytes: 1024 * GIB_BYTES,
    projects: 100,
    runs: 100_000,
    metric_points: 250_000_000,
    api_requests: 25_000_000,
    api_request_overage_cents_per_million: Some(200),
    rate_limit_rps: 50,
    rate_limit_burst: 250,
    ingest_rate_limit_rps: 25,
    warehouse_kind: "standard",
    min_replica_memory_gb: 12,
    max_replica_memory_gb: 12,
    num_replicas: 1,
};

pub const PLAN_PREMIUM: PlanTier = PlanTier {
    id: "premium",
    label: "Premium",
    monthly_base_usd: 699,
    included_seats: 10,
    included_storage_bytes: 5 * 1024 * GIB_BYTES,
    projects: 500,
    runs: 1_000_000,
    metric_points: 2_000_000_000,
    api_requests: 150_000_000,
    api_request_overage_cents_per_million: Some(100),
    rate_limit_rps: 200,
    rate_limit_burst: 1000,
    ingest_rate_limit_rps: 100,
    warehouse_kind: "dedicated",
    min_replica_memory_gb: 16,
    max_replica_memory_gb: 16,
    num_replicas: 2,
};

#[derive(Clone, Debug)]
pub struct RequestContext {
    pub org_id: Uuid,
    pub auth: Option<AuthContext>,
    pub session: Option<SessionContext>,
}

impl RequestContext {
    pub fn local() -> Self {
        Self {
            org_id: LOCAL_ORG_ID,
            auth: None,
            session: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AuthContext {
    pub org_id: Uuid,
    pub api_key_id: Uuid,
    pub service_account_id: Uuid,
    pub project_id: Option<Uuid>,
    pub scopes: Vec<String>,
}

impl AuthContext {
    pub fn require_scope(&self, scope: &str) -> AppResult<()> {
        if self.scopes.iter().any(|candidate| candidate == scope) {
            Ok(())
        } else {
            Err(AppError::forbidden(format!("api key requires {scope}")))
        }
    }
}

#[derive(Clone, Debug)]
pub struct SessionContext {
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub demo_read_only: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateUserRequest {
    pub email: Option<String>,
    pub primary_email: Option<String>,
    pub provider: Option<String>,
    pub provider_subject: Option<String>,
    pub email_verified: Option<bool>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct UserRow {
    pub id: Uuid,
    pub primary_email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateOrganizationRequest {
    pub slug: Option<String>,
    pub name: Option<String>,
    pub plan_tier: Option<String>,
    pub owner_user_id: Option<Uuid>,
    pub storage_choice: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct OrganizationRow {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub plan_tier: String,
    pub account_type: String,
    pub seat_limit: i32,
    pub created_by_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    /// Routing tier for this org's ClickHouse data plane.
    /// `"shared"` — routes to the shared cell (free/personal orgs).
    /// `"dedicated"` — routes to a per-org provisioned service.
    /// Older records that pre-date this field deserialize to `"dedicated"`
    /// (the safe fallback) via the serde default.
    #[serde(default = "default_routing_tier")]
    pub tenant_routing_tier: String,
    #[serde(default = "default_storage_choice")]
    pub storage_choice: String,
    #[serde(default = "default_storage_state")]
    pub storage_state: String,
}

fn default_routing_tier() -> String {
    "dedicated".to_string()
}

fn default_storage_choice() -> String {
    STORAGE_CHOICE_HOSTED.to_string()
}

fn default_storage_state() -> String {
    STORAGE_STATE_READY.to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct MembershipRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct UserSessionRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub org_id: Uuid,
    #[schema(value_type = Object)]
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AuthSessionPayload {
    pub authenticated: bool,
    pub session: UserSessionRow,
    pub user: UserRow,
    pub organization: OrganizationRow,
    pub membership: MembershipRow,
    pub memberships: Vec<MembershipRow>,
    pub account_type: String,
    pub provisioning: Option<ProvisioningStatusPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billing_checkout: Option<BillingCheckoutInfo>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct ProvisioningStatusPayload {
    pub status: String,
    pub mode: String,
    pub service_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct OnboardingApiKey {
    pub plaintext: String,
    pub prefix: String,
    pub id: Uuid,
}

#[derive(Clone, Debug)]
pub struct CreatedAuthSession {
    pub token: String,
    pub payload: AuthSessionPayload,
    pub onboarding_api_key: Option<OnboardingApiKey>,
}

pub const BILLING_FREE_ACTIVE: &str = "free_active";
pub const BILLING_CHECKOUT_PENDING: &str = "checkout_pending";
pub const BILLING_PAID_ACTIVE: &str = "paid_active";
pub const BILLING_PAST_DUE_GRACE: &str = "past_due_grace";
pub const BILLING_READ_ONLY_PAYMENT_REQUIRED: &str = "read_only_payment_required";
pub const BILLING_CANCELED: &str = "canceled";

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct BillingAccountProjection {
    pub schema_version: i32,
    pub org_id: Uuid,
    pub access_state: String,
    pub plan_tier: String,
    pub effective_plan_tier: String,
    pub requested_plan_tier: Option<String>,
    pub paid_extra_seats: i32,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub subscription_status: Option<String>,
    pub current_period_start: Option<DateTime<Utc>>,
    pub current_period_end: Option<DateTime<Utc>>,
    pub cancel_at_period_end: bool,
    pub grace_until: Option<DateTime<Utc>>,
    pub pending_intent_id: Option<Uuid>,
    pub message: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct BillingCheckoutInfo {
    pub intent_id: Uuid,
    pub status: String,
    pub session_id: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct BillingCheckoutIntent {
    pub schema_version: i32,
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub action: String,
    pub target_plan_tier: String,
    pub pending_seat_emails: Vec<String>,
    pub stripe_checkout_session_id: Option<String>,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub status: String,
    pub url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct BillingChangeIntent {
    pub schema_version: i32,
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub action: String,
    pub target_plan_tier: Option<String>,
    pub target_extra_seats: Option<i32>,
    pub pending_seat_email: Option<String>,
    pub pending_seat_role: Option<String>,
    pub stripe_invoice_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct BillingSubscriptionRecord {
    pub schema_version: i32,
    pub org_id: Uuid,
    pub stripe_subscription_id: String,
    pub stripe_customer_id: Option<String>,
    pub status: String,
    pub plan_tier: String,
    pub paid_extra_seats: i32,
    pub current_period_start: Option<DateTime<Utc>>,
    pub current_period_end: Option<DateTime<Utc>>,
    pub cancel_at_period_end: bool,
    #[schema(value_type = Object)]
    pub metadata: Value,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct BillingEventRecord {
    pub schema_version: i32,
    pub stripe_event_id: String,
    pub event_type: String,
    pub org_id: Option<Uuid>,
    pub stripe_object_id: Option<String>,
    pub processed_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct BillingUsageReportRecord {
    pub schema_version: i32,
    pub id: Uuid,
    pub org_id: Uuid,
    pub usage_period_start: DateTime<Utc>,
    pub usage_period_end: DateTime<Utc>,
    pub billable_storage_bytes: i64,
    pub reported_gib: i64,
    #[serde(default)]
    pub reported_storage_gib_delta: i64,
    #[serde(default)]
    pub billable_api_requests: i64,
    #[serde(default)]
    pub reported_api_requests: i64,
    #[serde(default)]
    pub reported_api_requests_delta: i64,
    pub stripe_event_id: Option<String>,
    #[serde(default)]
    pub stripe_storage_event_id: Option<String>,
    #[serde(default)]
    pub stripe_api_request_event_id: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BillingCheckoutRequest {
    pub plan_tier: Option<String>,
    pub seat_emails: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BillingCheckoutSyncRequest {
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BillingPortalRequest {
    pub return_url: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BillingPlanChangeRequest {
    pub plan_tier: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BillingSeatChangeRequest {
    pub email: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BillingCancelRequest {
    pub at_period_end: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DevGoogleAuthRequest {
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub mode: Option<String>,
    pub account_type: Option<String>,
    pub org_name: Option<String>,
    pub plan_tier: Option<String>,
    pub storage_choice: Option<String>,
    pub seat_emails: Option<Vec<String>>,
    pub accept_invite_org_id: Option<Uuid>,
    pub accept_invite_token: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ClerkAuthRequest {
    pub token: Option<String>,
    pub mode: Option<String>,
    pub account_type: Option<String>,
    pub org_name: Option<String>,
    pub plan_tier: Option<String>,
    pub storage_choice: Option<String>,
    pub seat_emails: Option<Vec<String>>,
    pub accept_invite_org_id: Option<Uuid>,
    pub accept_invite_token: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ClickHouseConnectionValidateRequest {
    pub org_id: Option<Uuid>,
    pub endpoint: Option<String>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub storage_choice: Option<String>,
    pub allow_create_database: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ClickHouseConnectionCreateRequest {
    pub org_id: Option<Uuid>,
    pub endpoint: Option<String>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ClickHouseConnectionRotateCredentialsRequest {
    pub org_id: Option<Uuid>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct ClickHouseConnectionStatus {
    pub status: String,
    pub storage_choice: String,
    pub storage_state: String,
    pub provisioner: Option<String>,
    pub warehouse_kind: Option<String>,
    pub endpoint: Option<String>,
    pub endpoint_host: Option<String>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub required_egress_cidrs: Vec<String>,
    pub egress_description: String,
    pub egress_set_version: String,
    pub last_validated_at: Option<DateTime<Utc>>,
    pub validation_error_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct ClickHouseConnectionValidationResponse {
    pub status: String,
    pub server_version: Option<String>,
    pub current_user: Option<String>,
    pub database: String,
    pub required_egress_cidrs: Vec<String>,
    pub egress_description: String,
    pub egress_set_version: String,
    pub can_create_database: bool,
    pub can_migrate_schema: bool,
    pub can_insert_validation_record: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReserveSeatRequest {
    pub email: Option<String>,
    pub role: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct SeatUserRow {
    pub id: Uuid,
    pub primary_email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct SeatRow {
    pub membership: MembershipRow,
    pub user: SeatUserRow,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateInvitationRequest {
    pub email: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct InvitationTokenRequest {
    pub token: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OrgInvitationRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub email: String,
    pub role: String,
    pub status: String,
    pub token_hash: Vec<u8>,
    #[serde(default)]
    pub previous_token_hashes: Vec<Vec<u8>>,
    pub invited_by_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub last_sent_at: Option<DateTime<Utc>>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub accepted_by_user_id: Option<Uuid>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoked_by_user_id: Option<Uuid>,
    pub delivery_status: String,
    pub email_provider: Option<String>,
    pub provider_message_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmailDeliveryRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub invitation_id: Uuid,
    pub recipient_email: String,
    pub provider: String,
    pub status: String,
    pub provider_message_id: Option<String>,
    pub error_code: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct PublicInvitationRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub email: String,
    pub role: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub last_sent_at: Option<DateTime<Utc>>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub delivery_status: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct InvitationPreviewPayload {
    pub org_name: String,
    pub email_hint: String,
    pub role: String,
    pub status: String,
    pub expires_at: DateTime<Utc>,
}

/// Summary of a single org membership for the org-switcher UI. We surface only
/// the fields the dashboard needs (name + role) plus a member count so the
/// dropdown can show "Acme · admin · 5 members" without forcing the client to
/// stitch responses together.
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct OrganizationMembershipSummary {
    pub org_id: Uuid,
    pub name: String,
    pub slug: String,
    pub plan_tier: String,
    pub role: String,
    pub status: String,
    pub member_count: usize,
    pub is_current: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SwitchOrganizationRequest {
    pub org_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateApiKeyRequest {
    pub name: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub created_by_user_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub project: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct ServiceAccountRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub created_by_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub disabled_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct PublicApiKeyRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub service_account_id: Uuid,
    pub name: String,
    pub key_prefix: String,
    pub scopes: Vec<String>,
    pub project_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminOverviewResponse {
    pub schema_version: i32,
    pub generated_at: DateTime<Utc>,
    pub data_counts_available: bool,
    pub query: AdminOverviewQuerySummary,
    pub totals: AdminOverviewTotals,
    pub organizations: Vec<AdminOrganizationSummary>,
    pub users: Vec<AdminUserSummary>,
    pub api_keys: Vec<AdminApiKeySummary>,
    pub risks: Vec<AdminRiskItem>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminOverviewQuerySummary {
    pub q: Option<String>,
    pub limit: usize,
    pub matched_organizations: usize,
    pub matched_users: usize,
    pub matched_api_keys: usize,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminOverviewTotals {
    pub users: usize,
    pub organizations: usize,
    pub active_memberships: usize,
    pub invited_memberships: usize,
    pub pending_invitations: usize,
    pub active_api_keys: usize,
    pub revoked_api_keys: usize,
    pub expired_api_keys: usize,
    pub disabled_service_accounts: usize,
    pub storage_ready_orgs: usize,
    pub storage_unconfigured_orgs: usize,
    pub storage_locked_orgs: usize,
    pub billing_read_only_orgs: usize,
    pub risk_items: usize,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminUserIdentity {
    pub id: Uuid,
    pub primary_email: String,
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminUserOrgMembership {
    pub org_id: Uuid,
    pub org_name: String,
    pub role: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminUserSummary {
    pub id: Uuid,
    pub primary_email: String,
    pub display_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub status: String,
    pub active_memberships: usize,
    pub invited_memberships: usize,
    pub orgs: Vec<AdminUserOrgMembership>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminOrgCounts {
    pub active_members: usize,
    pub invited_members: usize,
    pub pending_invitations: usize,
    pub active_api_keys: usize,
    pub revoked_api_keys: usize,
    pub service_accounts: usize,
    pub disabled_service_accounts: usize,
    pub projects: Option<usize>,
    pub runs: Option<usize>,
    pub artifacts: Option<usize>,
    pub retained_artifact_bytes: Option<i64>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminUsageGauge {
    pub target: String,
    pub current: i64,
    pub limit: i64,
    pub percent: f64,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminStorageSummary {
    pub storage_choice: String,
    pub storage_state: String,
    pub tenant_routing_tier: String,
    pub route_status: Option<String>,
    pub route_provisioner: Option<String>,
    pub route_plan_tier: Option<String>,
    pub warehouse_kind: Option<String>,
    pub endpoint_host: Option<String>,
    pub database: Option<String>,
    pub service_id: Option<String>,
    pub requested_min_replica_memory_gb: Option<u32>,
    pub requested_max_replica_memory_gb: Option<u32>,
    pub requested_num_replicas: Option<u32>,
    pub applied_min_replica_memory_gb: Option<u32>,
    pub applied_max_replica_memory_gb: Option<u32>,
    pub applied_num_replicas: Option<u32>,
    pub schema_version: Option<u32>,
    pub updated_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminBillingSummary {
    pub access_state: String,
    pub effective_plan_tier: String,
    pub requested_plan_tier: Option<String>,
    pub paid_extra_seats: i32,
    pub subscription_status: Option<String>,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub current_period_end: Option<DateTime<Utc>>,
    pub cancel_at_period_end: bool,
    pub grace_until: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminOrganizationSummary {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub plan_tier: String,
    pub account_type: String,
    pub seat_limit: i32,
    pub created_at: DateTime<Utc>,
    pub owner: Option<AdminUserIdentity>,
    pub counts: AdminOrgCounts,
    pub usage: Vec<AdminUsageGauge>,
    pub storage: AdminStorageSummary,
    pub billing: Option<AdminBillingSummary>,
    pub risk_level: String,
    pub risk_reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminApiKeySummary {
    pub id: Uuid,
    pub org_id: Uuid,
    pub org_name: String,
    pub service_account_id: Uuid,
    pub service_account_name: Option<String>,
    pub name: String,
    pub key_prefix: String,
    pub scopes: Vec<String>,
    pub project_id: Option<Uuid>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AdminRiskItem {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub target_label: String,
    pub severity: String,
    pub category: String,
    pub message: String,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateProjectRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct ProjectRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateRunRequest {
    pub project: Option<String>,
    pub name: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub config: Option<Value>,
    pub tags: Option<Vec<String>>,
    #[schema(value_type = Option<Object>)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateRunForkRequest {
    pub name: Option<String>,
    pub step: Option<f64>,
    pub checkpoint_artifact_id: Option<Uuid>,
    pub inherit_config: Option<bool>,
    #[schema(value_type = Option<Object>)]
    pub config_overrides: Option<Value>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateDashboardPreferencesRequest {
    pub selected_project: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct DashboardPreferenceRow {
    pub schema_version: i32,
    pub org_id: Uuid,
    pub user_id: Option<Uuid>,
    pub selected_project: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SaveWorkspaceViewRequest {
    pub name: Option<String>,
    pub project: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub payload: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceViewRow {
    pub schema_version: i32,
    pub id: Uuid,
    pub org_id: Uuid,
    pub owner_user_id: Option<Uuid>,
    pub name: String,
    pub project: Option<String>,
    #[schema(value_type = Object)]
    pub payload: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct WorkspaceViewSummary {
    pub id: Uuid,
    pub name: String,
    pub project: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ============================================================================
// Reports — Notion-style documents with live PanelGrids + LLM summary blocks.
// Persisted via the same operational-records pattern as runs/projects/
// workspace_views (a JSON payload append-logged to ClickHouse and rebuilt
// into the in-memory index on boot).
// ============================================================================

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateReportRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub project_id: Option<Uuid>,
    pub visibility: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub blocks: Option<Value>,
    pub template: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateReportRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub visibility: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub blocks: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct ReportRow {
    pub schema_version: i32,
    pub id: Uuid,
    pub org_id: Uuid,
    pub project_id: Option<Uuid>,
    pub title: String,
    pub description: Option<String>,
    /// Ordered list of block JSON objects. Each block has a `kind` discriminator
    /// (`heading`, `paragraph`, `markdown`, `code`, `callout`, `horizontal_rule`,
    /// `image`, `panel_grid`, `llm_summary`) plus kind-specific fields.
    #[schema(value_type = Object)]
    pub blocks: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub author_user_id: Option<Uuid>,
    pub share_token: Option<String>,
    /// One of `"private"`, `"org"`, `"public"`.
    pub visibility: String,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct ReportSummary {
    pub id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub project_id: Option<Uuid>,
    pub visibility: String,
    pub has_share_token: bool,
    pub author_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub block_count: usize,
}

pub const REPORT_VISIBILITY_PRIVATE: &str = "private";
pub const REPORT_VISIBILITY_ORG: &str = "org";
pub const REPORT_VISIBILITY_PUBLIC: &str = "public";

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateRunRequest {
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct RunRow {
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
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LogMetricsRequest {
    #[schema(value_type = Object)]
    pub metrics: Value,
    #[schema(value_type = Object)]
    pub step: Value,
    pub timestamp: Option<String>,
    pub preview: Option<bool>,
    #[schema(value_type = Option<Object>)]
    pub preview_completion: Option<Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LogRankMetricsRequest {
    #[schema(value_type = Object)]
    pub metrics: Value,
    #[schema(value_type = Object)]
    pub step: Value,
    pub rank: u32,
    pub world_size: u32,
    pub local_rank: Option<u32>,
    #[serde(default)]
    pub weight: Option<f64>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RankReducerPoint {
    pub step: f64,
    pub rank_count: usize,
    pub expected_world_size: u32,
    pub world_size_mismatch: bool,
    pub mean: f64,
    pub weighted_mean: f64,
    pub min: f64,
    pub max: f64,
    pub stddev: f64,
    pub p05: f64,
    pub p50: f64,
    pub p95: f64,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RankHeatmapPoint {
    pub step: f64,
    pub rank: u32,
    pub value: f64,
    pub delta_from_mean: f64,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RankOutlierPoint {
    pub rank: u32,
    pub step: f64,
    pub value: f64,
    pub delta_from_mean: f64,
    pub z_score: f64,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RankCoveragePoint {
    pub step: f64,
    pub rank_count: usize,
    pub expected_world_size: u32,
    pub missing_rank_count: usize,
    pub missing_ranks: Vec<u32>,
    pub world_size_mismatch: bool,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RankMetricLimits {
    pub step_limit: i64,
    pub max_world_size: u32,
    pub max_canonical_rows: usize,
    pub max_heatmap_cells: usize,
    pub outlier_limit: usize,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RankMetricTruncation {
    pub steps: bool,
    pub heatmap: bool,
    pub outliers: bool,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct RankMetricsSummaryResponse {
    pub keys: Vec<String>,
    pub key: Option<String>,
    pub reducers: Vec<RankReducerPoint>,
    pub heatmap: Vec<RankHeatmapPoint>,
    pub outliers: Vec<RankOutlierPoint>,
    pub coverage: Vec<RankCoveragePoint>,
    pub limits: RankMetricLimits,
    pub truncated: RankMetricTruncation,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ConsoleLogInput {
    pub line_number: Option<u64>,
    pub message: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateConsoleLogsRequest {
    pub stream: Option<String>,
    pub lines: Option<Vec<ConsoleLogInput>>,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct ConsoleLogLine {
    pub run_id: Uuid,
    pub stream: String,
    pub line_number: u64,
    pub message: String,
    pub timestamp: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct MetricPointRow {
    pub key: String,
    pub step: f64,
    pub value: f64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct MetricSeriesRow {
    pub run_id: Uuid,
    pub key: String,
    pub count: i64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    pub variance: Option<f64>,
    pub latest: Option<f64>,
    pub latest_step: Option<f64>,
    pub best: Option<f64>,
    pub best_step: Option<f64>,
}

// --- Device-code (RFC 8628) domain types ---

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeviceCodeStartRequest {
    pub client_info: Option<DeviceCodeClientInfo>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeviceCodeClientInfo {
    pub name: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeviceCodePollRequest {
    pub device_code: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeviceCodeConfirmRequest {
    pub user_code: Option<String>,
}

// --- Attribute types ---

#[derive(Debug, Deserialize, ToSchema)]
pub struct AttributeInput {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[schema(value_type = Option<Object>)]
    pub step: Option<Value>,
    pub timestamp: Option<String>,
    #[schema(value_type = Object)]
    pub value: Value,
    #[schema(value_type = Option<Object>)]
    pub summary: Option<Value>,
    pub artifact_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAttributesRequest {
    pub attributes: Option<Vec<AttributeInput>>,
    pub path: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub step: Option<Value>,
    pub timestamp: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub value: Option<Value>,
    #[schema(value_type = Option<Object>)]
    pub summary: Option<Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateObjectRequest {
    pub key: Option<String>,
    pub kind: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub step: Option<Value>,
    pub artifact_id: Option<Uuid>,
    #[schema(value_type = Option<Object>)]
    pub metadata: Option<Value>,
    #[schema(value_type = Option<Object>)]
    pub summary: Option<Value>,
    #[schema(value_type = Option<Object>)]
    pub value: Option<Value>,
    #[schema(value_type = Option<Object>)]
    pub rows: Option<Vec<Value>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct AttributeRow {
    pub id: i64,
    pub org_id: Uuid,
    pub run_id: Uuid,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub step: Option<f64>,
    pub logged_at: Option<DateTime<Utc>>,
    #[schema(value_type = Object)]
    pub value: Value,
    #[schema(value_type = Object)]
    pub summary: Value,
    pub artifact_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateArtifactRequest {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub name: Option<String>,
    pub uri: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub step: Option<Value>,
    #[schema(value_type = Option<Object>)]
    pub size_bytes: Option<Value>,
    pub sha256: Option<String>,
    pub mime_type: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub metadata: Option<Value>,
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UploadArtifactRequest {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub name: Option<String>,
    pub content_base64: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub step: Option<Value>,
    pub mime_type: Option<String>,
    #[schema(value_type = Option<Object>)]
    pub metadata: Option<Value>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct ArtifactRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub run_id: Uuid,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub uri: String,
    pub step: Option<f64>,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub mime_type: Option<String>,
    pub storage_backend: String,
    pub storage_key: Option<String>,
    pub storage_path: Option<String>,
    #[schema(value_type = Object)]
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct PublicArtifactRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub run_id: Uuid,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub uri: String,
    pub step: Option<f64>,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub mime_type: Option<String>,
    pub storage_backend: String,
    #[schema(value_type = Object)]
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
}

impl ArtifactRow {
    pub fn public_row(&self) -> PublicArtifactRow {
        PublicArtifactRow {
            id: self.id,
            org_id: self.org_id,
            run_id: self.run_id,
            kind: self.kind.clone(),
            name: self.name.clone(),
            uri: self.public_uri(),
            step: self.step,
            size_bytes: self.size_bytes,
            sha256: self.sha256.clone(),
            mime_type: self.mime_type.clone(),
            storage_backend: self.storage_backend.clone(),
            metadata: self.metadata.clone(),
            created_at: self.created_at,
        }
    }

    pub fn public_uri(&self) -> String {
        if matches!(self.storage_backend.as_str(), "local" | "r2") {
            format!("instantml://artifacts/{}", self.id)
        } else {
            self.uri.clone()
        }
    }
}

pub fn validate_name(value: Option<&str>, field: &str) -> AppResult<String> {
    let text = value
        .ok_or_else(|| AppError::validation(format!("{field} must be a non-empty string")))?
        .trim();
    if text.is_empty() {
        return Err(AppError::validation(format!(
            "{field} must be a non-empty string"
        )));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(AppError::validation(format!(
            "{field} must be at most {MAX_TEXT_BYTES} bytes"
        )));
    }
    Ok(text.to_string())
}

pub fn validate_optional_name(value: Option<&str>, field: &str) -> AppResult<Option<String>> {
    value
        .map(|text| validate_name(Some(text), field))
        .transpose()
}

pub fn validate_email(value: Option<&str>) -> AppResult<String> {
    let email = validate_name(value, "email")?.to_ascii_lowercase();
    if !email.contains('@') || !email.contains('.') || email.contains(' ') {
        return Err(AppError::validation("email must be a valid email address"));
    }
    Ok(email)
}

pub fn validate_slug(value: Option<&str>, field: &str) -> AppResult<String> {
    let slug = validate_name(value, field)?.to_ascii_lowercase();
    let valid = slug.chars().enumerate().all(|(index, ch)| {
        ch.is_ascii_lowercase() || ch.is_ascii_digit() || (index > 0 && ch == '-')
    });
    if !valid || slug.ends_with('-') || slug.len() > 63 {
        return Err(AppError::validation(format!(
            "{field} must use lowercase letters, numbers, and hyphens"
        )));
    }
    Ok(slug)
}

pub fn validate_plan_tier(value: Option<&str>) -> AppResult<String> {
    let tier = validate_name(Some(value.unwrap_or("free")), "plan_tier")?.to_ascii_lowercase();
    match tier.as_str() {
        "free" => Ok("free".to_string()),
        "pro" | "lab" | "startup" => Ok("pro".to_string()),
        "premium" | "growth" => Ok("premium".to_string()),
        _ => Err(AppError::validation(
            "plan_tier must be one of: free, pro, premium",
        )),
    }
}

pub fn plan_tier(value: &str) -> PlanTier {
    match value {
        "pro" | "lab" | "startup" => PLAN_PRO,
        "premium" | "growth" => PLAN_PREMIUM,
        _ => PLAN_FREE,
    }
}

pub fn validate_account_type(value: Option<&str>) -> AppResult<String> {
    let account_type =
        validate_name(Some(value.unwrap_or("personal")), "account_type")?.to_ascii_lowercase();
    if matches!(account_type.as_str(), "customer" | "personal" | "business") {
        Ok(account_type)
    } else {
        Err(AppError::validation(
            "account_type must be one of: business, customer, personal",
        ))
    }
}

/// Returns true when the account type maps to shared-cell routing.
pub fn is_personal_account_type(account_type: &str) -> bool {
    matches!(account_type, "personal" | "customer")
}

pub fn validate_membership_role(value: Option<&str>) -> AppResult<String> {
    let role = validate_name(value, "role")?.to_ascii_lowercase();
    if matches!(role.as_str(), "owner" | "admin" | "member" | "viewer") {
        Ok(role)
    } else {
        Err(AppError::validation(
            "role must be one of: admin, member, owner, viewer",
        ))
    }
}

pub fn validate_membership_status(value: Option<&str>) -> AppResult<String> {
    let status = validate_name(value, "status")?.to_ascii_lowercase();
    if matches!(status.as_str(), "active" | "invited") {
        Ok(status)
    } else {
        Err(AppError::validation(
            "status must be one of: active, invited",
        ))
    }
}

pub fn validate_json_object(value: Option<Value>, field: &str) -> AppResult<Value> {
    let value = value.unwrap_or_else(|| Value::Object(Default::default()));
    if !value.is_object() {
        return Err(AppError::validation(format!("{field} must be an object")));
    }
    Ok(value)
}

pub fn validate_tags(tags: Option<Vec<String>>) -> AppResult<Vec<String>> {
    tags.unwrap_or_default()
        .into_iter()
        .map(|tag| validate_name(Some(&tag), "tag"))
        .collect()
}

pub fn validate_status(status: &str) -> AppResult<String> {
    let status = validate_name(Some(status), "status")?;
    if matches!(status.as_str(), "running" | "finished" | "failed") {
        Ok(status)
    } else {
        Err(AppError::validation(
            "status must be one of: failed, finished, running",
        ))
    }
}

pub fn validate_step(value: &Value, field: &str) -> AppResult<f64> {
    let number = value
        .as_f64()
        .ok_or_else(|| AppError::validation(format!("{field} must be finite numbers")))?;
    if !number.is_finite() || number < 0.0 {
        return Err(AppError::validation(format!(
            "{field} must be a nonnegative number"
        )));
    }
    Ok(number)
}

pub fn validate_optional_step(value: Option<&Value>, field: &str) -> AppResult<Option<f64>> {
    value.map(|step| validate_step(step, field)).transpose()
}

pub fn validate_timestamp(value: Option<&str>) -> AppResult<DateTime<Utc>> {
    match value {
        Some(raw) => DateTime::parse_from_rfc3339(&validate_name(Some(raw), "timestamp")?)
            .map(|timestamp| timestamp.with_timezone(&Utc))
            .map_err(|_| AppError::validation("timestamp must be an ISO-compatible datetime")),
        None => Ok(Utc::now()),
    }
}

pub fn validate_limit(value: Option<&str>, fallback: i64, max: i64) -> AppResult<i64> {
    let limit = match value {
        Some(raw) if !raw.trim().is_empty() => raw
            .parse::<i64>()
            .map_err(|_| AppError::validation(format!("limit must be between 1 and {max}")))?,
        _ => fallback,
    };
    if !(1..=max).contains(&limit) {
        return Err(AppError::validation(format!(
            "limit must be between 1 and {max}"
        )));
    }
    Ok(limit)
}

pub fn validate_offset(value: Option<&str>) -> AppResult<i64> {
    let offset = match value {
        Some(raw) if !raw.trim().is_empty() => raw
            .parse::<i64>()
            .map_err(|_| AppError::validation("offset must be a nonnegative integer"))?,
        _ => 0,
    };
    if offset < 0 {
        return Err(AppError::validation("offset must be a nonnegative integer"));
    }
    Ok(offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    #[test]
    fn public_artifact_row_redacts_stored_backend_locations() {
        for storage_backend in ["local", "r2"] {
            let row = artifact_row(storage_backend, "r2://bucket/runs/run/artifact.bin");
            let public = row.public_row();
            let public_value = to_value(&public).expect("serializable public artifact");

            assert_eq!(public.uri, format!("instantml://artifacts/{}", row.id));
            assert_eq!(public.storage_backend, storage_backend);
            assert!(public_value.get("storage_key").is_none());
            assert!(public_value.get("storage_path").is_none());
            assert!(!public_value["uri"]
                .as_str()
                .expect("public uri")
                .contains("bucket/runs"));
        }
    }

    #[test]
    fn public_artifact_row_preserves_external_references() {
        let row = artifact_row("external", "s3://customer-bucket/model.pt");
        let public = row.public_row();

        assert_eq!(public.uri, "s3://customer-bucket/model.pt");
        assert_eq!(public.storage_backend, "external");
    }

    fn artifact_row(storage_backend: &str, uri: &str) -> ArtifactRow {
        ArtifactRow {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            kind: "file".to_string(),
            name: "artifact.bin".to_string(),
            uri: uri.to_string(),
            step: Some(1.0),
            size_bytes: Some(128),
            sha256: Some("abc123".to_string()),
            mime_type: Some("application/octet-stream".to_string()),
            storage_backend: storage_backend.to_string(),
            storage_key: Some("bucket/runs/run/artifact.bin".to_string()),
            storage_path: Some("r2://bucket/runs/run/artifact.bin".to_string()),
            metadata: json!({"source": "test"}),
            created_at: Utc::now(),
        }
    }
}
