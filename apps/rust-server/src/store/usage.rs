use super::*;
use chrono::{Datelike, TimeZone};

pub const PROJECT_METADATA_BYTES: i64 = 512;
pub const RUN_METADATA_BYTES: i64 = 1024;
pub const METRIC_SERIES_METADATA_BYTES: i64 = 256;
pub const ARTIFACT_METADATA_BYTES: i64 = 512;
pub const API_KEY_METADATA_BYTES: i64 = 512;
pub const SEAT_METADATA_BYTES: i64 = 256;

#[derive(Clone, Copy, Debug, Default)]
pub struct UsageDelta {
    pub projects: i64,
    pub runs: i64,
    pub metric_points: i64,
    pub storage_bytes: i64,
}

#[derive(Clone, Copy, Debug)]
pub struct StorageOverageUsage {
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
    pub storage_bytes_for_warnings: i64,
    pub billable_storage_bytes: i64,
    pub reported_gib: i64,
}

#[derive(Clone, Copy, Debug)]
pub struct BillingOverageUsage {
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
    pub storage_bytes_for_warnings: i64,
    pub billable_storage_bytes: i64,
    pub reported_gib: i64,
    pub billable_api_requests: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiRequestOverageMode {
    Blocked,
    Metered,
    LegacyCompatibility,
}

#[derive(Clone, Debug)]
pub struct ApiRequestMonthlyQuota {
    pub allowed: bool,
    pub current_requests: i64,
    pub projected_requests: i64,
    pub limit: i64,
    pub remaining_after_request: i64,
    pub period_start: DateTime<Utc>,
    pub reset_at: DateTime<Utc>,
    pub overage_mode: ApiRequestOverageMode,
    pub plan_tier: String,
}

pub async fn usage_summary(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    usage_summary_for_org(store, ctx.org_id).await
}

pub async fn plan_for_org(store: &Store, org_id: Uuid) -> AppResult<crate::domain::PlanTier> {
    let data = store.data.lock().await;
    let org = data
        .organizations
        .get(&org_id)
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    Ok(plan_tier(&org.plan_tier))
}

pub async fn record_api_request_usage(
    store: &Store,
    org_id: Uuid,
    class: &str,
    instance_id: &str,
) -> AppResult<()> {
    let now = Utc::now();
    let (rollup, should_persist) = {
        let mut data = store.data.lock().await;
        data.increment_api_request_rollup(org_id, class, instance_id, now)
    };
    if should_persist {
        store
            .persist_locked("api_usage_monthly", org_id, &rollup.entity_id(), &rollup)
            .await?;
        let mut data = store.data.lock().await;
        data.mark_api_request_rollup_persisted(&rollup);
    }
    Ok(())
}

pub async fn api_request_monthly_quota(
    store: &Store,
    org_id: Uuid,
) -> AppResult<ApiRequestMonthlyQuota> {
    let now = Utc::now();
    let period = current_usage_period(now);
    let period_key = api_request_usage_period_key(period.starts_at);
    let metric_store = store.metric_store_for_org(org_id).await?;
    refresh_api_request_rollups_for_period(store, org_id, &period, &metric_store).await?;
    let data = store.data.lock().await;
    let org = data
        .organizations
        .get(&org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let plan = plan_tier(&org.plan_tier);
    let current_requests = data.api_request_usage_for_org_period(org_id, &period_key);
    let projected_requests = current_requests.saturating_add(1);
    let overage_mode = api_request_overage_mode(&data, org_id, plan.id);
    let allowed = plan.api_requests <= 0
        || projected_requests <= plan.api_requests
        || matches!(
            overage_mode,
            ApiRequestOverageMode::Metered | ApiRequestOverageMode::LegacyCompatibility
        );
    Ok(ApiRequestMonthlyQuota {
        allowed,
        current_requests,
        projected_requests,
        limit: plan.api_requests,
        remaining_after_request: (plan.api_requests - projected_requests).max(0),
        period_start: period.starts_at,
        reset_at: period.ends_at,
        overage_mode,
        plan_tier: plan.id.to_string(),
    })
}

pub async fn storage_overage_usage_for_org(
    store: &Store,
    org_id: Uuid,
) -> AppResult<StorageOverageUsage> {
    let usage = billing_overage_usage_for_org(store, org_id).await?;
    Ok(StorageOverageUsage {
        period_start: usage.period_start,
        period_end: usage.period_end,
        storage_bytes_for_warnings: usage.storage_bytes_for_warnings,
        billable_storage_bytes: usage.billable_storage_bytes,
        reported_gib: usage.reported_gib,
    })
}

pub async fn billing_overage_usage_for_org(
    store: &Store,
    org_id: Uuid,
) -> AppResult<BillingOverageUsage> {
    let counts = usage_counts_for_org(store, org_id, UsageCountMode::Summary).await?;
    let billable_storage_bytes = billable_storage_bytes(&counts);
    let reported_gib = ceil_div_i64(billable_storage_bytes, GIB_BYTES);
    let billable_api_requests = billable_api_requests(&counts);
    Ok(BillingOverageUsage {
        period_start: counts.period.starts_at,
        period_end: counts.period.ends_at,
        storage_bytes_for_warnings: counts.storage_bytes_for_warnings,
        billable_storage_bytes,
        reported_gib,
        billable_api_requests,
    })
}

pub async fn enforce_plan_capacity(
    store: &Store,
    org_id: Uuid,
    delta: UsageDelta,
    action: &str,
) -> AppResult<()> {
    let counts = usage_counts_for_org(store, org_id, UsageCountMode::WriteGate).await?;
    if let Some(violation) = first_blocking_violation(&counts, delta) {
        return Err(AppError::with_code(
            axum::http::StatusCode::PAYMENT_REQUIRED,
            "plan_limit_exceeded",
            format!(
                "plan limit exceeded: {target} {reason} the {plan} limit while trying to {action}",
                target = violation.target,
                reason = violation.reason,
                plan = counts.plan.label,
            ),
        ));
    }
    Ok(())
}

async fn usage_summary_for_org(store: &Store, org_id: Uuid) -> AppResult<Value> {
    let counts = usage_counts_for_org(store, org_id, UsageCountMode::Summary).await?;
    let period = usage_period_value(&counts.period);
    Ok(json!({
        "schema_version": 1,
        "billing_precision": "not_billable",
        "generated_at": Utc::now(),
        "source": "computed_current_state",
        "usage_period": period,
        "plans": plan_catalog(),
        "overage_policy": overage_policy(),
        "organizations": [usage_org_value(&counts)]
    }))
}

#[derive(Clone, Copy)]
enum UsageCountMode {
    Summary,
    WriteGate,
}

async fn usage_counts_for_org(
    store: &Store,
    org_id: Uuid,
    mode: UsageCountMode,
) -> AppResult<UsageCounts> {
    let period = current_usage_period(Utc::now());
    let metric_store = store.metric_store_for_org(org_id).await?;
    refresh_api_request_rollups_for_period(store, org_id, &period, &metric_store).await?;
    let scalar_points_retained_total = metric_store.count_points_for_org(org_id).await?;
    let rank_points_retained_total = match mode {
        UsageCountMode::Summary => metric_store.count_rank_points_for_org(org_id).await?,
        UsageCountMode::WriteGate => 0,
    };
    let metric_points_retained_total = scalar_points_retained_total + rank_points_retained_total;
    let scalar_metric_points = metric_store
        .count_points_for_org_period(org_id, period.starts_at, period.ends_at)
        .await?;
    let rank_metric_points = metric_store
        .count_rank_points_for_org_period(org_id, period.starts_at, period.ends_at)
        .await?;
    let metric_points = scalar_metric_points + rank_metric_points;
    let metric_series = metric_store.count_series_for_org(org_id).await?;
    let warehouse_storage_bytes_exact = store.warehouse_storage_bytes_for_org(org_id).await?;
    let data = store.data.lock().await;
    let org = data
        .organizations
        .get(&org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let org_artifacts = data
        .artifacts
        .values()
        .filter(|artifact| artifact.org_id == org_id)
        .collect::<Vec<_>>();
    let artifact_usage = artifact_usage_counts(org_artifacts.iter().copied());
    let versioned_artifact_usage = versioned_artifact_usage_counts(
        data.artifact_versions
            .values()
            .filter(|version| version.org_id == org_id),
        data.artifact_upload_sessions
            .values()
            .filter(|session| session.org_id == org_id),
        Utc::now(),
    );
    let artifact_collections = data
        .artifact_collections
        .values()
        .filter(|collection| collection.org_id == org_id && collection.deleted_at.is_none())
        .count() as i64;
    let seats = reserved_seat_count_in_data(&data, org_id, Utc::now()) as i64;
    let projects = data
        .projects
        .values()
        .filter(|project| project.org_id == org_id)
        .count() as i64;
    let runs = data
        .runs
        .values()
        .filter(|run| run.org_id == org_id)
        .count() as i64;
    let artifacts = artifact_usage.artifacts
        + versioned_artifact_usage.active_versions
        + versioned_artifact_usage.pending_delete_versions;
    let api_keys = data
        .api_keys
        .values()
        .filter(|key| key.row.org_id == org_id && key.row.revoked_at.is_none())
        .count() as i64;
    let api_requests = data
        .api_request_usage_for_org_period(org_id, &api_request_usage_period_key(period.starts_at));
    let plan = plan_tier(&org.plan_tier);
    let api_request_overage_mode = api_request_overage_mode(&data, org_id, plan.id);
    let estimated_metadata_bytes = estimated_metadata_bytes(
        projects,
        runs,
        metric_series,
        artifacts + artifact_collections,
        api_keys,
        seats,
    );
    let artifact_bytes_exact = artifact_usage.artifact_bytes_exact
        + versioned_artifact_usage.active_bytes
        + versioned_artifact_usage.pending_delete_bytes;
    let storage_bytes_for_warnings = storage_bytes_for_warnings(
        artifact_bytes_exact,
        estimated_metadata_bytes,
        warehouse_storage_bytes_exact,
        &org.storage_choice,
    );
    let storage_bytes_for_write_gate =
        storage_bytes_for_warnings + versioned_artifact_usage.reserved_upload_bytes;
    Ok(UsageCounts {
        org,
        plan,
        seats,
        projects,
        runs,
        metric_points,
        metric_points_retained_total,
        metric_series,
        artifacts,
        raw_artifacts: artifact_usage.artifacts,
        artifact_collections,
        artifact_versions_active: versioned_artifact_usage.active_versions,
        artifact_versions_pending_delete: versioned_artifact_usage.pending_delete_versions,
        api_keys,
        api_requests,
        artifact_bytes_exact,
        external_artifact_bytes_declared: artifact_usage.external_artifact_bytes_declared,
        artifact_bytes_unknown_count: artifact_usage.artifact_bytes_unknown_count,
        versioned_artifact_bytes_active: versioned_artifact_usage.active_bytes,
        versioned_artifact_bytes_pending_delete: versioned_artifact_usage.pending_delete_bytes,
        versioned_artifact_bytes_reserved: versioned_artifact_usage.reserved_upload_bytes,
        estimated_metadata_bytes,
        warehouse_storage_bytes_exact,
        storage_bytes_for_warnings,
        storage_bytes_for_write_gate,
        estimated_storage_bytes_for_warnings: storage_bytes_for_warnings,
        api_request_overage_mode,
        period,
    })
}

pub async fn usage_export(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    let summary = usage_summary(store, ctx).await?;
    Ok(json!({
        "schema_version": summary["schema_version"],
        "billing_precision": summary["billing_precision"],
        "generated_at": summary["generated_at"],
        "source": "computed_current_state",
        "usage_period": summary["usage_period"],
        "plans": summary["plans"],
        "overage_policy": summary["overage_policy"],
        "organizations": summary["organizations"]
    }))
}

fn usage_org_value(counts: &UsageCounts) -> Value {
    let billable_storage_bytes = billable_storage_bytes(counts);
    let billable_api_requests = billable_api_requests(counts);
    json!({
        "org_id": counts.org.id,
        "org_slug": counts.org.slug,
        "plan_tier": counts.org.plan_tier,
        "plan": counts.plan,
        "usage_period": usage_period_value(&counts.period),
        "usage": {
            "seats": counts.seats,
            "paid_extra_seats": (counts.seats - counts.plan.included_seats as i64).max(0),
            "projects": counts.projects,
            "runs": counts.runs,
            "metric_points": counts.metric_points,
            "metric_points_current_period": counts.metric_points,
            "metric_points_retained_total": counts.metric_points_retained_total,
            "metric_series": counts.metric_series,
            "artifacts": counts.artifacts,
            "raw_artifacts": counts.raw_artifacts,
            "artifact_collections": counts.artifact_collections,
            "artifact_versions_active": counts.artifact_versions_active,
            "artifact_versions_pending_delete": counts.artifact_versions_pending_delete,
            "api_keys": counts.api_keys,
            "api_requests": counts.api_requests,
            "artifact_bytes_exact": counts.artifact_bytes_exact,
            "external_artifact_bytes_declared": counts.external_artifact_bytes_declared,
            "artifact_bytes_unknown": 0,
            "artifact_bytes_unknown_count": counts.artifact_bytes_unknown_count,
            "versioned_artifact_bytes_active": counts.versioned_artifact_bytes_active,
            "versioned_artifact_bytes_pending_delete": counts.versioned_artifact_bytes_pending_delete,
            "versioned_artifact_bytes_reserved": counts.versioned_artifact_bytes_reserved,
            "estimated_metadata_bytes": counts.estimated_metadata_bytes,
            "warehouse_storage_bytes_exact": counts.warehouse_storage_bytes_exact,
            "storage_bytes_for_warnings": counts.storage_bytes_for_warnings,
            "storage_bytes_for_write_gate": counts.storage_bytes_for_write_gate,
            "estimated_storage_bytes_for_warnings": counts.estimated_storage_bytes_for_warnings,
            "billable_storage_bytes": billable_storage_bytes,
            "billable": {
                "storage_bytes": billable_storage_bytes,
                "storage_gib": ceil_div_i64(billable_storage_bytes, GIB_BYTES),
                "api_requests": billable_api_requests,
                "api_request_overage_mode": counts.api_request_overage_mode.as_str(),
                "api_request_overage_cents_decimal": api_request_overage_cents_decimal(
                    billable_api_requests,
                    counts.plan.api_request_overage_cents_per_million
                )
            },
            "billing_precision": "not_billable"
        },
        "limits": {
            "included_seats": counts.plan.included_seats,
            "included_storage_bytes": counts.plan.included_storage_bytes,
            "projects": counts.plan.projects,
            "runs": counts.plan.runs,
            "metric_points": counts.plan.metric_points,
            "api_requests": counts.plan.api_requests
        },
        "rate_limits": {
            "general": {
                "requests_per_second": counts.plan.rate_limit_rps,
                "burst": counts.plan.rate_limit_burst
            },
            "ingest": {
                "requests_per_second": counts.plan.ingest_rate_limit_rps,
                "burst": ingest_rate_limit_burst(counts.plan)
            }
        },
        "warnings": usage_warnings(counts)
    })
}

fn overage_policy() -> Value {
    json!({
        "paid_extra_seats": "tracked_not_billed",
        "seats": "paid_extra_seats",
        "projects": "blocked_at_limit",
        "runs": "blocked_at_limit",
        "storage": "blocked_at_limit",
        "metric_points": "blocked_at_limit",
        "api_requests": "blocked_or_metered_overage",
        "artifacts": "visibility_only",
        "api_keys": "visibility_only"
    })
}

fn plan_catalog() -> Value {
    json!({
        "free": PLAN_FREE,
        "pro": PLAN_PRO,
        "premium": PLAN_PREMIUM
    })
}

fn estimated_metadata_bytes(
    projects: i64,
    runs: i64,
    metric_series: i64,
    artifacts: i64,
    api_keys: i64,
    seats: i64,
) -> i64 {
    projects * PROJECT_METADATA_BYTES
        + runs * RUN_METADATA_BYTES
        + metric_series * METRIC_SERIES_METADATA_BYTES
        + artifacts * ARTIFACT_METADATA_BYTES
        + api_keys * API_KEY_METADATA_BYTES
        + seats * SEAT_METADATA_BYTES
}

fn storage_bytes_for_warnings(
    artifact_bytes_exact: i64,
    estimated_metadata_bytes: i64,
    warehouse_storage_bytes_exact: Option<i64>,
    storage_choice: &str,
) -> i64 {
    if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        return artifact_bytes_exact;
    }
    artifact_bytes_exact + warehouse_storage_bytes_exact.unwrap_or(estimated_metadata_bytes)
}

fn retained_artifact_backend(storage_backend: &str) -> bool {
    matches!(storage_backend, "local" | "r2")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ArtifactUsage {
    artifacts: i64,
    artifact_bytes_exact: i64,
    external_artifact_bytes_declared: i64,
    artifact_bytes_unknown_count: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct VersionedArtifactUsage {
    active_versions: i64,
    pending_delete_versions: i64,
    active_bytes: i64,
    pending_delete_bytes: i64,
    reserved_upload_bytes: i64,
}

fn artifact_usage_counts<'a>(
    artifacts: impl IntoIterator<Item = &'a ArtifactRow>,
) -> ArtifactUsage {
    let mut usage = ArtifactUsage::default();
    for artifact in artifacts {
        usage.artifacts += 1;
        match artifact.size_bytes {
            Some(size_bytes) if retained_artifact_backend(&artifact.storage_backend) => {
                usage.artifact_bytes_exact += size_bytes;
            }
            Some(size_bytes) => {
                usage.external_artifact_bytes_declared += size_bytes;
            }
            None => {
                usage.artifact_bytes_unknown_count += 1;
            }
        }
    }
    usage
}

fn versioned_artifact_usage_counts<'a, 'b>(
    versions: impl IntoIterator<Item = &'a ArtifactVersionRow>,
    upload_sessions: impl IntoIterator<Item = &'b ArtifactUploadSessionRow>,
    now: DateTime<Utc>,
) -> VersionedArtifactUsage {
    let mut usage = VersionedArtifactUsage::default();
    for version in versions {
        if version.deleted_at.is_some() {
            continue;
        }
        if version.state == "active"
            && version.delete_requested_at.is_none()
            && version
                .expires_at
                .map(|expires_at| expires_at > now)
                .unwrap_or(true)
        {
            usage.active_versions += 1;
            usage.active_bytes += version.size_bytes;
        } else if version.state == "soft_deleted" || version.delete_requested_at.is_some() {
            usage.pending_delete_versions += 1;
            usage.pending_delete_bytes += version.size_bytes;
        }
    }
    for session in upload_sessions {
        if matches!(
            session.state.as_str(),
            "uploading" | "completing" | "provider_completed" | "aborting"
        ) {
            usage.reserved_upload_bytes += session.expected_total_bytes;
        }
    }
    usage
}

fn usage_warnings(counts: &UsageCounts) -> Vec<Value> {
    [
        usage_limit_warning(
            "seats",
            counts.seats,
            counts.plan.included_seats as i64,
            "paid_extra_seats",
            false,
        ),
        usage_limit_warning(
            "projects",
            counts.projects,
            counts.plan.projects,
            "blocked_at_limit",
            true,
        ),
        usage_limit_warning(
            "runs",
            counts.runs,
            counts.plan.runs,
            "blocked_at_limit",
            true,
        ),
        usage_limit_warning(
            "metric_points",
            counts.metric_points,
            counts.plan.metric_points,
            "blocked_at_limit",
            true,
        ),
        usage_limit_warning(
            "storage",
            counts
                .storage_bytes_for_write_gate
                .max(counts.storage_bytes_for_warnings),
            counts.plan.included_storage_bytes,
            "blocked_at_limit",
            true,
        ),
        usage_limit_warning(
            "api_requests",
            counts.api_requests,
            counts.plan.api_requests,
            "blocked_or_metered_overage",
            matches!(
                counts.api_request_overage_mode,
                ApiRequestOverageMode::Blocked
            ),
        ),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn usage_limit_warning(
    target: &str,
    value: i64,
    limit: i64,
    policy: &str,
    blocking: bool,
) -> Option<Value> {
    if limit <= 0 {
        return None;
    }
    let ratio = rounded_ratio(value, limit);
    let status = if target == "seats" {
        (value > limit).then_some("paid_extra_seats")
    } else if value >= limit {
        Some("over_limit")
    } else if (value as f64 / limit as f64) >= 0.8 {
        Some("approaching_limit")
    } else {
        None
    }?;
    let code = format!("{target}_{status}");
    Some(json!({
        "target": target,
        "status": status,
        "value": value,
        "limit": limit,
        "ratio": ratio,
        "policy": policy,
        "blocking": blocking,
        "code": code,
        "message": warning_message(target, status, blocking)
    }))
}

fn warning_message(target: &str, status: &str, blocking: bool) -> String {
    let label = target.replace('_', " ");
    match (status, blocking) {
        ("approaching_limit", true) => format!(
            "{label} usage is approaching the plan limit. New writes will be blocked at the limit."
        ),
        ("over_limit", true) => format!(
            "{label} usage is at or above the plan limit. New writes are blocked until usage drops or the plan is upgraded."
        ),
        ("paid_extra_seats", false) => {
            "Seat count is above the included plan seats and is tracked for future billing.".to_string()
        }
        ("approaching_limit", false) => format!(
            "{label} usage is approaching the plan allowance. Paid overage is metered."
        ),
        ("over_limit", false) => format!(
            "{label} usage is above the plan allowance. Paid overage is metered."
        ),
        _ => format!("{label} usage is above the plan limit."),
    }
}

fn billable_storage_bytes(counts: &UsageCounts) -> i64 {
    (counts.storage_bytes_for_warnings - counts.plan.included_storage_bytes).max(0)
}

fn billable_api_requests(counts: &UsageCounts) -> i64 {
    (counts.api_requests - counts.plan.api_requests).max(0)
}

fn api_request_overage_cents_decimal(
    billable_api_requests: i64,
    cents_per_million: Option<i64>,
) -> f64 {
    cents_per_million
        .map(|cents| billable_api_requests as f64 * cents as f64 / 1_000_000.0)
        .unwrap_or(0.0)
}

fn ceil_div_i64(value: i64, divisor: i64) -> i64 {
    if value <= 0 || divisor <= 0 {
        0
    } else {
        (value + divisor - 1) / divisor
    }
}

fn ingest_rate_limit_burst(plan: crate::domain::PlanTier) -> u32 {
    plan.ingest_rate_limit_rps
        .saturating_mul(5)
        .min(plan.rate_limit_burst)
}

impl ApiRequestOverageMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Metered => "metered",
            Self::LegacyCompatibility => "legacy_compatibility",
        }
    }
}

fn api_request_overage_mode(
    data: &StoreData,
    org_id: Uuid,
    plan_tier: &str,
) -> ApiRequestOverageMode {
    if plan_tier == "free" {
        return ApiRequestOverageMode::Blocked;
    }
    let Some(account) = data.billing_accounts.get(&org_id) else {
        return ApiRequestOverageMode::LegacyCompatibility;
    };
    if account.access_state != BILLING_PAID_ACTIVE {
        return ApiRequestOverageMode::Blocked;
    }
    if account.stripe_customer_id.is_some() && account.stripe_subscription_id.is_some() {
        ApiRequestOverageMode::Metered
    } else if account.stripe_customer_id.is_none() && account.stripe_subscription_id.is_none() {
        ApiRequestOverageMode::LegacyCompatibility
    } else {
        ApiRequestOverageMode::Blocked
    }
}

fn rounded_ratio(value: i64, limit: i64) -> f64 {
    ((value as f64 / limit as f64) * 10_000.0).round() / 10_000.0
}

fn current_usage_period(now: DateTime<Utc>) -> UsagePeriod {
    let starts_at = Utc
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .expect("valid UTC month start");
    let (next_year, next_month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    let ends_at = Utc
        .with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0)
        .single()
        .expect("valid UTC next month start");
    UsagePeriod { starts_at, ends_at }
}

fn usage_period_value(period: &UsagePeriod) -> Value {
    json!({
        "kind": "calendar_month",
        "timezone": "UTC",
        "starts_at": period.starts_at,
        "ends_at": period.ends_at,
        "reset_at": period.ends_at
    })
}

fn first_blocking_violation(counts: &UsageCounts, delta: UsageDelta) -> Option<PlanViolation> {
    [
        blocking_violation(
            "projects",
            counts.projects,
            delta.projects,
            counts.plan.projects,
        ),
        blocking_violation("runs", counts.runs, delta.runs, counts.plan.runs),
        blocking_violation(
            "metric_points",
            counts.metric_points,
            delta.metric_points,
            counts.plan.metric_points,
        ),
        blocking_violation(
            "storage",
            counts
                .storage_bytes_for_write_gate
                .max(counts.storage_bytes_for_warnings),
            delta.storage_bytes,
            counts.plan.included_storage_bytes,
        ),
    ]
    .into_iter()
    .flatten()
    .next()
}

fn blocking_violation(
    target: &'static str,
    current: i64,
    delta: i64,
    limit: i64,
) -> Option<PlanViolation> {
    if limit <= 0 {
        return None;
    }
    if current > limit {
        return Some(PlanViolation {
            target,
            reason: "is already above",
        });
    }
    if delta > 0 && current.saturating_add(delta) > limit {
        return Some(PlanViolation {
            target,
            reason: "would exceed",
        });
    }
    None
}

#[derive(Clone)]
struct UsageCounts {
    org: OrganizationRow,
    plan: crate::domain::PlanTier,
    seats: i64,
    projects: i64,
    runs: i64,
    metric_points: i64,
    metric_points_retained_total: i64,
    metric_series: i64,
    artifacts: i64,
    raw_artifacts: i64,
    artifact_collections: i64,
    artifact_versions_active: i64,
    artifact_versions_pending_delete: i64,
    api_keys: i64,
    api_requests: i64,
    artifact_bytes_exact: i64,
    external_artifact_bytes_declared: i64,
    artifact_bytes_unknown_count: i64,
    versioned_artifact_bytes_active: i64,
    versioned_artifact_bytes_pending_delete: i64,
    versioned_artifact_bytes_reserved: i64,
    estimated_metadata_bytes: i64,
    warehouse_storage_bytes_exact: Option<i64>,
    storage_bytes_for_warnings: i64,
    storage_bytes_for_write_gate: i64,
    estimated_storage_bytes_for_warnings: i64,
    api_request_overage_mode: ApiRequestOverageMode,
    period: UsagePeriod,
}

async fn refresh_api_request_rollups_for_period(
    store: &Store,
    org_id: Uuid,
    period: &UsagePeriod,
    metric_store: &MetricStore,
) -> AppResult<()> {
    let period_key = api_request_usage_period_key(period.starts_at);
    let now = Utc::now();
    {
        let data = store.data.lock().await;
        if !data.api_request_rollup_refresh_due(org_id, &period_key, now) {
            return Ok(());
        }
    }
    let prefix = format!("{org_id}:{period_key}:");
    let records = metric_store
        .load_operational_records_by_kind_entity_prefix("api_usage_monthly", org_id, &prefix)
        .await?;
    let mut data = store.data.lock().await;
    for record in records {
        data.apply_record(&record.kind, record.org_id, &record.payload)?;
    }
    data.mark_api_request_rollups_refreshed(org_id, &period_key, now);
    Ok(())
}

struct PlanViolation {
    target: &'static str,
    reason: &'static str,
}

#[derive(Clone)]
struct UsagePeriod {
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
}

pub async fn write_usage_daily_snapshots(store: &Store) -> AppResult<usize> {
    let org_ids = {
        let data = store.data.lock().await;
        data.organizations.keys().copied().collect::<Vec<_>>()
    };
    let mut written = 0;
    for org_id in org_ids {
        let ctx = RequestContext {
            org_id,
            auth: None,
            session: None,
        };
        let snapshot = usage_summary(store, &ctx).await?;
        let mut data = store.data.lock().await;
        store
            .persist_locked(
                "usage_daily",
                org_id,
                &format!("{}-{}", org_id, Utc::now().date_naive()),
                &snapshot,
            )
            .await?;
        data.usage_daily.push(snapshot);
        written += 1;
    }
    Ok(written)
}

pub async fn delete_expired_idempotency(store: &Store) -> AppResult<u64> {
    let mut data = store.data.lock().await;
    let before = data.idempotency.len();
    data.idempotency
        .retain(|_, row| row.expires_at > Utc::now());
    Ok((before - data.idempotency.len()) as u64)
}

pub async fn delete_expired_or_revoked_sessions(store: &Store) -> AppResult<u64> {
    let mut data = store.data.lock().await;
    let before = data.sessions.len();
    let expired = data
        .sessions
        .iter()
        .filter(|(_, session)| {
            session.row.expires_at <= Utc::now() || session.row.revoked_at.is_some()
        })
        .map(|(id, _)| *id)
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(session) = data.sessions.remove(&id) {
            data.sessions_by_hash.remove(&session.token_hash);
        }
    }
    Ok((before - data.sessions.len()) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_warnings_mark_blocking_plan_targets() {
        let mut counts = test_counts("free");
        counts.seats = 3;
        counts.projects = PLAN_FREE.projects;
        counts.runs = (PLAN_FREE.runs as f64 * 0.85) as i64;
        counts.api_requests = (PLAN_FREE.api_requests as f64 * 0.85) as i64;

        let warnings = usage_warnings(&counts);

        let seat = warnings
            .iter()
            .find(|warning| warning["target"] == "seats")
            .expect("seat warning");
        assert_eq!(seat["status"], "paid_extra_seats");
        assert_eq!(seat["blocking"], false);

        let projects = warnings
            .iter()
            .find(|warning| warning["target"] == "projects")
            .expect("project warning");
        assert_eq!(projects["status"], "over_limit");
        assert_eq!(projects["policy"], "blocked_at_limit");
        assert_eq!(projects["blocking"], true);
        assert_eq!(projects["code"], "projects_over_limit");

        let runs = warnings
            .iter()
            .find(|warning| warning["target"] == "runs")
            .expect("run warning");
        assert_eq!(runs["status"], "approaching_limit");
        assert_eq!(runs["blocking"], true);

        let requests = warnings
            .iter()
            .find(|warning| warning["target"] == "api_requests")
            .expect("api request warning");
        assert_eq!(requests["status"], "approaching_limit");
        assert_eq!(requests["policy"], "blocked_or_metered_overage");
        assert_eq!(requests["blocking"], true);
    }

    #[test]
    fn usage_org_value_exposes_billable_requests_and_rate_limits() {
        let mut counts = test_counts("pro");
        counts.api_requests = PLAN_PRO.api_requests + 1_500_000;
        counts.storage_bytes_for_warnings = PLAN_PRO.included_storage_bytes + GIB_BYTES;
        counts.api_request_overage_mode = ApiRequestOverageMode::Metered;

        let value = usage_org_value(&counts);

        assert_eq!(value["usage"]["billable"]["api_requests"], 1_500_000);
        assert_eq!(value["usage"]["billable"]["storage_gib"], 1);
        assert_eq!(
            value["usage"]["billable"]["api_request_overage_mode"],
            "metered"
        );
        assert_eq!(value["rate_limits"]["general"]["requests_per_second"], 50);
        assert_eq!(value["rate_limits"]["ingest"]["burst"], 125);
    }

    #[test]
    fn api_request_overage_mode_requires_paid_or_legacy_entitlement() {
        let org_id = Uuid::new_v4();
        let mut data = StoreData::default();

        assert_eq!(
            api_request_overage_mode(&data, org_id, "pro"),
            ApiRequestOverageMode::LegacyCompatibility
        );

        data.billing_accounts.insert(
            org_id,
            BillingAccountProjection {
                schema_version: 1,
                org_id,
                access_state: BILLING_CHECKOUT_PENDING.to_string(),
                plan_tier: "pro".to_string(),
                effective_plan_tier: "free".to_string(),
                requested_plan_tier: Some("pro".to_string()),
                paid_extra_seats: 0,
                stripe_customer_id: Some("cus_123".to_string()),
                stripe_subscription_id: Some("sub_123".to_string()),
                subscription_status: Some("incomplete".to_string()),
                current_period_start: None,
                current_period_end: None,
                cancel_at_period_end: false,
                grace_until: None,
                pending_intent_id: None,
                message: None,
                updated_at: Utc::now(),
            },
        );
        assert_eq!(
            api_request_overage_mode(&data, org_id, "pro"),
            ApiRequestOverageMode::Blocked
        );

        data.billing_accounts
            .get_mut(&org_id)
            .expect("account")
            .access_state = BILLING_PAID_ACTIVE.to_string();
        assert_eq!(
            api_request_overage_mode(&data, org_id, "pro"),
            ApiRequestOverageMode::Metered
        );
        assert_eq!(
            api_request_overage_mode(&data, org_id, "free"),
            ApiRequestOverageMode::Blocked
        );
    }

    #[test]
    fn blocking_violation_uses_current_and_projected_usage() {
        let mut counts = test_counts("free");
        counts.storage_bytes_for_warnings = PLAN_FREE.included_storage_bytes - 1;
        counts.estimated_storage_bytes_for_warnings = counts.storage_bytes_for_warnings;

        let projected = first_blocking_violation(
            &counts,
            UsageDelta {
                storage_bytes: 2,
                ..UsageDelta::default()
            },
        )
        .expect("projected storage violation");
        assert_eq!(projected.target, "storage");
        assert_eq!(projected.reason, "would exceed");

        counts.metric_points = PLAN_FREE.metric_points + 1;
        let current = first_blocking_violation(&counts, UsageDelta::default())
            .expect("current metric violation");
        assert_eq!(current.target, "metric_points");
        assert_eq!(current.reason, "is already above");
    }

    #[test]
    fn current_usage_period_uses_utc_calendar_month() {
        let period = current_usage_period(
            Utc.with_ymd_and_hms(2026, 5, 17, 12, 30, 0)
                .single()
                .unwrap(),
        );

        assert_eq!(
            period.starts_at,
            Utc.with_ymd_and_hms(2026, 5, 1, 0, 0, 0).single().unwrap()
        );
        assert_eq!(
            period.ends_at,
            Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).single().unwrap()
        );
    }

    #[test]
    fn storage_warning_bytes_use_scoped_warehouse_bytes_or_metadata_estimate() {
        assert_eq!(
            storage_bytes_for_warnings(50, 10, Some(4_600), STORAGE_CHOICE_HOSTED),
            4_650
        );
        assert_eq!(
            storage_bytes_for_warnings(50, 10, None, STORAGE_CHOICE_HOSTED),
            60
        );
        assert_eq!(
            storage_bytes_for_warnings(50, 10, Some(4_600), STORAGE_CHOICE_CUSTOMER_CLICKHOUSE),
            50
        );
        assert_eq!(
            storage_bytes_for_warnings(50, 10, None, STORAGE_CHOICE_CUSTOMER_CLICKHOUSE),
            50
        );
    }

    #[test]
    fn artifact_usage_counts_retained_bytes_separately_from_external_metadata() {
        let mut local_checkpoint = test_artifact("local", Some(15));
        local_checkpoint.kind = "checkpoint".to_string();
        let artifacts = [
            test_artifact("local", Some(10)),
            local_checkpoint,
            test_artifact("r2", Some(20)),
            test_artifact("external", Some(1_000)),
            test_artifact("external", None),
        ];

        let usage = artifact_usage_counts(artifacts.iter());

        assert_eq!(
            usage,
            ArtifactUsage {
                artifacts: 5,
                artifact_bytes_exact: 45,
                external_artifact_bytes_declared: 1_000,
                artifact_bytes_unknown_count: 1,
            }
        );
    }

    #[test]
    fn usage_org_value_reports_unknown_artifact_count() {
        let mut counts = test_counts("free");
        counts.artifacts = 3;
        counts.raw_artifacts = 3;
        counts.artifact_bytes_exact = 42;
        counts.external_artifact_bytes_declared = 128;
        counts.artifact_bytes_unknown_count = 2;

        let value = usage_org_value(&counts);

        assert_eq!(value["usage"]["artifacts"], 3);
        assert_eq!(value["usage"]["artifact_bytes_exact"], 42);
        assert_eq!(value["usage"]["external_artifact_bytes_declared"], 128);
        assert_eq!(value["usage"]["artifact_bytes_unknown_count"], 2);
        assert_eq!(value["usage"]["artifact_bytes_unknown"], 0);
    }

    #[test]
    fn versioned_artifact_usage_counts_active_pending_and_reserved_bytes() {
        let org_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let collection_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let now = Utc::now();
        let active = test_artifact_version(org_id, project_id, collection_id, 12);
        let mut expired = test_artifact_version(org_id, project_id, collection_id, 88);
        expired.expires_at = Some(now - chrono::Duration::minutes(1));
        let mut pending = test_artifact_version(org_id, project_id, collection_id, 20);
        pending.state = "soft_deleted".to_string();
        pending.delete_requested_at = Some(now);
        let mut deleted = test_artifact_version(org_id, project_id, collection_id, 99);
        deleted.deleted_at = Some(now);
        let session = ArtifactUploadSessionRow {
            id: Uuid::new_v4(),
            org_id,
            project_id,
            run_id,
            artifact_version_id: Uuid::new_v4(),
            collection_id,
            state: "uploading".to_string(),
            request_hash: "hash".to_string(),
            expected_total_bytes: 30,
            total_part_count: 1,
            aliases: vec![],
            ttl_days: None,
            source_step: None,
            digest: "digest".to_string(),
            files: vec![],
            manifest_entries: vec![],
            idempotency_response: None,
            expires_at: now + chrono::Duration::minutes(5),
            created_at: now,
            updated_at: now,
        };
        let mut expired_session = session.clone();
        expired_session.id = Uuid::new_v4();
        expired_session.expected_total_bytes = 40;
        expired_session.expires_at = now - chrono::Duration::minutes(1);
        let mut provider_completed_session = expired_session.clone();
        provider_completed_session.id = Uuid::new_v4();
        provider_completed_session.state = "provider_completed".to_string();
        provider_completed_session.expected_total_bytes = 50;

        let usage = versioned_artifact_usage_counts(
            [&active, &expired, &pending, &deleted],
            [&session, &expired_session, &provider_completed_session],
            now,
        );

        assert_eq!(
            usage,
            VersionedArtifactUsage {
                active_versions: 1,
                pending_delete_versions: 1,
                active_bytes: 12,
                pending_delete_bytes: 20,
                reserved_upload_bytes: 120,
            }
        );
    }

    fn test_artifact(storage_backend: &str, size_bytes: Option<i64>) -> ArtifactRow {
        ArtifactRow {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            kind: "file".to_string(),
            name: "artifact.bin".to_string(),
            uri: "instantml://artifacts/internal".to_string(),
            step: None,
            size_bytes,
            sha256: None,
            mime_type: None,
            storage_backend: storage_backend.to_string(),
            storage_key: None,
            storage_path: None,
            metadata: json!({}),
            created_at: Utc::now(),
        }
    }

    fn test_artifact_version(
        org_id: Uuid,
        project_id: Uuid,
        collection_id: Uuid,
        size_bytes: i64,
    ) -> ArtifactVersionRow {
        ArtifactVersionRow {
            id: Uuid::new_v4(),
            org_id,
            project_id,
            collection_id,
            version_index: 0,
            digest: "digest".to_string(),
            source_run_id: None,
            source_step: None,
            file_count: 1,
            size_bytes,
            state: "active".to_string(),
            metadata: json!({}),
            ttl_days: None,
            retention_mode: "inherit".to_string(),
            expires_at: None,
            delete_requested_at: None,
            deleted_at: None,
            audit_reason: None,
            created_at: Utc::now(),
        }
    }

    fn test_counts(tier: &str) -> UsageCounts {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "acme".to_string(),
            name: "Acme".to_string(),
            plan_tier: tier.to_string(),
            account_type: "customer".to_string(),
            tenant_routing_tier: "dedicated".to_string(),
            seat_limit: plan_tier(tier).included_seats,
            created_by_user_id: None,
            created_at: Utc::now(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        UsageCounts {
            org,
            plan: plan_tier(tier),
            seats: 1,
            projects: 1,
            runs: 1,
            metric_points: 1,
            metric_points_retained_total: 1,
            metric_series: 1,
            artifacts: 0,
            raw_artifacts: 0,
            artifact_collections: 0,
            artifact_versions_active: 0,
            artifact_versions_pending_delete: 0,
            api_keys: 0,
            api_requests: 0,
            artifact_bytes_exact: 0,
            external_artifact_bytes_declared: 0,
            artifact_bytes_unknown_count: 0,
            versioned_artifact_bytes_active: 0,
            versioned_artifact_bytes_pending_delete: 0,
            versioned_artifact_bytes_reserved: 0,
            estimated_metadata_bytes: 0,
            warehouse_storage_bytes_exact: None,
            storage_bytes_for_warnings: 0,
            storage_bytes_for_write_gate: 0,
            estimated_storage_bytes_for_warnings: 0,
            api_request_overage_mode: ApiRequestOverageMode::Blocked,
            period: current_usage_period(Utc::now()),
        }
    }
}
