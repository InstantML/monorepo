//! `FromRow` mappers from Postgres rows to the control-plane domain types.
//! Pure data-shape conversion, separated from the query logic in the sibling
//! modules.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

use crate::domain::{
    BillingAccountProjection, BillingChangeIntent, BillingCheckoutIntent, BillingEventRecord,
    BillingSubscriptionRecord, BillingUsageReportRecord, DashboardPreferenceRow, EmailDeliveryRow,
    MembershipRow, OrgInvitationRow, OrganizationRow, PublicApiKeyRow, ServiceAccountRow, UserRow,
    UserSessionRow, WorkspaceViewRow,
};
use crate::store::TenantRouteRecord;

use super::{opt_i32_to_u32, ApiKeyWithHash, LoadedIdentity, NewSession};

#[derive(FromRow)]
pub(super) struct UserRowDb {
    id: Uuid,
    primary_email: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    created_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
}

impl From<UserRowDb> for UserRow {
    fn from(row: UserRowDb) -> Self {
        UserRow {
            id: row.id,
            primary_email: row.primary_email,
            display_name: row.display_name,
            avatar_url: row.avatar_url,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct OrganizationRowDb {
    id: Uuid,
    slug: String,
    name: String,
    plan_tier: String,
    account_type: String,
    seat_limit: i32,
    created_by_user_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    tenant_routing_tier: String,
    storage_choice: String,
    storage_state: String,
}

impl From<OrganizationRowDb> for OrganizationRow {
    fn from(row: OrganizationRowDb) -> Self {
        OrganizationRow {
            id: row.id,
            slug: row.slug,
            name: row.name,
            plan_tier: row.plan_tier,
            account_type: row.account_type,
            seat_limit: row.seat_limit,
            created_by_user_id: row.created_by_user_id,
            created_at: row.created_at,
            tenant_routing_tier: row.tenant_routing_tier,
            storage_choice: row.storage_choice,
            storage_state: row.storage_state,
        }
    }
}

#[derive(FromRow)]
pub(super) struct MembershipRowDb {
    id: Uuid,
    org_id: Uuid,
    user_id: Uuid,
    role: String,
    status: String,
    created_at: DateTime<Utc>,
}

impl From<MembershipRowDb> for MembershipRow {
    fn from(row: MembershipRowDb) -> Self {
        MembershipRow {
            id: row.id,
            org_id: row.org_id,
            user_id: row.user_id,
            role: row.role,
            status: row.status,
            created_at: row.created_at,
        }
    }
}
#[derive(FromRow)]
pub(super) struct ServiceAccountRowDb {
    id: Uuid,
    org_id: Uuid,
    name: String,
    created_by_user_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    disabled_at: Option<DateTime<Utc>>,
}

impl From<ServiceAccountRowDb> for ServiceAccountRow {
    fn from(row: ServiceAccountRowDb) -> Self {
        ServiceAccountRow {
            id: row.id,
            org_id: row.org_id,
            name: row.name,
            created_by_user_id: row.created_by_user_id,
            created_at: row.created_at,
            disabled_at: row.disabled_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct SessionRowDb {
    id: Uuid,
    user_id: Uuid,
    org_id: Uuid,
    token_hash: Vec<u8>,
    metadata: Value,
    created_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}

impl From<SessionRowDb> for NewSession {
    fn from(row: SessionRowDb) -> Self {
        NewSession {
            row: UserSessionRow {
                id: row.id,
                user_id: row.user_id,
                org_id: row.org_id,
                metadata: row.metadata,
                created_at: row.created_at,
                last_seen_at: row.last_seen_at,
                expires_at: row.expires_at,
                revoked_at: row.revoked_at,
            },
            token_hash: row.token_hash,
        }
    }
}

#[derive(FromRow)]
pub(super) struct ApiKeyRowDb {
    id: Uuid,
    org_id: Uuid,
    service_account_id: Uuid,
    name: String,
    key_prefix: String,
    key_hash: Vec<u8>,
    scopes: Vec<String>,
    project_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

impl From<ApiKeyRowDb> for ApiKeyWithHash {
    fn from(row: ApiKeyRowDb) -> Self {
        ApiKeyWithHash {
            row: PublicApiKeyRow {
                id: row.id,
                org_id: row.org_id,
                service_account_id: row.service_account_id,
                name: row.name,
                key_prefix: row.key_prefix,
                scopes: row.scopes,
                project_id: row.project_id,
                created_at: row.created_at,
                expires_at: row.expires_at,
                last_used_at: row.last_used_at,
                revoked_at: row.revoked_at,
            },
            key_hash: row.key_hash,
        }
    }
}

#[derive(FromRow)]
pub(super) struct IdentityRowDb {
    provider: String,
    provider_subject: String,
    user_id: Uuid,
}

impl From<IdentityRowDb> for LoadedIdentity {
    fn from(row: IdentityRowDb) -> Self {
        LoadedIdentity {
            provider: row.provider,
            provider_subject: row.provider_subject,
            user_id: row.user_id,
        }
    }
}
#[derive(FromRow)]
pub(super) struct OrgInvitationRowDb {
    id: Uuid,
    org_id: Uuid,
    email: String,
    role: String,
    status: String,
    token_hash: Vec<u8>,
    previous_token_hashes: Vec<Vec<u8>>,
    invited_by_user_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    last_sent_at: Option<DateTime<Utc>>,
    accepted_at: Option<DateTime<Utc>>,
    accepted_by_user_id: Option<Uuid>,
    revoked_at: Option<DateTime<Utc>>,
    revoked_by_user_id: Option<Uuid>,
    delivery_status: String,
    email_provider: Option<String>,
    provider_message_id: Option<String>,
}

impl From<OrgInvitationRowDb> for OrgInvitationRow {
    fn from(row: OrgInvitationRowDb) -> Self {
        OrgInvitationRow {
            id: row.id,
            org_id: row.org_id,
            email: row.email,
            role: row.role,
            status: row.status,
            token_hash: row.token_hash,
            previous_token_hashes: row.previous_token_hashes,
            invited_by_user_id: row.invited_by_user_id,
            created_at: row.created_at,
            expires_at: row.expires_at,
            last_sent_at: row.last_sent_at,
            accepted_at: row.accepted_at,
            accepted_by_user_id: row.accepted_by_user_id,
            revoked_at: row.revoked_at,
            revoked_by_user_id: row.revoked_by_user_id,
            delivery_status: row.delivery_status,
            email_provider: row.email_provider,
            provider_message_id: row.provider_message_id,
        }
    }
}

#[derive(FromRow)]
pub(super) struct EmailDeliveryRowDb {
    id: Uuid,
    org_id: Uuid,
    invitation_id: Uuid,
    recipient_email: String,
    provider: String,
    status: String,
    provider_message_id: Option<String>,
    error_code: Option<String>,
    created_at: DateTime<Utc>,
}

impl From<EmailDeliveryRowDb> for EmailDeliveryRow {
    fn from(row: EmailDeliveryRowDb) -> Self {
        EmailDeliveryRow {
            id: row.id,
            org_id: row.org_id,
            invitation_id: row.invitation_id,
            recipient_email: row.recipient_email,
            provider: row.provider,
            status: row.status,
            provider_message_id: row.provider_message_id,
            error_code: row.error_code,
            created_at: row.created_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct DashboardPreferenceRowDb {
    schema_version: i32,
    org_id: Uuid,
    user_id: Option<Uuid>,
    selected_project: Option<String>,
    updated_at: DateTime<Utc>,
}

impl From<DashboardPreferenceRowDb> for DashboardPreferenceRow {
    fn from(row: DashboardPreferenceRowDb) -> Self {
        DashboardPreferenceRow {
            schema_version: row.schema_version,
            org_id: row.org_id,
            user_id: row.user_id,
            selected_project: row.selected_project,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct WorkspaceViewRowDb {
    schema_version: i32,
    id: Uuid,
    org_id: Uuid,
    owner_user_id: Option<Uuid>,
    name: String,
    project: Option<String>,
    payload: Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
}

impl From<WorkspaceViewRowDb> for WorkspaceViewRow {
    fn from(row: WorkspaceViewRowDb) -> Self {
        WorkspaceViewRow {
            schema_version: row.schema_version,
            id: row.id,
            org_id: row.org_id,
            owner_user_id: row.owner_user_id,
            name: row.name,
            project: row.project,
            payload: row.payload,
            created_at: row.created_at,
            updated_at: row.updated_at,
            deleted_at: row.deleted_at,
        }
    }
}

/// Postgres stores replica sizing as signed `integer`; the domain type uses
#[derive(FromRow)]
pub(super) struct TenantRouteRowDb {
    org_id: Uuid,
    status: String,
    provisioner: String,
    plan_tier: Option<String>,
    warehouse_kind: Option<String>,
    requested_min_replica_memory_gb: Option<i32>,
    requested_max_replica_memory_gb: Option<i32>,
    requested_num_replicas: Option<i32>,
    applied_min_replica_memory_gb: Option<i32>,
    applied_max_replica_memory_gb: Option<i32>,
    applied_num_replicas: Option<i32>,
    endpoint: String,
    database: String,
    username: String,
    password_secret_ref: Option<String>,
    password_ciphertext: Option<String>,
    schema_version: Option<i32>,
    service_id: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    error: Option<String>,
}

impl From<TenantRouteRowDb> for TenantRouteRecord {
    fn from(row: TenantRouteRowDb) -> Self {
        TenantRouteRecord {
            org_id: row.org_id,
            status: row.status,
            provisioner: row.provisioner,
            plan_tier: row.plan_tier,
            warehouse_kind: row.warehouse_kind,
            requested_min_replica_memory_gb: opt_i32_to_u32(row.requested_min_replica_memory_gb),
            requested_max_replica_memory_gb: opt_i32_to_u32(row.requested_max_replica_memory_gb),
            requested_num_replicas: opt_i32_to_u32(row.requested_num_replicas),
            applied_min_replica_memory_gb: opt_i32_to_u32(row.applied_min_replica_memory_gb),
            applied_max_replica_memory_gb: opt_i32_to_u32(row.applied_max_replica_memory_gb),
            applied_num_replicas: opt_i32_to_u32(row.applied_num_replicas),
            endpoint: row.endpoint,
            database: row.database,
            username: row.username,
            password_secret_ref: row.password_secret_ref,
            password_ciphertext: row.password_ciphertext,
            schema_version: opt_i32_to_u32(row.schema_version),
            service_id: row.service_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            error: row.error,
        }
    }
}
#[derive(FromRow)]
pub(super) struct BillingAccountRowDb {
    schema_version: i32,
    org_id: Uuid,
    access_state: String,
    plan_tier: String,
    effective_plan_tier: String,
    requested_plan_tier: Option<String>,
    paid_extra_seats: i32,
    stripe_customer_id: Option<String>,
    stripe_subscription_id: Option<String>,
    subscription_status: Option<String>,
    current_period_start: Option<DateTime<Utc>>,
    current_period_end: Option<DateTime<Utc>>,
    cancel_at_period_end: bool,
    grace_until: Option<DateTime<Utc>>,
    pending_intent_id: Option<Uuid>,
    message: Option<String>,
    updated_at: DateTime<Utc>,
}

impl From<BillingAccountRowDb> for BillingAccountProjection {
    fn from(row: BillingAccountRowDb) -> Self {
        BillingAccountProjection {
            schema_version: row.schema_version,
            org_id: row.org_id,
            access_state: row.access_state,
            plan_tier: row.plan_tier,
            effective_plan_tier: row.effective_plan_tier,
            requested_plan_tier: row.requested_plan_tier,
            paid_extra_seats: row.paid_extra_seats,
            stripe_customer_id: row.stripe_customer_id,
            stripe_subscription_id: row.stripe_subscription_id,
            subscription_status: row.subscription_status,
            current_period_start: row.current_period_start,
            current_period_end: row.current_period_end,
            cancel_at_period_end: row.cancel_at_period_end,
            grace_until: row.grace_until,
            pending_intent_id: row.pending_intent_id,
            message: row.message,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct BillingCheckoutIntentRowDb {
    schema_version: i32,
    id: Uuid,
    org_id: Uuid,
    user_id: Uuid,
    action: String,
    target_plan_tier: String,
    pending_seat_emails: Vec<String>,
    stripe_checkout_session_id: Option<String>,
    stripe_customer_id: Option<String>,
    stripe_subscription_id: Option<String>,
    status: String,
    url: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
}

impl From<BillingCheckoutIntentRowDb> for BillingCheckoutIntent {
    fn from(row: BillingCheckoutIntentRowDb) -> Self {
        BillingCheckoutIntent {
            schema_version: row.schema_version,
            id: row.id,
            org_id: row.org_id,
            user_id: row.user_id,
            action: row.action,
            target_plan_tier: row.target_plan_tier,
            pending_seat_emails: row.pending_seat_emails,
            stripe_checkout_session_id: row.stripe_checkout_session_id,
            stripe_customer_id: row.stripe_customer_id,
            stripe_subscription_id: row.stripe_subscription_id,
            status: row.status,
            url: row.url,
            created_at: row.created_at,
            expires_at: row.expires_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct BillingChangeIntentRowDb {
    schema_version: i32,
    id: Uuid,
    org_id: Uuid,
    user_id: Uuid,
    action: String,
    target_plan_tier: Option<String>,
    target_extra_seats: Option<i32>,
    pending_seat_email: Option<String>,
    pending_seat_role: Option<String>,
    stripe_invoice_id: Option<String>,
    stripe_subscription_id: Option<String>,
    status: String,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
}

impl From<BillingChangeIntentRowDb> for BillingChangeIntent {
    fn from(row: BillingChangeIntentRowDb) -> Self {
        BillingChangeIntent {
            schema_version: row.schema_version,
            id: row.id,
            org_id: row.org_id,
            user_id: row.user_id,
            action: row.action,
            target_plan_tier: row.target_plan_tier,
            target_extra_seats: row.target_extra_seats,
            pending_seat_email: row.pending_seat_email,
            pending_seat_role: row.pending_seat_role,
            stripe_invoice_id: row.stripe_invoice_id,
            stripe_subscription_id: row.stripe_subscription_id,
            status: row.status,
            created_at: row.created_at,
            expires_at: row.expires_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct BillingSubscriptionRowDb {
    schema_version: i32,
    org_id: Uuid,
    stripe_subscription_id: String,
    stripe_customer_id: Option<String>,
    status: String,
    plan_tier: String,
    paid_extra_seats: i32,
    current_period_start: Option<DateTime<Utc>>,
    current_period_end: Option<DateTime<Utc>>,
    cancel_at_period_end: bool,
    metadata: Value,
    updated_at: DateTime<Utc>,
}

impl From<BillingSubscriptionRowDb> for BillingSubscriptionRecord {
    fn from(row: BillingSubscriptionRowDb) -> Self {
        BillingSubscriptionRecord {
            schema_version: row.schema_version,
            org_id: row.org_id,
            stripe_subscription_id: row.stripe_subscription_id,
            stripe_customer_id: row.stripe_customer_id,
            status: row.status,
            plan_tier: row.plan_tier,
            paid_extra_seats: row.paid_extra_seats,
            current_period_start: row.current_period_start,
            current_period_end: row.current_period_end,
            cancel_at_period_end: row.cancel_at_period_end,
            metadata: row.metadata,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct BillingEventRowDb {
    schema_version: i32,
    stripe_event_id: String,
    event_type: String,
    org_id: Option<Uuid>,
    stripe_object_id: Option<String>,
    processed_at: DateTime<Utc>,
}

impl From<BillingEventRowDb> for BillingEventRecord {
    fn from(row: BillingEventRowDb) -> Self {
        BillingEventRecord {
            schema_version: row.schema_version,
            stripe_event_id: row.stripe_event_id,
            event_type: row.event_type,
            org_id: row.org_id,
            stripe_object_id: row.stripe_object_id,
            processed_at: row.processed_at,
        }
    }
}

#[derive(FromRow)]
pub(super) struct BillingUsageReportRowDb {
    schema_version: i32,
    id: Uuid,
    org_id: Uuid,
    usage_period_start: DateTime<Utc>,
    usage_period_end: DateTime<Utc>,
    billable_storage_bytes: i64,
    reported_gib: i64,
    reported_storage_gib_delta: i64,
    billable_api_requests: i64,
    reported_api_requests: i64,
    reported_api_requests_delta: i64,
    stripe_event_id: Option<String>,
    stripe_storage_event_id: Option<String>,
    stripe_api_request_event_id: Option<String>,
    status: String,
    created_at: DateTime<Utc>,
}

impl From<BillingUsageReportRowDb> for BillingUsageReportRecord {
    fn from(row: BillingUsageReportRowDb) -> Self {
        BillingUsageReportRecord {
            schema_version: row.schema_version,
            id: row.id,
            org_id: row.org_id,
            usage_period_start: row.usage_period_start,
            usage_period_end: row.usage_period_end,
            billable_storage_bytes: row.billable_storage_bytes,
            reported_gib: row.reported_gib,
            reported_storage_gib_delta: row.reported_storage_gib_delta,
            billable_api_requests: row.billable_api_requests,
            reported_api_requests: row.reported_api_requests,
            reported_api_requests_delta: row.reported_api_requests_delta,
            stripe_event_id: row.stripe_event_id,
            stripe_storage_event_id: row.stripe_storage_event_id,
            stripe_api_request_event_id: row.stripe_api_request_event_id,
            status: row.status,
            created_at: row.created_at,
        }
    }
}
