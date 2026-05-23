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

pub async fn usage_summary(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    usage_summary_for_org(store, ctx.org_id).await
}

pub async fn storage_overage_usage_for_org(
    store: &Store,
    org_id: Uuid,
) -> AppResult<StorageOverageUsage> {
    let counts = usage_counts_for_org(store, org_id).await?;
    let billable_storage_bytes =
        (counts.storage_bytes_for_warnings - counts.plan.included_storage_bytes).max(0);
    let reported_gib = if billable_storage_bytes == 0 {
        0
    } else {
        (billable_storage_bytes + GIB_BYTES - 1) / GIB_BYTES
    };
    Ok(StorageOverageUsage {
        period_start: counts.period.starts_at,
        period_end: counts.period.ends_at,
        storage_bytes_for_warnings: counts.storage_bytes_for_warnings,
        billable_storage_bytes,
        reported_gib,
    })
}

pub async fn enforce_plan_capacity(
    store: &Store,
    org_id: Uuid,
    delta: UsageDelta,
    action: &str,
) -> AppResult<()> {
    let counts = usage_counts_for_org(store, org_id).await?;
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
    let counts = usage_counts_for_org(store, org_id).await?;
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

async fn usage_counts_for_org(store: &Store, org_id: Uuid) -> AppResult<UsageCounts> {
    let period = current_usage_period(Utc::now());
    let metric_store = store.metric_store_for_org(org_id).await?;
    let metric_points_retained_total = metric_store.count_points_for_org(org_id).await?;
    let metric_points = metric_store
        .count_points_for_org_period(org_id, period.starts_at, period.ends_at)
        .await?;
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
    let artifacts = artifact_usage.artifacts;
    let api_keys = data
        .api_keys
        .values()
        .filter(|key| key.row.org_id == org_id && key.row.revoked_at.is_none())
        .count() as i64;
    let plan = plan_tier(&org.plan_tier);
    let estimated_metadata_bytes =
        estimated_metadata_bytes(projects, runs, metric_series, artifacts, api_keys, seats);
    let storage_bytes_for_warnings = storage_bytes_for_warnings(
        artifact_usage.artifact_bytes_exact,
        estimated_metadata_bytes,
        warehouse_storage_bytes_exact,
        &org.storage_choice,
    );
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
        api_keys,
        artifact_bytes_exact: artifact_usage.artifact_bytes_exact,
        external_artifact_bytes_declared: artifact_usage.external_artifact_bytes_declared,
        artifact_bytes_unknown_count: artifact_usage.artifact_bytes_unknown_count,
        estimated_metadata_bytes,
        warehouse_storage_bytes_exact,
        storage_bytes_for_warnings,
        estimated_storage_bytes_for_warnings: storage_bytes_for_warnings,
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
            "api_keys": counts.api_keys,
            "artifact_bytes_exact": counts.artifact_bytes_exact,
            "external_artifact_bytes_declared": counts.external_artifact_bytes_declared,
            "artifact_bytes_unknown": 0,
            "artifact_bytes_unknown_count": counts.artifact_bytes_unknown_count,
            "estimated_metadata_bytes": counts.estimated_metadata_bytes,
            "warehouse_storage_bytes_exact": counts.warehouse_storage_bytes_exact,
            "storage_bytes_for_warnings": counts.storage_bytes_for_warnings,
            "estimated_storage_bytes_for_warnings": counts.estimated_storage_bytes_for_warnings,
            "billable_storage_bytes": Value::Null,
            "billing_precision": "not_billable"
        },
        "limits": {
            "included_seats": counts.plan.included_seats,
            "included_storage_bytes": counts.plan.included_storage_bytes,
            "projects": counts.plan.projects,
            "runs": counts.plan.runs,
            "metric_points": counts.plan.metric_points
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
            counts.storage_bytes_for_warnings,
            counts.plan.included_storage_bytes,
            "blocked_at_limit",
            true,
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
        _ => format!("{label} usage is above the plan limit."),
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
            counts.storage_bytes_for_warnings,
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
    api_keys: i64,
    artifact_bytes_exact: i64,
    external_artifact_bytes_declared: i64,
    artifact_bytes_unknown_count: i64,
    estimated_metadata_bytes: i64,
    warehouse_storage_bytes_exact: Option<i64>,
    storage_bytes_for_warnings: i64,
    estimated_storage_bytes_for_warnings: i64,
    period: UsagePeriod,
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
            api_keys: 0,
            artifact_bytes_exact: 0,
            external_artifact_bytes_declared: 0,
            artifact_bytes_unknown_count: 0,
            estimated_metadata_bytes: 0,
            warehouse_storage_bytes_exact: None,
            storage_bytes_for_warnings: 0,
            estimated_storage_bytes_for_warnings: 0,
            period: current_usage_period(Utc::now()),
        }
    }
}
