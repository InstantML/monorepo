use super::*;

pub async fn create_project(
    store: &Store,
    ctx: &RequestContext,
    input: CreateProjectRequest,
) -> AppResult<ProjectRow> {
    if let Some(auth) = &ctx.auth {
        if auth.project_id.is_some() {
            return Err(AppError::forbidden(
                "project-scoped API keys cannot create projects",
            ));
        }
    }
    // Omitted / blank project names land in the shared "uncategorized"
    // project (matches W&B's default and the implicit-create path in
    // create_run, so explicit and implicit creates converge on the same
    // bucket).
    let name = match input.name.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => validate_name(Some(value), "project name")?,
        _ => DEFAULT_PROJECT_NAME.to_string(),
    };
    let description = validate_optional_name(input.description.as_deref(), "project description")?;
    {
        let data = store.data.lock().await;
        if let Some(project_id) = data
            .projects_by_org_name
            .get(&(ctx.org_id, name.clone()))
            .copied()
        {
            return data
                .projects
                .get(&project_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("project not found"));
        }
    }
    ensure_billing_write_allowed(store, ctx.org_id, "create a project").await?;
    enforce_plan_capacity(
        store,
        ctx.org_id,
        UsageDelta {
            projects: 1,
            storage_bytes: PROJECT_METADATA_BYTES,
            ..UsageDelta::default()
        },
        "create a project",
    )
    .await?;
    let mut data = store.data.lock().await;
    if let Some(project_id) = data
        .projects_by_org_name
        .get(&(ctx.org_id, name.clone()))
        .copied()
    {
        return data
            .projects
            .get(&project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("project not found"));
    }
    let project = ProjectRow {
        id: Uuid::new_v4(),
        org_id: ctx.org_id,
        name,
        description,
        created_at: Utc::now(),
    };
    store
        .persist_locked("project", ctx.org_id, &project.id.to_string(), &project)
        .await?;
    data.insert_project(project.clone());
    Ok(project)
}

pub async fn list_projects(store: &Store, ctx: &RequestContext) -> AppResult<Vec<ProjectRow>> {
    let data = store.data.lock().await;
    let mut projects = data
        .projects
        .values()
        .filter(|project| project.org_id == ctx.org_id)
        .filter(|project| {
            ctx.auth
                .as_ref()
                .and_then(|auth| auth.project_id)
                .map(|id| id == project.id)
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    projects.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(projects)
}
