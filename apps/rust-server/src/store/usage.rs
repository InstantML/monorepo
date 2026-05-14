use super::*;

pub async fn usage_summary(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
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
    let metric_points = store
        .metric_store()
        .count_points_for_org(ctx.org_id)
        .await
        .unwrap_or(0);
    Ok(json!({
        "schema_version": 1,
        "generated_at": Utc::now(),
        "source": "computed_current_state",
        "organizations": [{
            "org_id": ctx.org_id,
            "org_slug": org.slug,
            "plan_tier": org.plan_tier,
            "usage": {
                "seats": data.memberships.values().filter(|m| m.org_id == ctx.org_id).count(),
                "projects": data.projects.values().filter(|p| p.org_id == ctx.org_id).count(),
                "runs": data.runs.values().filter(|r| r.org_id == ctx.org_id).count(),
                "metric_points": metric_points,
                "metric_series": store.metric_store().count_series_for_org(ctx.org_id).await.unwrap_or(0),
                "artifacts": data.artifacts.values().filter(|a| a.org_id == ctx.org_id).count(),
                "artifact_bytes_exact": artifact_bytes_exact,
                "artifact_bytes_unknown": 0
            }
        }]
    }))
}

pub async fn usage_export(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    let summary = usage_summary(store, ctx).await?;
    Ok(json!({
        "schema_version": summary["schema_version"],
        "generated_at": summary["generated_at"],
        "source": "computed_current_state",
        "organizations": summary["organizations"]
    }))
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
