use super::*;

pub(super) async fn ensure_project_locked(
    store: &Store,
    data: &mut StoreData,
    org_id: Uuid,
    name: &str,
) -> AppResult<ProjectRow> {
    if let Some(id) = data
        .projects_by_org_name
        .get(&(org_id, name.to_string()))
        .copied()
    {
        return data
            .projects
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::not_found("project not found"));
    }
    let project = ProjectRow {
        id: Uuid::new_v4(),
        org_id,
        name: name.to_string(),
        description: None,
        created_at: Utc::now(),
    };
    store
        .persist_locked("project", org_id, &project.id.to_string(), &project)
        .await?;
    data.insert_project(project.clone());
    Ok(project)
}

pub(super) async fn ensure_import_project_access(
    store: &Store,
    ctx: &RequestContext,
    project_name: &str,
) -> AppResult<()> {
    let Some(project_id) = ctx.auth.as_ref().and_then(|auth| auth.project_id) else {
        return Ok(());
    };
    let data = store.data.lock().await;
    let project = data
        .projects
        .get(&project_id)
        .filter(|project| project.org_id == ctx.org_id)
        .ok_or_else(|| AppError::forbidden("project-scoped API key project not found"))?;
    if project.name != project_name {
        return Err(AppError::forbidden(
            "project-scoped API keys cannot import into another project",
        ));
    }
    Ok(())
}

pub(super) fn fetch_run_in_data(
    data: &StoreData,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<RunRow> {
    let run = data
        .runs
        .get(&run_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("run not found"))?;
    if !is_readable_run(data, &run) {
        return Err(AppError::not_found("run not found"));
    }
    ensure_run_access_in_data(ctx, &run)?;
    Ok(run)
}

// Borrow-only visibility + access check for callers that don't need the run
// itself. fetch_run_in_data clones the whole RunRow — including its config and
// metadata JSON values — which is pure allocation churn in loops like the
// 2,000-run metric-series access check.
pub(super) fn ensure_run_visible_in_data(
    data: &StoreData,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<()> {
    let run = data
        .runs
        .get(&run_id)
        .ok_or_else(|| AppError::not_found("run not found"))?;
    if !is_visible_run(data, run) {
        return Err(AppError::not_found("run not found"));
    }
    ensure_run_access_in_data(ctx, run)
}

pub(super) fn ensure_run_access_in_data(ctx: &RequestContext, run: &RunRow) -> AppResult<()> {
    if run.org_id != ctx.org_id {
        return Err(AppError::forbidden(
            "run belongs to a different organization",
        ));
    }
    if ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .map(|id| id != run.project_id)
        .unwrap_or(false)
    {
        return Err(AppError::forbidden("run belongs to a different project"));
    }
    Ok(())
}

pub(super) fn ensure_unrestricted_org_key(ctx: &RequestContext) -> AppResult<()> {
    if ctx.auth.as_ref().and_then(|auth| auth.project_id).is_some() {
        return Err(AppError::forbidden("route requires an org-scoped API key"));
    }
    Ok(())
}

pub(super) fn require_admin_in_data(
    data: &StoreData,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<MembershipRow> {
    data.memberships
        .values()
        .find(|membership| {
            membership.org_id == org_id
                && membership.user_id == user_id
                && membership.status == "active"
                && matches!(membership.role.as_str(), "owner" | "admin")
        })
        .cloned()
        .ok_or_else(|| AppError::forbidden("organization admin role required"))
}

pub(super) fn session_payload_from_data(
    data: &StoreData,
    session: UserSessionRow,
) -> AppResult<AuthSessionPayload> {
    let user = data
        .users
        .get(&session.user_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("user not found"))?;
    let organization = data
        .organizations
        .get(&session.org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let membership = data
        .memberships
        .values()
        .find(|membership| {
            membership.org_id == session.org_id
                && membership.user_id == session.user_id
                && membership.status == "active"
        })
        .cloned()
        .ok_or_else(|| AppError::unauthorized("active membership required"))?;
    let memberships = data
        .memberships
        .values()
        .filter(|membership| membership.user_id == session.user_id && membership.status == "active")
        .cloned()
        .collect::<Vec<_>>();
    let provisioning =
        data.tenant_routes
            .get(&session.org_id)
            .map(|route| ProvisioningStatusPayload {
                status: route.status.clone(),
                mode: route.provisioner.clone(),
                service_id: route.service_id.clone(),
            });
    Ok(AuthSessionPayload {
        authenticated: true,
        session,
        user,
        account_type: organization.account_type.clone(),
        organization,
        membership,
        memberships,
        provisioning,
        billing_checkout: None,
    })
}

pub(super) fn membership_row(
    org_id: Uuid,
    user_id: Uuid,
    role: &str,
    status: &str,
) -> MembershipRow {
    MembershipRow {
        id: Uuid::new_v4(),
        org_id,
        user_id,
        role: role.to_string(),
        status: status.to_string(),
        created_at: Utc::now(),
    }
}

pub(super) fn new_session(user_id: Uuid, org_id: Uuid) -> (SessionRecord, String) {
    let token = generate_session_token();
    let row = UserSessionRow {
        id: Uuid::new_v4(),
        user_id,
        org_id,
        metadata: json!({}),
        created_at: Utc::now(),
        last_seen_at: Some(Utc::now()),
        expires_at: Utc::now() + ChronoDuration::days(SESSION_TTL_DAYS),
        revoked_at: None,
    };
    (
        SessionRecord {
            row,
            token_hash: hash_secret(&token),
        },
        token,
    )
}
