use super::*;

pub async fn create_user(pool: &PgPool, input: CreateUserRequest) -> AppResult<UserRow> {
    let email = validate_email(input.email.as_deref().or(input.primary_email.as_deref()))?;
    let display_name = validate_optional_name(input.display_name.as_deref(), "display_name")?;
    let avatar_url = validate_optional_name(input.avatar_url.as_deref(), "avatar_url")?;
    let mut tx = pool.begin().await?;
    let user = sqlx::query_as::<_, UserRow>(
        r#"
        insert into users (primary_email, display_name, avatar_url, last_seen_at)
        values ($1, $2, $3, now())
        on conflict (primary_email) do update set last_seen_at = now()
        returning id, primary_email::text as primary_email, display_name, avatar_url, created_at, last_seen_at
        "#,
    )
    .bind(&email)
    .bind(display_name)
    .bind(avatar_url)
    .fetch_one(&mut *tx)
    .await?;
    if let (Some(provider), Some(provider_subject)) = (input.provider, input.provider_subject) {
        let provider = validate_name(Some(&provider), "provider")?;
        let provider_subject = validate_name(Some(&provider_subject), "provider_subject")?;
        sqlx::query(
            r#"
            insert into user_identities (user_id, provider, provider_subject, email, email_verified)
            values ($1, $2, $3, $4, $5)
            on conflict (provider, provider_subject) do nothing
            "#,
        )
        .bind(user.id)
        .bind(provider)
        .bind(provider_subject)
        .bind(&email)
        .bind(input.email_verified.unwrap_or(true))
        .execute(&mut *tx)
        .await?;
    }
    audit_tx(
        &mut tx,
        None,
        "user.created",
        json!({ "user_id": user.id, "email": user.primary_email }),
    )
    .await?;
    tx.commit().await?;
    Ok(user)
}

pub async fn list_users(pool: &PgPool) -> AppResult<Vec<UserRow>> {
    sqlx::query_as::<_, UserRow>(
        "select id, primary_email::text as primary_email, display_name, avatar_url, created_at, last_seen_at from users order by primary_email",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn create_organization(
    pool: &PgPool,
    input: CreateOrganizationRequest,
) -> AppResult<OrganizationRow> {
    let slug_source = input.slug.as_deref().or(input.name.as_deref());
    let slug = validate_slug(slug_source, "organization slug")?;
    let name = validate_name(input.name.as_deref().or(Some(&slug)), "organization name")?;
    let plan_tier = validate_plan_tier(input.plan_tier.as_deref())?;
    let mut tx = pool.begin().await?;
    let organization = sqlx::query_as::<_, OrganizationRow>(
        r#"
        insert into organizations (slug, name, plan_tier, created_by_user_id)
        values ($1, $2, $3, $4)
        on conflict (slug) do update set slug = organizations.slug
        returning id, slug::text as slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at
        "#,
    )
    .bind(&slug)
    .bind(&name)
    .bind(&plan_tier)
    .bind(input.owner_user_id)
    .fetch_one(&mut *tx)
    .await?;
    if let Some(owner_user_id) = input.owner_user_id {
        sqlx::query(
            r#"
            insert into memberships (org_id, user_id, role)
            values ($1, $2, 'owner')
            on conflict (org_id, user_id) do nothing
            "#,
        )
        .bind(organization.id)
        .bind(owner_user_id)
        .execute(&mut *tx)
        .await?;
    }
    audit_tx(
        &mut tx,
        Some(organization.id),
        "organization.created",
        json!({ "slug": slug }),
    )
    .await?;
    tx.commit().await?;
    Ok(organization)
}

pub async fn list_organizations(pool: &PgPool) -> AppResult<Vec<OrganizationRow>> {
    sqlx::query_as::<_, OrganizationRow>(
        "select id, slug::text as slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at from organizations order by slug",
    )
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn create_api_key(
    pool: &PgPool,
    org_id: Uuid,
    input: CreateApiKeyRequest,
) -> AppResult<Value> {
    let name = validate_name(
        input.name.as_deref().or(Some("SDK API key")),
        "api key name",
    )?;
    let scopes = validate_scopes(input.scopes.unwrap_or_else(|| {
        DEFAULT_API_KEY_SCOPES
            .iter()
            .map(|scope| (*scope).to_string())
            .collect()
    }))?;
    let expires_at = input
        .expires_at
        .as_deref()
        .map(|value| validate_timestamp(Some(value)))
        .transpose()?;
    let secret = generate_api_key();
    let key_hash = hash_secret(&secret);
    let key_prefix = secret.chars().take(14).collect::<String>();
    let mut tx = pool.begin().await?;
    let project_id =
        resolve_api_key_project_tx(&mut tx, org_id, input.project_id, input.project.as_deref())
            .await?;
    let service_account = sqlx::query_as::<_, ServiceAccountRow>(
        r#"
        insert into service_accounts (org_id, name, created_by_user_id)
        values ($1, $2, $3)
        returning id, org_id, name, created_by_user_id, created_at, disabled_at
        "#,
    )
    .bind(org_id)
    .bind(&name)
    .bind(input.created_by_user_id)
    .fetch_one(&mut *tx)
    .await?;
    let key = sqlx::query_as::<_, PublicApiKeyRow>(
        r#"
        insert into api_keys (org_id, service_account_id, name, key_prefix, key_hash, scopes, project_id, expires_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning id, org_id, service_account_id, name, key_prefix, scopes, project_id, created_at, expires_at, last_used_at, revoked_at
        "#,
    )
    .bind(org_id)
    .bind(service_account.id)
    .bind(&name)
    .bind(&key_prefix)
    .bind(key_hash)
    .bind(&scopes)
    .bind(project_id)
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await?;
    audit_tx(
        &mut tx,
        Some(org_id),
        "api_key.created",
        json!({ "api_key_id": key.id, "name": name, "project_id": key.project_id }),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({ "api_key": secret, "key": key, "service_account": service_account }))
}

pub async fn list_api_keys(pool: &PgPool, org_id: Uuid) -> AppResult<Vec<PublicApiKeyRow>> {
    sqlx::query_as::<_, PublicApiKeyRow>(
        r#"
        select id, org_id, service_account_id, name, key_prefix, scopes, project_id, created_at, expires_at, last_used_at, revoked_at
        from api_keys
        where org_id = $1
        order by created_at desc
        "#,
    )
    .bind(org_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn create_api_key_for_user(
    pool: &PgPool,
    actor_user_id: Uuid,
    org_id: Uuid,
    mut input: CreateApiKeyRequest,
) -> AppResult<Value> {
    require_org_admin(pool, actor_user_id, org_id).await?;
    input.created_by_user_id = Some(actor_user_id);
    if input.scopes.is_none() {
        input.scopes = Some(
            ONBOARDING_API_KEY_SCOPES
                .iter()
                .map(|scope| (*scope).to_string())
                .collect(),
        );
    }
    let mut response = create_api_key(pool, org_id, input).await?;
    if let Some(object) = response.as_object_mut() {
        object.insert("actor_user_id".to_string(), json!(actor_user_id));
    }
    Ok(response)
}

pub async fn create_dev_google_session(
    pool: &PgPool,
    input: DevGoogleAuthRequest,
) -> AppResult<CreatedAuthSession> {
    let email = validate_email(input.email.as_deref())?;
    let display_name = validate_optional_name(input.display_name.as_deref(), "display_name")?
        .or_else(|| email.split('@').next().map(|name| name.to_string()));
    let account_type = validate_account_type(input.account_type.as_deref())?;
    let org_name = input
        .org_name
        .as_deref()
        .map(|name| validate_name(Some(name), "organization name"))
        .transpose()?;
    let mut tx = pool.begin().await?;
    let user = upsert_verified_identity_tx(
        &mut tx,
        &email,
        display_name.as_deref(),
        "dev-google",
        &email,
    )
    .await?;
    let existing = first_active_membership_tx(&mut tx, user.id).await?;
    let organization = if let Some(org_name) = org_name {
        create_self_serve_org_tx(&mut tx, user.id, &org_name, &account_type).await?
    } else if let Some((organization, _membership)) = existing {
        organization
    } else {
        let fallback_name = display_name
            .as_deref()
            .map(|name| format!("{name} Workspace"))
            .unwrap_or_else(|| "My Workspace".to_string());
        create_self_serve_org_tx(&mut tx, user.id, &fallback_name, &account_type).await?
    };
    let membership = ensure_active_owner_membership_tx(&mut tx, organization.id, user.id).await?;
    if let Some(seat_emails) = input.seat_emails {
        for seat_email in seat_emails {
            reserve_seat_tx(&mut tx, user.id, organization.id, &seat_email, "member").await?;
        }
    }
    let session = create_session_tx(&mut tx, user.id, organization.id).await?;
    let memberships = list_memberships_for_user_tx(&mut tx, user.id).await?;
    tx.commit().await?;
    let payload = AuthSessionPayload {
        authenticated: true,
        account_type: organization.account_type.clone(),
        session: session.1,
        user,
        organization,
        membership,
        memberships,
    };
    Ok(CreatedAuthSession {
        token: session.0,
        payload,
    })
}

pub async fn authenticate_session(pool: &PgPool, token: &str) -> AppResult<AuthSessionPayload> {
    let token = validate_name(Some(token), "session token")?;
    let token_hash = hash_secret(&token);
    let session = sqlx::query_as::<_, UserSessionRow>(
        r#"
        select s.id, s.user_id, s.org_id, s.metadata, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
        from user_sessions s
        join memberships m on m.org_id = s.org_id and m.user_id = s.user_id
        where s.token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()
          and m.status = 'active'
        "#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::unauthorized("invalid session"))?;
    sqlx::query(
        r#"
        update user_sessions
        set last_seen_at = now()
        where id = $1
          and (last_seen_at is null or last_seen_at < now() - interval '60 seconds')
        "#,
    )
    .bind(session.id)
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
        update users
        set last_seen_at = now()
        where id = $1
          and (last_seen_at is null or last_seen_at < now() - interval '60 seconds')
        "#,
    )
    .bind(session.user_id)
    .execute(pool)
    .await?;
    session_payload(pool, session).await
}

pub async fn revoke_session(pool: &PgPool, token: &str) -> AppResult<()> {
    let token = validate_name(Some(token), "session token")?;
    sqlx::query(
        r#"
        update user_sessions
        set revoked_at = coalesce(revoked_at, now())
        where token_hash = $1
        "#,
    )
    .bind(hash_secret(&token))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn reserve_seat(
    pool: &PgPool,
    actor_user_id: Uuid,
    org_id: Uuid,
    input: ReserveSeatRequest,
) -> AppResult<MembershipRow> {
    let email = validate_email(input.email.as_deref())?;
    let role = validate_membership_role(input.role.as_deref().or(Some("member")))?;
    if role == "owner" {
        return Err(AppError::validation("reserved seats cannot use owner role"));
    }
    let mut tx = pool.begin().await?;
    let membership = reserve_seat_tx(&mut tx, actor_user_id, org_id, &email, &role).await?;
    tx.commit().await?;
    Ok(membership)
}

pub async fn revoke_api_key(
    pool: &PgPool,
    org_id: Uuid,
    api_key_id: Uuid,
) -> AppResult<PublicApiKeyRow> {
    let mut tx = pool.begin().await?;
    let key = sqlx::query_as::<_, PublicApiKeyRow>(
        r#"
        update api_keys
        set revoked_at = coalesce(revoked_at, now())
        where org_id = $1 and id = $2
        returning id, org_id, service_account_id, name, key_prefix, scopes, project_id, created_at, expires_at, last_used_at, revoked_at
        "#,
    )
    .bind(org_id)
    .bind(api_key_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("api key not found"))?;
    audit_tx(
        &mut tx,
        Some(org_id),
        "api_key.revoked",
        json!({ "api_key_id": api_key_id }),
    )
    .await?;
    tx.commit().await?;
    Ok(key)
}

pub async fn disable_service_account(
    pool: &PgPool,
    org_id: Uuid,
    service_account_id: Uuid,
) -> AppResult<ServiceAccountRow> {
    let mut tx = pool.begin().await?;
    let service_account = sqlx::query_as::<_, ServiceAccountRow>(
        r#"
        update service_accounts
        set disabled_at = coalesce(disabled_at, now())
        where org_id = $1 and id = $2
        returning id, org_id, name, created_by_user_id, created_at, disabled_at
        "#,
    )
    .bind(org_id)
    .bind(service_account_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("service account not found"))?;
    audit_tx(
        &mut tx,
        Some(org_id),
        "service_account.disabled",
        json!({ "service_account_id": service_account_id }),
    )
    .await?;
    tx.commit().await?;
    Ok(service_account)
}

pub async fn authenticate_api_key(pool: &PgPool, token: &str) -> AppResult<AuthContext> {
    let secret = validate_name(Some(token), "api key")?;
    let digest = hash_secret(&secret);
    let row = sqlx::query(
        r#"
        select k.id, k.org_id, k.service_account_id, k.project_id, k.scopes
        from api_keys k
        join service_accounts sa on sa.org_id = k.org_id and sa.id = k.service_account_id
        where k.key_hash = $1
          and k.revoked_at is null
          and (k.expires_at is null or k.expires_at > now())
          and sa.disabled_at is null
        "#,
    )
    .bind(digest)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => {
            let api_key_id: Uuid = row.try_get("id")?;
            sqlx::query(
                r#"
                update api_keys
                set last_used_at = now()
                where id = $1
                  and (last_used_at is null or last_used_at < now() - interval '60 seconds')
                "#,
            )
            .bind(api_key_id)
            .execute(pool)
            .await?;
            Ok(AuthContext {
                api_key_id,
                org_id: row.try_get("org_id")?,
                service_account_id: row.try_get("service_account_id")?,
                project_id: row.try_get("project_id")?,
                scopes: row.try_get("scopes")?,
            })
        }
        None => Err(AppError::unauthorized("invalid api key")),
    }
}

fn validate_scopes(scopes: Vec<String>) -> AppResult<Vec<String>> {
    if scopes.is_empty() {
        return Err(AppError::validation("scopes must be a non-empty list"));
    }
    let mut validated = scopes
        .into_iter()
        .map(|scope| {
            let scope = validate_name(Some(&scope), "scope")?;
            if ALLOWED_SCOPES.contains(&scope.as_str()) {
                Ok(scope)
            } else {
                Err(AppError::validation(format!("unknown scope: {scope}")))
            }
        })
        .collect::<AppResult<Vec<_>>>()?;
    validated.sort();
    validated.dedup();
    Ok(validated)
}

async fn upsert_verified_identity_tx(
    tx: &mut Transaction<'_, Postgres>,
    email: &str,
    display_name: Option<&str>,
    provider: &str,
    provider_subject: &str,
) -> AppResult<UserRow> {
    let email = validate_email(Some(email))?;
    let display_name = validate_optional_name(display_name, "display_name")?;
    let provider = validate_name(Some(provider), "provider")?;
    let provider_subject = validate_name(Some(provider_subject), "provider_subject")?;
    if let Some(existing) = sqlx::query(
        "select user_id, email::text as email from user_identities where provider = $1 and provider_subject = $2",
    )
    .bind(&provider)
    .bind(&provider_subject)
    .fetch_optional(&mut **tx)
    .await?
    {
        let existing_email: String = existing.try_get("email")?;
        if existing_email != email {
            return Err(AppError::conflict("managed identity belongs to another email"));
        }
    }
    let user = sqlx::query_as::<_, UserRow>(
        r#"
        insert into users (primary_email, display_name, last_seen_at)
        values ($1, $2, now())
        on conflict (primary_email) do update
        set display_name = coalesce(excluded.display_name, users.display_name),
            last_seen_at = now()
        returning id, primary_email::text as primary_email, display_name, avatar_url, created_at, last_seen_at
        "#,
    )
    .bind(&email)
    .bind(display_name)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        insert into user_identities (user_id, provider, provider_subject, email, email_verified)
        values ($1, $2, $3, $4, true)
        on conflict (provider, provider_subject) do update
        set user_id = excluded.user_id,
            email = excluded.email,
            email_verified = true
        "#,
    )
    .bind(user.id)
    .bind(&provider)
    .bind(&provider_subject)
    .bind(&email)
    .execute(&mut **tx)
    .await?;
    Ok(user)
}

async fn first_active_membership_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> AppResult<Option<(OrganizationRow, MembershipRow)>> {
    let row = sqlx::query(
        r#"
        select o.id as org_id, o.slug::text as slug, o.name, o.plan_tier, o.account_type,
               o.seat_limit, o.created_by_user_id, o.created_at as org_created_at,
               m.id as membership_id, m.user_id, m.role, m.status, m.created_at as membership_created_at
        from memberships m
        join organizations o on o.id = m.org_id
        where m.user_id = $1 and m.status = 'active'
        order by m.created_at asc
        limit 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| {
        Ok((
            OrganizationRow {
                id: row.try_get("org_id")?,
                slug: row.try_get("slug")?,
                name: row.try_get("name")?,
                plan_tier: row.try_get("plan_tier")?,
                account_type: row.try_get("account_type")?,
                seat_limit: row.try_get("seat_limit")?,
                created_by_user_id: row.try_get("created_by_user_id")?,
                created_at: row.try_get("org_created_at")?,
            },
            MembershipRow {
                id: row.try_get("membership_id")?,
                org_id: row.try_get("org_id")?,
                user_id: row.try_get("user_id")?,
                role: row.try_get("role")?,
                status: row.try_get("status")?,
                created_at: row.try_get("membership_created_at")?,
            },
        ))
    })
    .transpose()
}

async fn create_self_serve_org_tx(
    tx: &mut Transaction<'_, Postgres>,
    owner_user_id: Uuid,
    org_name: &str,
    account_type: &str,
) -> AppResult<OrganizationRow> {
    let name = validate_name(Some(org_name), "organization name")?;
    let account_type = validate_account_type(Some(account_type))?;
    let slug = validate_slug(Some(&slugify(&name)), "organization slug")?;
    let seat_limit = if account_type == "business" { 3 } else { 1 };
    let row = sqlx::query_as::<_, OrganizationRow>(
        r#"
        insert into organizations (slug, name, plan_tier, account_type, seat_limit, created_by_user_id)
        values ($1, $2, 'free', $3, $4, $5)
        on conflict (slug) do nothing
        returning id, slug::text as slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at
        "#,
    )
    .bind(&slug)
    .bind(&name)
    .bind(&account_type)
    .bind(seat_limit)
    .bind(owner_user_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.ok_or_else(|| AppError::conflict("organization slug is already taken"))
}

async fn ensure_active_owner_membership_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    user_id: Uuid,
) -> AppResult<MembershipRow> {
    sqlx::query_as::<_, MembershipRow>(
        r#"
        insert into memberships (org_id, user_id, role, status)
        values ($1, $2, 'owner', 'active')
        on conflict (org_id, user_id) do update
        set role = memberships.role,
            status = case when memberships.status = 'invited' then 'active' else memberships.status end
        returning id, org_id, user_id, role, status, created_at
        "#,
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
}

async fn create_session_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<(String, UserSessionRow)> {
    let token = generate_session_token();
    let session = sqlx::query_as::<_, UserSessionRow>(
        r#"
        insert into user_sessions (user_id, org_id, token_hash, metadata, expires_at)
        values ($1, $2, $3, '{}'::jsonb, $4)
        returning id, user_id, org_id, metadata, created_at, last_seen_at, expires_at, revoked_at
        "#,
    )
    .bind(user_id)
    .bind(org_id)
    .bind(hash_secret(&token))
    .bind(Utc::now() + ChronoDuration::days(SESSION_TTL_DAYS))
    .fetch_one(&mut **tx)
    .await?;
    Ok((token, session))
}

async fn list_memberships_for_user_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> AppResult<Vec<MembershipRow>> {
    sqlx::query_as::<_, MembershipRow>(
        "select id, org_id, user_id, role, status, created_at from memberships where user_id = $1 order by created_at asc",
    )
    .bind(user_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Into::into)
}

async fn session_payload(pool: &PgPool, session: UserSessionRow) -> AppResult<AuthSessionPayload> {
    let user = sqlx::query_as::<_, UserRow>(
        "select id, primary_email::text as primary_email, display_name, avatar_url, created_at, last_seen_at from users where id = $1",
    )
    .bind(session.user_id)
    .fetch_one(pool)
    .await?;
    let organization = sqlx::query_as::<_, OrganizationRow>(
        "select id, slug::text as slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at from organizations where id = $1",
    )
    .bind(session.org_id)
    .fetch_one(pool)
    .await?;
    let membership = sqlx::query_as::<_, MembershipRow>(
        "select id, org_id, user_id, role, status, created_at from memberships where org_id = $1 and user_id = $2 and status = 'active'",
    )
    .bind(session.org_id)
    .bind(session.user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::unauthorized("session membership is not active"))?;
    let memberships = sqlx::query_as::<_, MembershipRow>(
        "select id, org_id, user_id, role, status, created_at from memberships where user_id = $1 order by created_at asc",
    )
    .bind(session.user_id)
    .fetch_all(pool)
    .await?;
    Ok(AuthSessionPayload {
        authenticated: true,
        account_type: organization.account_type.clone(),
        session,
        user,
        organization,
        membership,
        memberships,
    })
}

pub async fn require_org_admin(
    pool: &PgPool,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<MembershipRow> {
    let membership = sqlx::query_as::<_, MembershipRow>(
        "select id, org_id, user_id, role, status, created_at from memberships where org_id = $1 and user_id = $2 and status = 'active'",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::forbidden("user is not a member of this organization"))?;
    if matches!(membership.role.as_str(), "owner" | "admin") {
        Ok(membership)
    } else {
        Err(AppError::forbidden("organization admin access is required"))
    }
}

async fn require_org_admin_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<MembershipRow> {
    let membership = sqlx::query_as::<_, MembershipRow>(
        "select id, org_id, user_id, role, status, created_at from memberships where org_id = $1 and user_id = $2 and status = 'active'",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::forbidden("user is not a member of this organization"))?;
    if matches!(membership.role.as_str(), "owner" | "admin") {
        Ok(membership)
    } else {
        Err(AppError::forbidden("organization admin access is required"))
    }
}

async fn reserve_seat_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor_user_id: Uuid,
    org_id: Uuid,
    email: &str,
    role: &str,
) -> AppResult<MembershipRow> {
    require_org_admin_tx(tx, actor_user_id, org_id).await?;
    let email = validate_email(Some(email))?;
    let role = validate_membership_role(Some(role))?;
    if role == "owner" {
        return Err(AppError::validation("reserved seats cannot use owner role"));
    }
    let seat_limit: i32 =
        sqlx::query_scalar("select seat_limit from organizations where id = $1 for update")
            .bind(org_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| AppError::not_found("organization not found"))?;
    let user = sqlx::query_as::<_, UserRow>(
        r#"
        insert into users (primary_email)
        values ($1)
        on conflict (primary_email) do update set primary_email = users.primary_email
        returning id, primary_email::text as primary_email, display_name, avatar_url, created_at, last_seen_at
        "#,
    )
    .bind(&email)
    .fetch_one(&mut **tx)
    .await?;
    if let Some(existing) = sqlx::query_as::<_, MembershipRow>(
        "select id, org_id, user_id, role, status, created_at from memberships where org_id = $1 and user_id = $2",
    )
    .bind(org_id)
    .bind(user.id)
    .fetch_optional(&mut **tx)
    .await?
    {
        return Ok(existing);
    }
    let seat_count: i64 = sqlx::query_scalar(
        "select count(*) from memberships where org_id = $1 and status in ('active', 'invited')",
    )
    .bind(org_id)
    .fetch_one(&mut **tx)
    .await?;
    if seat_count >= i64::from(seat_limit) {
        return Err(AppError::conflict("organization seat limit reached"));
    }
    sqlx::query_as::<_, MembershipRow>(
        r#"
        insert into memberships (org_id, user_id, role, status)
        values ($1, $2, $3, 'invited')
        returning id, org_id, user_id, role, status, created_at
        "#,
    )
    .bind(org_id)
    .bind(user.id)
    .bind(role)
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
}

fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for ch in name.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }
        if slug.len() >= 63 {
            break;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "workspace".to_string()
    } else {
        slug
    }
}

async fn resolve_api_key_project_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    project_id: Option<Uuid>,
    project_name: Option<&str>,
) -> AppResult<Option<Uuid>> {
    match (project_id, project_name) {
        (None, None) => Ok(None),
        (Some(project_id), None) => {
            ensure_project_exists_tx(tx, org_id, project_id).await?;
            Ok(Some(project_id))
        }
        (None, Some(name)) => {
            let name = validate_name(Some(name), "project")?;
            let row = sqlx::query_scalar::<_, Uuid>(
                "select id from projects where org_id = $1 and name = $2",
            )
            .bind(org_id)
            .bind(name)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| AppError::not_found("project not found"))?;
            Ok(Some(row))
        }
        (Some(project_id), Some(name)) => {
            let name = validate_name(Some(name), "project")?;
            let row = sqlx::query_scalar::<_, Uuid>(
                "select id from projects where org_id = $1 and id = $2 and name = $3",
            )
            .bind(org_id)
            .bind(project_id)
            .bind(name)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| AppError::not_found("project not found"))?;
            Ok(Some(row))
        }
    }
}

async fn ensure_project_exists_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    project_id: Uuid,
) -> AppResult<()> {
    let exists = sqlx::query_scalar::<_, bool>(
        "select exists(select 1 from projects where org_id = $1 and id = $2)",
    )
    .bind(org_id)
    .bind(project_id)
    .fetch_one(&mut **tx)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(AppError::not_found("project not found"))
    }
}
