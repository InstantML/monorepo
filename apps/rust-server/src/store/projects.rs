use super::*;

pub async fn create_project(
    pool: &PgPool,
    ctx: &RequestContext,
    input: CreateProjectRequest,
) -> AppResult<ProjectRow> {
    if let Some(project_id) = ctx.auth.as_ref().and_then(|auth| auth.project_id) {
        let name = validate_name(input.name.as_deref(), "project name")?;
        let project = fetch_project_by_id(pool, ctx.org_id, project_id).await?;
        if project.name != name {
            return Err(AppError::forbidden(
                "api key is restricted to a different project",
            ));
        }
        return Ok(project);
    }
    create_project_inner(pool, ctx.org_id, input).await
}

pub(super) async fn create_project_inner(
    pool: &PgPool,
    org_id: Uuid,
    input: CreateProjectRequest,
) -> AppResult<ProjectRow> {
    let name = validate_name(input.name.as_deref(), "project name")?;
    let description = validate_optional_name(input.description.as_deref(), "description")?;
    let mut tx = pool.begin().await?;
    let project = create_project_inner_tx(&mut tx, org_id, &name, description.as_deref()).await?;
    tx.commit().await?;
    Ok(project)
}

pub(super) async fn create_project_inner_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    name: &str,
    description: Option<&str>,
) -> AppResult<ProjectRow> {
    let name = validate_name(Some(name), "project name")?;
    let description = validate_optional_name(description, "description")?;
    sqlx::query_as::<_, ProjectRow>(
        r#"
        insert into projects (org_id, name, description)
        values ($1, $2, $3)
        on conflict (org_id, name) do update set name = projects.name
        returning id, org_id, name, description, created_at
        "#,
    )
    .bind(org_id)
    .bind(name)
    .bind(description)
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
}

pub(super) async fn fetch_project_by_id(
    pool: &PgPool,
    org_id: Uuid,
    project_id: Uuid,
) -> AppResult<ProjectRow> {
    sqlx::query_as::<_, ProjectRow>(
        "select id, org_id, name, description, created_at from projects where org_id = $1 and id = $2",
    )
    .bind(org_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::not_found("project not found"))
}

pub async fn list_projects(pool: &PgPool, ctx: &RequestContext) -> AppResult<Vec<ProjectRow>> {
    sqlx::query_as::<_, ProjectRow>(
        "select id, org_id, name, description, created_at from projects where org_id = $1 and ($2::uuid is null or id = $2) order by name",
    )
    .bind(ctx.org_id)
    .bind(ctx.auth.as_ref().and_then(|auth| auth.project_id))
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}
