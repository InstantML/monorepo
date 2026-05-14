use super::*;

const SHARED_DEMO_EMAIL: &str = "hello@instantml.ai";
const SHARED_DEMO_EMAIL_ALIASES: &[&str] = &[SHARED_DEMO_EMAIL, "hello@instantml.com"];
const SHARED_DEMO_NAME: &str = "InstantML Demo";
const SHARED_DEMO_ACCOUNT_TYPE: &str = "business";

pub async fn create_user(store: &Store, input: CreateUserRequest) -> AppResult<UserRow> {
    let email = validate_email(input.email.or(input.primary_email).as_deref())?;
    let provider = validate_name(
        Some(input.provider.as_deref().unwrap_or("local")),
        "provider",
    )?;
    let provider_subject = validate_name(
        Some(input.provider_subject.as_deref().unwrap_or(&email)),
        "provider_subject",
    )?;
    let mut data = store.data.lock().await;
    if let Some(user_id) = data
        .identities
        .get(&(provider.clone(), provider_subject.clone()))
        .copied()
        .or_else(|| data.users_by_email.get(&email).copied())
    {
        return data
            .users
            .get(&user_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("user not found"));
    }
    let user = UserRow {
        id: Uuid::new_v4(),
        primary_email: email.clone(),
        display_name: input.display_name,
        avatar_url: input.avatar_url,
        created_at: Utc::now(),
        last_seen_at: None,
    };
    let identity = IdentityRecord {
        user_id: user.id,
        provider,
        provider_subject,
    };
    store
        .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
        .await?;
    store
        .persist_locked("identity", LOCAL_ORG_ID, &user.id.to_string(), &identity)
        .await?;
    data.insert_user(user.clone());
    data.identities
        .insert((identity.provider, identity.provider_subject), user.id);
    Ok(user)
}

pub async fn list_users(store: &Store) -> AppResult<Vec<UserRow>> {
    Ok(store.data.lock().await.users.values().cloned().collect())
}

pub async fn create_organization(
    store: &Store,
    input: CreateOrganizationRequest,
) -> AppResult<OrganizationRow> {
    let name = validate_name(
        input.name.as_deref().or(input.slug.as_deref()),
        "organization name",
    )?;
    let slug = match input.slug {
        Some(raw) => validate_slug(Some(&raw), "organization slug")?,
        None => slugify(&name),
    };
    let plan_tier = validate_plan_tier(input.plan_tier.as_deref())?;
    let mut data = store.data.lock().await;
    if data.orgs_by_slug.contains_key(&slug) {
        return Err(AppError::conflict("organization already exists"));
    }
    if let Some(owner_id) = input.owner_user_id {
        if !data.users.contains_key(&owner_id) {
            return Err(AppError::not_found("owner user not found"));
        }
    }
    let org = OrganizationRow {
        id: Uuid::new_v4(),
        slug,
        name,
        plan_tier,
        account_type: "customer".to_string(),
        seat_limit: 1,
        created_by_user_id: input.owner_user_id,
        created_at: Utc::now(),
    };
    store
        .persist_locked("organization", org.id, &org.id.to_string(), &org)
        .await?;
    data.insert_org(org.clone());
    if let Some(owner_id) = input.owner_user_id {
        let membership = membership_row(org.id, owner_id, "owner", "active");
        store
            .persist_locked(
                "membership",
                org.id,
                &membership.id.to_string(),
                &membership,
            )
            .await?;
        data.insert_membership(membership);
    }
    drop(data);
    store.ensure_tenant_route(&org).await?;
    Ok(org)
}

pub async fn list_organizations(store: &Store) -> AppResult<Vec<OrganizationRow>> {
    Ok(store
        .data
        .lock()
        .await
        .organizations
        .values()
        .cloned()
        .collect())
}

pub async fn create_dev_google_session(
    store: &Store,
    input: DevGoogleAuthRequest,
) -> AppResult<CreatedAuthSession> {
    let input = normalize_dev_google_auth(input)?;
    let email = input.email;
    let display_name = input.display_name;
    let account_type = input.account_type;
    let seat_emails = input.seat_emails;
    let org_name = input.org_name;
    let mut data = store.data.lock().await;
    let user = if let Some(user_id) = data.users_by_email.get(&email).copied() {
        data.users
            .get(&user_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("user not found"))?
    } else {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: email.clone(),
            display_name,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: Some(Utc::now()),
        };
        let identity = IdentityRecord {
            user_id: user.id,
            provider: "dev-google".to_string(),
            provider_subject: email.clone(),
        };
        store
            .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
            .await?;
        store
            .persist_locked("identity", LOCAL_ORG_ID, &user.id.to_string(), &identity)
            .await?;
        data.insert_user(user.clone());
        data.identities
            .insert((identity.provider, identity.provider_subject), user.id);
        user
    };
    let existing_org = data
        .memberships
        .values()
        .filter(|membership| membership.user_id == user.id && membership.status == "active")
        .filter_map(|membership| data.organizations.get(&membership.org_id))
        .find(|org| org.name == org_name && org.account_type == account_type)
        .cloned()
        .or_else(|| {
            data.organizations
                .values()
                .find(|org| {
                    org.created_by_user_id == Some(user.id)
                        && org.name == org_name
                        && org.account_type == account_type
                })
                .cloned()
        });
    if let Some(org) = existing_org {
        drop(data);
        store.ensure_tenant_route(&org).await?;
        let mut data = store.data.lock().await;
        if !data.memberships.values().any(|membership| {
            membership.org_id == org.id
                && membership.user_id == user.id
                && membership.status == "active"
        }) {
            let owner = membership_row(org.id, user.id, "owner", "active");
            store
                .persist_locked("membership", org.id, &owner.id.to_string(), &owner)
                .await?;
            data.insert_membership(owner);
        }
        let (session, token) = new_session(user.id, org.id);
        store
            .persist_locked("session", org.id, &session.row.id.to_string(), &session)
            .await?;
        data.insert_session(session.clone());
        let payload = session_payload_from_data(&data, session.row.clone())?;
        return Ok(CreatedAuthSession { token, payload });
    }
    let slug_base = slugify(&org_name);
    let slug = unique_slug(&data, &slug_base);
    let seat_limit = if account_type == "business" { 25 } else { 1 };
    let org = OrganizationRow {
        id: Uuid::new_v4(),
        slug,
        name: org_name,
        plan_tier: "free".to_string(),
        account_type: account_type.clone(),
        seat_limit,
        created_by_user_id: Some(user.id),
        created_at: Utc::now(),
    };
    store
        .persist_locked("organization", org.id, &org.id.to_string(), &org)
        .await?;
    data.insert_org(org.clone());
    let owner = membership_row(org.id, user.id, "owner", "active");
    store
        .persist_locked("membership", org.id, &owner.id.to_string(), &owner)
        .await?;
    data.insert_membership(owner.clone());
    drop(data);
    store.ensure_tenant_route(&org).await?;
    let mut data = store.data.lock().await;
    for email in seat_emails {
        if validate_email(Some(&email)).is_ok() {
            let normalized_email = email.to_ascii_lowercase();
            let invited_user = if let Some(id) = data.users_by_email.get(&normalized_email).copied()
            {
                data.users.get(&id).cloned().expect("indexed user")
            } else {
                let invited_user = UserRow {
                    id: Uuid::new_v4(),
                    primary_email: normalized_email,
                    display_name: None,
                    avatar_url: None,
                    created_at: Utc::now(),
                    last_seen_at: None,
                };
                store
                    .persist_locked(
                        "user",
                        LOCAL_ORG_ID,
                        &invited_user.id.to_string(),
                        &invited_user,
                    )
                    .await?;
                data.insert_user(invited_user.clone());
                invited_user
            };
            let invited = membership_row(org.id, invited_user.id, "member", "invited");
            store
                .persist_locked("membership", org.id, &invited.id.to_string(), &invited)
                .await?;
            data.insert_membership(invited);
        }
    }
    let (session, token) = new_session(user.id, org.id);
    store
        .persist_locked("session", org.id, &session.row.id.to_string(), &session)
        .await?;
    data.insert_session(session.clone());
    let payload = session_payload_from_data(&data, session.row.clone())?;
    Ok(CreatedAuthSession { token, payload })
}

struct NormalizedDevGoogleAuth {
    email: String,
    display_name: Option<String>,
    account_type: String,
    org_name: String,
    seat_emails: Vec<String>,
}

fn normalize_dev_google_auth(input: DevGoogleAuthRequest) -> AppResult<NormalizedDevGoogleAuth> {
    let email = validate_email(input.email.as_deref())?;
    if is_shared_demo_email(&email) {
        return Ok(NormalizedDevGoogleAuth {
            email: SHARED_DEMO_EMAIL.to_string(),
            display_name: Some(SHARED_DEMO_NAME.to_string()),
            account_type: SHARED_DEMO_ACCOUNT_TYPE.to_string(),
            org_name: SHARED_DEMO_NAME.to_string(),
            seat_emails: Vec::new(),
        });
    }
    Ok(NormalizedDevGoogleAuth {
        email,
        display_name: validate_optional_name(input.display_name.as_deref(), "display_name")?,
        account_type: validate_account_type(input.account_type.as_deref())?,
        org_name: validate_name(
            input.org_name.as_deref().or(Some("Personal Workspace")),
            "organization",
        )?,
        seat_emails: input.seat_emails.unwrap_or_default(),
    })
}

fn is_shared_demo_email(email: &str) -> bool {
    SHARED_DEMO_EMAIL_ALIASES
        .iter()
        .any(|candidate| email.eq_ignore_ascii_case(candidate))
}

pub async fn authenticate_session(store: &Store, token: &str) -> AppResult<AuthSessionPayload> {
    let token_hash = hash_secret(token);
    let mut data = store.data.lock().await;
    let session_id = data
        .sessions_by_hash
        .get(&token_hash)
        .copied()
        .ok_or_else(|| AppError::unauthorized("invalid session"))?;
    let mut session = data
        .sessions
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::unauthorized("invalid session"))?;
    if session.row.revoked_at.is_some() || session.row.expires_at <= Utc::now() {
        return Err(AppError::unauthorized("invalid session"));
    }
    session.row.last_seen_at = Some(Utc::now());
    data.insert_session(session.clone());
    session_payload_from_data(&data, session.row)
}

pub async fn revoke_session(store: &Store, token: &str) -> AppResult<()> {
    let token_hash = hash_secret(token);
    let mut data = store.data.lock().await;
    let Some(session_id) = data.sessions_by_hash.get(&token_hash).copied() else {
        return Ok(());
    };
    if let Some(mut session) = data.sessions.get(&session_id).cloned() {
        session.row.revoked_at = Some(Utc::now());
        store
            .persist_locked(
                "session",
                session.row.org_id,
                &session.row.id.to_string(),
                &session,
            )
            .await?;
        data.insert_session(session);
    }
    Ok(())
}

pub async fn reserve_seat(
    store: &Store,
    user_id: Uuid,
    org_id: Uuid,
    input: ReserveSeatRequest,
) -> AppResult<MembershipRow> {
    let email = validate_email(input.email.as_deref())?;
    let role = validate_membership_role(input.role.as_deref().or(Some("member")))?;
    let mut data = store.data.lock().await;
    let org = data
        .organizations
        .get(&org_id)
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    require_admin_in_data(&data, user_id, org_id)?;
    let active_or_invited = data
        .memberships
        .values()
        .filter(|m| m.org_id == org_id)
        .count();
    if active_or_invited >= org.seat_limit as usize {
        return Err(AppError::conflict("organization seat limit reached"));
    }
    let invited_user = if let Some(id) = data.users_by_email.get(&email).copied() {
        data.users.get(&id).cloned().expect("indexed user")
    } else {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: email,
            display_name: None,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        store
            .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
            .await?;
        data.insert_user(user.clone());
        user
    };
    let membership = membership_row(org_id, invited_user.id, &role, "invited");
    store
        .persist_locked(
            "membership",
            org_id,
            &membership.id.to_string(),
            &membership,
        )
        .await?;
    data.insert_membership(membership.clone());
    Ok(membership)
}

pub async fn create_api_key(
    store: &Store,
    org_id: Uuid,
    input: CreateApiKeyRequest,
) -> AppResult<Value> {
    let created_by_user_id = input.created_by_user_id;
    create_api_key_inner(store, org_id, input, created_by_user_id).await
}

pub async fn create_api_key_for_user(
    store: &Store,
    user_id: Uuid,
    org_id: Uuid,
    input: CreateApiKeyRequest,
) -> AppResult<Value> {
    create_api_key_inner(store, org_id, input, Some(user_id)).await
}

async fn create_api_key_inner(
    store: &Store,
    org_id: Uuid,
    input: CreateApiKeyRequest,
    created_by_user_id: Option<Uuid>,
) -> AppResult<Value> {
    let name = validate_name(
        input.name.as_deref().or(Some("SDK API key")),
        "api key name",
    )?;
    let default_scopes = if created_by_user_id.is_some() {
        ONBOARDING_API_KEY_SCOPES
    } else {
        DEFAULT_API_KEY_SCOPES
    };
    let scopes = match input.scopes.as_ref() {
        Some(scopes) => validate_scopes(scopes.iter().map(String::as_str))?,
        None => validate_scopes(default_scopes.iter().copied())?,
    };
    let expires_at = input
        .expires_at
        .as_deref()
        .map(|value| validate_timestamp(Some(value)))
        .transpose()?;
    let data = store.data.lock().await;
    if !data.organizations.contains_key(&org_id) {
        return Err(AppError::not_found("organization not found"));
    }
    let org = data
        .organizations
        .get(&org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    drop(data);
    store.ensure_tenant_route(&org).await?;
    let mut data = store.data.lock().await;
    let project_id =
        resolve_key_project(&data, org_id, input.project_id, input.project.as_deref())?;
    let service_account = ServiceAccountRow {
        id: Uuid::new_v4(),
        org_id,
        name: name.clone(),
        created_by_user_id,
        created_at: Utc::now(),
        disabled_at: None,
    };
    let secret = generate_api_key();
    let key_hash = hash_secret(&secret);
    let key = PublicApiKeyRow {
        id: Uuid::new_v4(),
        org_id,
        service_account_id: service_account.id,
        name,
        key_prefix: secret.chars().take(14).collect(),
        scopes,
        project_id,
        created_at: Utc::now(),
        expires_at,
        last_used_at: None,
        revoked_at: None,
    };
    let record = ApiKeyRecord {
        row: key.clone(),
        key_hash,
    };
    store
        .persist_locked(
            "service_account",
            org_id,
            &service_account.id.to_string(),
            &service_account,
        )
        .await?;
    store
        .persist_locked("api_key", org_id, &key.id.to_string(), &record)
        .await?;
    data.service_accounts
        .insert(service_account.id, service_account.clone());
    data.insert_api_key(record);
    Ok(json!({ "api_key": secret, "key": key, "service_account": service_account }))
}

pub async fn list_api_keys(store: &Store, org_id: Uuid) -> AppResult<Vec<PublicApiKeyRow>> {
    Ok(store
        .data
        .lock()
        .await
        .api_keys
        .values()
        .filter(|key| key.row.org_id == org_id)
        .map(|key| key.row.clone())
        .collect())
}

pub async fn revoke_api_key(
    store: &Store,
    org_id: Uuid,
    api_key_id: Uuid,
) -> AppResult<PublicApiKeyRow> {
    let mut data = store.data.lock().await;
    let mut record = data
        .api_keys
        .get(&api_key_id)
        .cloned()
        .filter(|key| key.row.org_id == org_id)
        .ok_or_else(|| AppError::not_found("api key not found"))?;
    record.row.revoked_at = Some(Utc::now());
    store
        .persist_locked("api_key", org_id, &api_key_id.to_string(), &record)
        .await?;
    data.insert_api_key(record.clone());
    Ok(record.row)
}

pub async fn disable_service_account(
    store: &Store,
    org_id: Uuid,
    service_account_id: Uuid,
) -> AppResult<ServiceAccountRow> {
    let mut data = store.data.lock().await;
    let mut row = data
        .service_accounts
        .get(&service_account_id)
        .cloned()
        .filter(|account| account.org_id == org_id)
        .ok_or_else(|| AppError::not_found("service account not found"))?;
    row.disabled_at = Some(Utc::now());
    store
        .persist_locked("service_account", org_id, &row.id.to_string(), &row)
        .await?;
    data.service_accounts.insert(row.id, row.clone());
    Ok(row)
}

pub async fn authenticate_api_key(store: &Store, token: &str) -> AppResult<AuthContext> {
    let key_hash = hash_secret(token);
    let mut data = store.data.lock().await;
    let key_id = data
        .api_keys_by_hash
        .get(&key_hash)
        .copied()
        .ok_or_else(|| AppError::unauthorized("invalid API key"))?;
    let mut record = data
        .api_keys
        .get(&key_id)
        .cloned()
        .ok_or_else(|| AppError::unauthorized("invalid API key"))?;
    if record.row.revoked_at.is_some()
        || record
            .row
            .expires_at
            .map(|expires| expires <= Utc::now())
            .unwrap_or(false)
    {
        return Err(AppError::unauthorized("invalid API key"));
    }
    let account = data
        .service_accounts
        .get(&record.row.service_account_id)
        .ok_or_else(|| AppError::unauthorized("invalid API key"))?;
    if account.disabled_at.is_some() {
        return Err(AppError::unauthorized("invalid API key"));
    }
    record.row.last_used_at = Some(Utc::now());
    data.insert_api_key(record.clone());
    Ok(AuthContext {
        org_id: record.row.org_id,
        api_key_id: record.row.id,
        service_account_id: record.row.service_account_id,
        project_id: record.row.project_id,
        scopes: record.row.scopes,
    })
}

pub async fn require_org_admin(
    store: &Store,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<MembershipRow> {
    let data = store.data.lock().await;
    require_admin_in_data(&data, user_id, org_id)
}

pub fn require_unrestricted_org_access(ctx: &RequestContext) -> AppResult<()> {
    ensure_unrestricted_org_key(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_demo_auth_canonicalizes_aliases() {
        let normalized = normalize_dev_google_auth(DevGoogleAuthRequest {
            email: Some("HELLO@instantml.com".to_string()),
            display_name: Some("Someone Else".to_string()),
            account_type: Some("customer".to_string()),
            org_name: Some("Another Org".to_string()),
            seat_emails: Some(vec!["teammate@example.com".to_string()]),
        })
        .unwrap();

        assert_eq!(normalized.email, SHARED_DEMO_EMAIL);
        assert_eq!(normalized.display_name.as_deref(), Some(SHARED_DEMO_NAME));
        assert_eq!(normalized.account_type, SHARED_DEMO_ACCOUNT_TYPE);
        assert_eq!(normalized.org_name, SHARED_DEMO_NAME);
        assert!(normalized.seat_emails.is_empty());
    }

    #[test]
    fn non_demo_auth_preserves_requested_workspace() {
        let normalized = normalize_dev_google_auth(DevGoogleAuthRequest {
            email: Some("person@example.com".to_string()),
            display_name: Some("Person Example".to_string()),
            account_type: Some("customer".to_string()),
            org_name: Some("Personal Lab".to_string()),
            seat_emails: Some(vec!["teammate@example.com".to_string()]),
        })
        .unwrap();

        assert_eq!(normalized.email, "person@example.com");
        assert_eq!(normalized.display_name.as_deref(), Some("Person Example"));
        assert_eq!(normalized.account_type, "customer");
        assert_eq!(normalized.org_name, "Personal Lab");
        assert_eq!(normalized.seat_emails, vec!["teammate@example.com"]);
    }
}
