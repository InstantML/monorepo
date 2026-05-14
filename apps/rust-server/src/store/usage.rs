use super::*;

pub async fn write_usage_daily_snapshots(
    pool: &PgPool,
    metric_store: &MetricStore,
) -> AppResult<u64> {
    let period_start = Utc::now().date_naive();
    let org_ids = sqlx::query_scalar::<_, Uuid>("select id from organizations order by id")
        .fetch_all(pool)
        .await?;
    let mut inserted = 0_u64;
    for org_id in org_ids {
        if write_usage_daily_snapshot(pool, metric_store, org_id, period_start).await? {
            inserted += 1;
        }
    }
    Ok(inserted)
}

pub async fn write_usage_daily_snapshot(
    pool: &PgPool,
    metric_store: &MetricStore,
    org_id: Uuid,
    period_start: NaiveDate,
) -> AppResult<bool> {
    let org = sqlx::query_as::<_, OrganizationRow>(
        "select id, slug::text as slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at from organizations where id = $1",
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?;
    let usage = usage_for_org(pool, metric_store, org.id, &org.plan_tier).await?;
    let period_end = period_start + ChronoDuration::days(1);
    let inserted = sqlx::query_scalar::<_, Uuid>(
        r#"
        insert into usage_daily (
          org_id, period_start, period_end, rollup_kind, schema_version, plan_tier,
          seat_count, project_count, run_count, metric_point_count, metric_series_count,
          artifact_count, api_key_count, artifact_bytes_exact, artifact_bytes_unknown_count,
          estimated_metadata_bytes, estimated_storage_bytes_for_warnings
        )
        values ($1, $2, $3, 'daily_snapshot', 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        on conflict do nothing
        returning id
        "#,
    )
    .bind(org.id)
    .bind(period_start)
    .bind(period_end)
    .bind(&org.plan_tier)
    .bind(usage_i64(&usage, "seats")?)
    .bind(usage_i64(&usage, "projects")?)
    .bind(usage_i64(&usage, "runs")?)
    .bind(usage_i64(&usage, "metric_points")?)
    .bind(usage_i64(&usage, "metric_series")?)
    .bind(usage_i64(&usage, "artifacts")?)
    .bind(usage_i64(&usage, "api_keys")?)
    .bind(usage_i64(&usage, "artifact_bytes_exact")?)
    .bind(usage_i64(&usage, "artifact_bytes_unknown_count")?)
    .bind(usage_i64(&usage, "estimated_metadata_bytes")?)
    .bind(usage_i64(&usage, "estimated_storage_bytes_for_warnings")?)
    .fetch_optional(pool)
    .await?;
    Ok(inserted.is_some())
}

pub async fn usage_summary(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    let org = sqlx::query_as::<_, OrganizationRow>(
        "select id, slug::text as slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at from organizations where id = $1",
    )
    .bind(ctx.org_id)
    .fetch_one(pool)
    .await?;
    let usage = usage_for_org(pool, metric_store, org.id, &org.plan_tier).await?;
    let plans = public_plan_tiers();
    let limits = plans
        .get(&org.plan_tier)
        .cloned()
        .unwrap_or_else(|| plans["free"].clone());
    let warnings = usage_warnings(&usage, &limits);
    Ok(json!({
        "schema_version": 1,
        "generated_at": Utc::now(),
        "billing_precision": "not_billable",
        "units": { "bytes": "bytes", "metric_points": "rows" },
        "plans": plans,
        "overage_policy": usage_overage_policy(),
        "organizations": [{
            "org_id": org.id,
            "org_slug": org.slug,
            "org_name": org.name,
            "plan_tier": org.plan_tier,
            "tier_source": "organization",
            "authoritative_for_plan": true,
            "usage": usage,
            "limits": limits,
            "warnings": warnings
        }]
    }))
}

pub async fn usage_export(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    let summary = usage_summary(pool, metric_store, ctx).await?;
    Ok(json!({
        "schema_version": summary["schema_version"],
        "exported_at": Utc::now(),
        "generated_at": summary["generated_at"],
        "format": "json",
        "units": summary["units"],
        "source": "computed_current_state",
        "billing_precision": summary["billing_precision"],
        "plans": summary["plans"],
        "overage_policy": summary["overage_policy"],
        "organizations": summary["organizations"],
        "notes": [
            "Computed from the current Rust/Postgres state.",
            "Artifact bytes are exact only when size_bytes is present.",
            "This export is for billing/debug planning and is not invoice truth."
        ]
    }))
}

async fn usage_for_org(
    pool: &PgPool,
    metric_store: &MetricStore,
    org_id: Uuid,
    plan_tier: &str,
) -> AppResult<Value> {
    let seats: i64 = sqlx::query_scalar("select count(*) from memberships where org_id = $1")
        .bind(org_id)
        .fetch_one(pool)
        .await?;
    let projects: i64 = sqlx::query_scalar("select count(*) from projects where org_id = $1")
        .bind(org_id)
        .fetch_one(pool)
        .await?;
    let runs: i64 = sqlx::query_scalar("select count(*) from runs where org_id = $1")
        .bind(org_id)
        .fetch_one(pool)
        .await?;
    let metric_points: i64 = metric_store.count_points_for_org(org_id).await?;
    let metric_series: i64 = metric_store.count_series_for_org(org_id).await?;
    let artifacts: i64 = sqlx::query_scalar("select count(*) from artifacts where org_id = $1")
        .bind(org_id)
        .fetch_one(pool)
        .await?;
    let artifact_bytes_exact: i64 = sqlx::query_scalar("select coalesce(sum(size_bytes), 0)::bigint from artifacts where org_id = $1 and size_bytes is not null")
        .bind(org_id)
        .fetch_one(pool)
        .await?;
    let artifact_bytes_unknown_count: i64 = sqlx::query_scalar(
        "select count(*) from artifacts where org_id = $1 and size_bytes is null",
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?;
    let api_keys: i64 = sqlx::query_scalar(
        r#"
        select count(*)
        from api_keys k
        join service_accounts sa on sa.org_id = k.org_id and sa.id = k.service_account_id
        where k.org_id = $1
          and k.revoked_at is null
          and (k.expires_at is null or k.expires_at > now())
          and sa.disabled_at is null
        "#,
    )
    .bind(org_id)
    .fetch_one(pool)
    .await?;
    let plan_tier = validate_plan_tier(Some(plan_tier))?;
    let included_seats = public_plan_tiers()
        .get(&plan_tier)
        .and_then(|tier| tier.get("included_seats"))
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let seats = seats.max(1);
    Ok(json!({
        "seats": seats,
        "paid_extra_seats": (seats - included_seats).max(0),
        "projects": projects,
        "runs": runs,
        "metric_points": metric_points,
        "metric_series": metric_series,
        "artifacts": artifacts,
        "api_keys": api_keys,
        "artifact_bytes_exact": artifact_bytes_exact,
        "artifact_bytes_unknown_count": artifact_bytes_unknown_count,
        "estimated_metadata_bytes": 0,
        "estimated_storage_bytes_for_warnings": artifact_bytes_exact,
        "billable_storage_bytes": null,
        "billing_precision": "not_billable"
    }))
}

fn usage_i64(usage: &Value, field: &str) -> AppResult<i64> {
    usage
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::internal(format!("usage field {field} is missing")))
}

fn usage_warnings(usage: &Value, limits: &Value) -> Value {
    let warnings = [
        usage_limit_warning(
            "seats",
            usage.get("seats").and_then(Value::as_f64).unwrap_or(0.0),
            limits
                .get("included_seats")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            "paid_extra_seats",
        ),
        usage_limit_warning(
            "projects",
            usage.get("projects").and_then(Value::as_f64).unwrap_or(0.0),
            limits
                .get("projects")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            "soft_warning_then_upgrade_prompt",
        ),
        usage_limit_warning(
            "runs",
            usage.get("runs").and_then(Value::as_f64).unwrap_or(0.0),
            limits.get("runs").and_then(Value::as_f64).unwrap_or(0.0),
            "soft_warning_then_upgrade_prompt",
        ),
        usage_limit_warning(
            "metric_points",
            usage
                .get("metric_points")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            limits
                .get("metric_points")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            "fair_use_warning",
        ),
        usage_limit_warning(
            "storage",
            usage
                .get("estimated_storage_bytes_for_warnings")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            limits
                .get("included_storage_bytes")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            "soft_warning_then_upgrade_prompt",
        ),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    json!(warnings)
}

fn usage_limit_warning(target: &str, value: f64, limit: f64, policy: &str) -> Option<Value> {
    if !limit.is_finite() || limit <= 0.0 {
        return None;
    }
    let ratio = value / limit;
    if target == "seats" {
        if value <= limit {
            return None;
        }
        return Some(json!({
            "target": target,
            "status": "paid_extra_seats",
            "value": value as i64,
            "limit": limit as i64,
            "ratio": round4(ratio),
            "policy": policy
        }));
    }
    let status = if ratio >= 1.0 {
        "over_limit"
    } else if ratio >= 0.8 {
        "approaching_limit"
    } else {
        return None;
    };
    Some(json!({
        "target": target,
        "status": status,
        "value": value as i64,
        "limit": limit as i64,
        "ratio": round4(ratio),
        "policy": policy
    }))
}

fn public_plan_tiers() -> Map<String, Value> {
    let gib = 1024_i64 * 1024 * 1024;
    Map::from_iter([
        (
            "free".to_string(),
            json!({ "id": "free", "label": "Free", "included_seats": 1, "included_storage_bytes": 5 * gib, "projects": 2, "runs": 100, "metric_points": 1_000_000 }),
        ),
        (
            "lab".to_string(),
            json!({ "id": "lab", "label": "Lab", "included_seats": 3, "included_storage_bytes": 100 * gib, "projects": 25, "runs": 10_000, "metric_points": 25_000_000 }),
        ),
        (
            "startup".to_string(),
            json!({ "id": "startup", "label": "Startup", "included_seats": 10, "included_storage_bytes": 500 * gib, "projects": 100, "runs": 100_000, "metric_points": 200_000_000 }),
        ),
        (
            "growth".to_string(),
            json!({ "id": "growth", "label": "Growth", "included_seats": 25, "included_storage_bytes": 2 * 1024 * gib, "projects": 500, "runs": 1_000_000, "metric_points": 1_000_000_000 }),
        ),
    ])
}

fn usage_overage_policy() -> Value {
    json!({
        "seats": "paid_extra_seats",
        "projects": "soft_warning_then_upgrade_prompt",
        "runs": "soft_warning_then_upgrade_prompt",
        "metric_points": "fair_use_warning",
        "storage": "soft_warning_then_upgrade_prompt",
        "artifacts": "visibility_only",
        "api_keys": "visibility_only"
    })
}
