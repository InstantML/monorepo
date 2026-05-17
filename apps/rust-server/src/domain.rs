use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    errors::{AppError, AppResult},
    store::LOCAL_ORG_ID,
};

pub const MAX_TEXT_BYTES: usize = 512;
pub const MAX_METRICS_PER_BATCH: usize = 1_000;
pub const DEFAULT_METRIC_LIMIT: i64 = 1_000;
pub const MAX_METRIC_LIMIT: i64 = 5_000;
pub const DEFAULT_RUN_LIMIT: i64 = 100;
pub const MAX_RUN_LIMIT: i64 = 500;
pub const MAX_METRIC_SERIES_RUN_IDS: usize = 500;
pub const DEFAULT_CONSOLE_LOG_LIMIT: i64 = 250;
pub const MAX_CONSOLE_LOG_LIMIT: i64 = 1_000;
pub const MAX_CONSOLE_LOG_LINES_PER_BATCH: usize = 50;
pub const MAX_CONSOLE_LOG_MESSAGE_BYTES: usize = 16 * 1024;
pub const GIB_BYTES: i64 = 1024 * 1024 * 1024;

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

#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub email: Option<String>,
    pub primary_email: Option<String>,
    pub provider: Option<String>,
    pub provider_subject: Option<String>,
    pub email_verified: Option<bool>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UserRow {
    pub id: Uuid,
    pub primary_email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateOrganizationRequest {
    pub slug: Option<String>,
    pub name: Option<String>,
    pub plan_tier: Option<String>,
    pub owner_user_id: Option<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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
}

fn default_routing_tier() -> String {
    "dedicated".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MembershipRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UserSessionRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub org_id: Uuid,
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AuthSessionPayload {
    pub authenticated: bool,
    pub session: UserSessionRow,
    pub user: UserRow,
    pub organization: OrganizationRow,
    pub membership: MembershipRow,
    pub memberships: Vec<MembershipRow>,
    pub account_type: String,
    pub provisioning: Option<ProvisioningStatusPayload>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProvisioningStatusPayload {
    pub status: String,
    pub mode: String,
    pub service_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
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

#[derive(Debug, Deserialize)]
pub struct DevGoogleAuthRequest {
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub mode: Option<String>,
    pub account_type: Option<String>,
    pub org_name: Option<String>,
    pub plan_tier: Option<String>,
    pub seat_emails: Option<Vec<String>>,
    pub accept_invite_org_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ClerkAuthRequest {
    pub token: Option<String>,
    pub mode: Option<String>,
    pub account_type: Option<String>,
    pub org_name: Option<String>,
    pub plan_tier: Option<String>,
    pub seat_emails: Option<Vec<String>>,
    pub accept_invite_org_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ReserveSeatRequest {
    pub email: Option<String>,
    pub role: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SeatUserRow {
    pub id: Uuid,
    pub primary_email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SeatRow {
    pub membership: MembershipRow,
    pub user: SeatUserRow,
}

#[derive(Debug, Deserialize)]
pub struct CreateApiKeyRequest {
    pub name: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub created_by_user_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub project: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceAccountRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub created_by_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub disabled_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRunRequest {
    pub project: Option<String>,
    pub name: Option<String>,
    pub config: Option<Value>,
    pub tags: Option<Vec<String>>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRunRequest {
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub project_id: Uuid,
    pub project: String,
    pub name: String,
    pub status: String,
    pub config: Value,
    pub tags: Vec<String>,
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct LogMetricsRequest {
    pub metrics: Value,
    pub step: Value,
    pub timestamp: Option<String>,
    pub preview: Option<bool>,
    pub preview_completion: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct ConsoleLogInput {
    pub line_number: Option<u64>,
    pub message: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConsoleLogsRequest {
    pub stream: Option<String>,
    pub lines: Option<Vec<ConsoleLogInput>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConsoleLogLine {
    pub run_id: Uuid,
    pub stream: String,
    pub line_number: u64,
    pub message: String,
    pub timestamp: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MetricPointRow {
    pub key: String,
    pub step: f64,
    pub value: f64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone)]
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

#[derive(Debug, Deserialize)]
pub struct AttributeInput {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub step: Option<Value>,
    pub timestamp: Option<String>,
    pub value: Value,
    pub summary: Option<Value>,
    pub artifact_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAttributesRequest {
    pub attributes: Option<Vec<AttributeInput>>,
    pub path: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub step: Option<Value>,
    pub timestamp: Option<String>,
    pub value: Option<Value>,
    pub summary: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct CreateObjectRequest {
    pub key: Option<String>,
    pub kind: Option<String>,
    pub step: Option<Value>,
    pub artifact_id: Option<Uuid>,
    pub metadata: Option<Value>,
    pub summary: Option<Value>,
    pub value: Option<Value>,
    pub rows: Option<Vec<Value>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AttributeRow {
    pub id: i64,
    pub org_id: Uuid,
    pub run_id: Uuid,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub step: Option<f64>,
    pub logged_at: Option<DateTime<Utc>>,
    pub value: Value,
    pub summary: Value,
    pub artifact_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateArtifactRequest {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub name: Option<String>,
    pub uri: Option<String>,
    pub step: Option<Value>,
    pub size_bytes: Option<Value>,
    pub sha256: Option<String>,
    pub mime_type: Option<String>,
    pub metadata: Option<Value>,
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UploadArtifactRequest {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub name: Option<String>,
    pub content_base64: Option<String>,
    pub step: Option<Value>,
    pub mime_type: Option<String>,
    pub metadata: Option<Value>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
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
