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
    // Omitted / blank project names land in the shared "default" project
    // so explicit and implicit creates (the latter via create_run)
    // converge on the same bucket.
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
    Ok(visible_projects_in_data(&data, ctx))
}

fn visible_projects_in_data(data: &StoreData, ctx: &RequestContext) -> Vec<ProjectRow> {
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
    projects
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: u128, org_id: Uuid, name: &str) -> ProjectRow {
        ProjectRow {
            id: Uuid::from_u128(id),
            org_id,
            name: name.to_string(),
            description: None,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn browser_session_lists_every_project_in_active_workspace() {
        let org_id = Uuid::from_u128(1);
        let other_org_id = Uuid::from_u128(2);
        let mut data = StoreData::default();
        data.insert_project(project(10, org_id, "beta"));
        data.insert_project(project(11, org_id, "alpha"));
        data.insert_project(project(12, other_org_id, "other-org"));
        let ctx = RequestContext {
            org_id,
            auth: None,
            session: Some(SessionContext {
                session_id: Uuid::from_u128(20),
                user_id: Uuid::from_u128(21),
                role: "viewer".to_string(),
                demo_read_only: false,
            }),
        };

        let names = visible_projects_in_data(&data, &ctx)
            .into_iter()
            .map(|project| project.name)
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["alpha", "beta"]);
    }

    #[test]
    fn project_scoped_api_key_lists_only_its_project() {
        let org_id = Uuid::from_u128(1);
        let project_id = Uuid::from_u128(10);
        let mut data = StoreData::default();
        data.insert_project(project(10, org_id, "alpha"));
        data.insert_project(project(11, org_id, "beta"));
        let ctx = RequestContext {
            org_id,
            auth: Some(AuthContext {
                org_id,
                api_key_id: Uuid::from_u128(20),
                service_account_id: Uuid::from_u128(21),
                project_id: Some(project_id),
                scopes: vec!["export:read".to_string()],
            }),
            session: None,
        };

        let names = visible_projects_in_data(&data, &ctx)
            .into_iter()
            .map(|project| project.name)
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["alpha"]);
    }
}
