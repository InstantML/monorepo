use super::*;

pub async fn usage_summary(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let metric_points = metric_store.count_points_for_org(ctx.org_id).await?;
    let metric_series = metric_store.count_series_for_org(ctx.org_id).await?;
    let data = store.data.lock().await;
    let org = data
        .organizations
        .get(&ctx.org_id)
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let artifact_bytes_exact: i64 = data
        .artifacts
        .values()
        .filter(|artifact| artifact.org_id == ctx.org_id)
        .filter_map(|artifact| artifact.size_bytes)
        .sum();
    let seats = data
        .memberships
        .values()
        .filter(|membership| {
            membership.org_id == ctx.org_id
                && matches!(membership.status.as_str(), "active" | "invited")
        })
        .count() as i64;
    let projects = data
        .projects
        .values()
        .filter(|project| project.org_id == ctx.org_id)
        .count() as i64;
    let runs = data
        .runs
        .values()
        .filter(|run| run.org_id == ctx.org_id)
        .count() as i64;
    let artifacts = data
        .artifacts
        .values()
        .filter(|artifact| artifact.org_id == ctx.org_id)
        .count() as i64;
    let api_keys = data
        .api_keys
        .values()
        .filter(|key| key.row.org_id == ctx.org_id && key.row.revoked_at.is_none())
        .count() as i64;
    let plan = plan_tier(&org.plan_tier);
    let estimated_metadata_bytes = projects * 512
        + runs * 1024
        + metric_series * 256
        + artifacts * 512
        + api_keys * 512
        + seats * 256;
    let estimated_storage_bytes_for_warnings = artifact_bytes_exact + estimated_metadata_bytes;
    let mut warnings = Vec::new();
    if seats > plan.included_seats as i64 {
        warnings.push(json!({
            "code": "seats_over_included",
            "message": "Seat count is above the included plan seats."
        }));
    }
    if estimated_storage_bytes_for_warnings > plan.included_storage_bytes {
        warnings.push(json!({
            "code": "storage_over_included",
            "message": "Tracked storage estimate is above the included plan storage."
        }));
    }
    if metric_points > plan.metric_points {
        warnings.push(json!({
            "code": "metric_points_over_included",
            "message": "Metric point count is above the monthly fair-use plan limit."
        }));
    }
    Ok(json!({
        "schema_version": 1,
        "billing_precision": "not_billable",
        "generated_at": Utc::now(),
        "source": "computed_current_state",
        "plans": plan_catalog(),
        "overage_policy": {
            "paid_extra_seats": "tracked_not_billed",
            "storage": "warning_only",
            "metric_points": "warning_only"
        },
        "organizations": [{
            "org_id": ctx.org_id,
            "org_slug": org.slug,
            "plan_tier": org.plan_tier,
            "plan": plan,
            "usage": {
                "seats": seats,
                "paid_extra_seats": (seats - plan.included_seats as i64).max(0),
                "projects": projects,
                "runs": runs,
                "metric_points": metric_points,
                "metric_series": metric_series,
                "artifacts": artifacts,
                "api_keys": api_keys,
                "artifact_bytes_exact": artifact_bytes_exact,
                "artifact_bytes_unknown": 0,
                "artifact_bytes_unknown_count": 0,
                "estimated_metadata_bytes": estimated_metadata_bytes,
                "estimated_storage_bytes_for_warnings": estimated_storage_bytes_for_warnings,
                "billable_storage_bytes": Value::Null,
                "billing_precision": "not_billable"
            },
            "limits": {
                "included_seats": plan.included_seats,
                "included_storage_bytes": plan.included_storage_bytes,
                "projects": plan.projects,
                "runs": plan.runs,
                "metric_points": plan.metric_points
            },
            "warnings": warnings
        }]
    }))
}

pub async fn usage_export(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    let summary = usage_summary(store, ctx).await?;
    Ok(json!({
        "schema_version": summary["schema_version"],
        "billing_precision": summary["billing_precision"],
        "generated_at": summary["generated_at"],
        "source": "computed_current_state",
        "plans": summary["plans"],
        "overage_policy": summary["overage_policy"],
        "organizations": summary["organizations"]
    }))
}

fn plan_catalog() -> Value {
    json!({
        "free": PLAN_FREE,
        "pro": PLAN_PRO,
        "premium": PLAN_PREMIUM
    })
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
