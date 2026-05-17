use super::*;
use crate::managed_auth::ManagedAuthPrincipal;
use axum::http::StatusCode;

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
    let canonical_plan_tier = validate_plan_tier(input.plan_tier.as_deref())?;
    let plan = plan_tier(&canonical_plan_tier);
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
        plan_tier: canonical_plan_tier,
        account_type: "customer".to_string(),
        seat_limit: plan.included_seats,
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

pub async fn organization_name_availability(
    store: &Store,
    raw_name: Option<&str>,
) -> AppResult<Value> {
    let name = validate_name(raw_name, "organization")?;
    let slug = slugify(&name);
    let available = !store.data.lock().await.orgs_by_slug.contains_key(&slug);
    let message = if available {
        "Organization name is available."
    } else {
        "Organization name is unavailable."
    };
    Ok(json!({
        "name": name,
        "slug": slug,
        "available": available,
        "message": message
    }))
}

pub async fn create_dev_google_session(
    store: &Store,
    input: DevGoogleAuthRequest,
) -> AppResult<CreatedAuthSession> {
    let input = normalize_dev_google_auth(input)?;
    create_verified_provider_session(
        store,
        VerifiedProviderSessionInput {
            provider: "dev-google".to_string(),
            provider_subject: input.email.clone(),
            email: input.email.clone(),
            display_name: input.display_name.clone(),
            avatar_url: None,
            account_type: input.account_type,
            mode: input.mode,
            org_name: input.org_name,
            plan_tier: input.plan_tier,
            seat_emails: input.seat_emails,
            accept_invite_org_id: input.accept_invite_org_id,
            strict_email_linking: false,
            auto_derive_display_name: input.display_name,
            auto_derive_email: input.email,
        },
    )
    .await
}

pub async fn create_clerk_session(
    store: &Store,
    principal: ManagedAuthPrincipal,
    input: ClerkAuthRequest,
) -> AppResult<CreatedAuthSession> {
    if !principal.email_verified {
        return Err(AppError::unauthorized("Clerk email is not verified"));
    }
    let mode = validate_optional_name(input.mode.as_deref(), "mode")?;
    let signup_mode = mode.as_deref() == Some("signup") || input.org_name.is_some();
    // When org_name is absent and we're in signup mode, auto-derive from Clerk profile.
    // The actual derivation happens inside create_verified_provider_session once we know
    // whether this is truly a fresh user; passing None here signals auto-derive.
    let org_name = if signup_mode && input.org_name.is_some() {
        Some(validate_name(input.org_name.as_deref(), "organization")?)
    } else {
        None
    };
    create_verified_provider_session(
        store,
        VerifiedProviderSessionInput {
            provider: principal.provider,
            provider_subject: principal.provider_subject,
            email: principal.email.clone(),
            display_name: principal.display_name.clone(),
            avatar_url: principal.avatar_url,
            account_type: validate_account_type(input.account_type.as_deref())?,
            mode,
            org_name,
            plan_tier: input.plan_tier,
            seat_emails: input.seat_emails.unwrap_or_default(),
            accept_invite_org_id: input.accept_invite_org_id,
            strict_email_linking: true,
            // Provide Clerk profile fields for auto-derivation fallback.
            auto_derive_display_name: principal.display_name,
            auto_derive_email: principal.email,
        },
    )
    .await
}

struct VerifiedProviderSessionInput {
    provider: String,
    provider_subject: String,
    email: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    account_type: String,
    mode: Option<String>,
    org_name: Option<String>,
    plan_tier: Option<String>,
    seat_emails: Vec<String>,
    accept_invite_org_id: Option<Uuid>,
    strict_email_linking: bool,
    /// Clerk display name used to auto-derive a workspace name when org_name is absent.
    auto_derive_display_name: Option<String>,
    /// Clerk email used to auto-derive a workspace name from the handle when display_name is absent.
    auto_derive_email: String,
}

async fn create_verified_provider_session(
    store: &Store,
    input: VerifiedProviderSessionInput,
) -> AppResult<CreatedAuthSession> {
    let provider = validate_name(Some(&input.provider), "provider")?;
    let provider_subject = validate_name(Some(&input.provider_subject), "provider_subject")?;
    let email = validate_email(Some(&input.email))?;
    let mode = validate_auth_mode(input.mode.as_deref(), input.org_name.is_some())?;
    let account_type = validate_account_type(Some(&input.account_type))?;
    let canonical_plan_tier = validate_plan_tier(input.plan_tier.as_deref())?;
    let plan = plan_tier(&canonical_plan_tier);
    let seat_emails = normalized_invite_emails(input.seat_emails, &email)?;
    if 1 + seat_emails.len() > plan.included_seats as usize {
        return Err(AppError::conflict("organization seat limit reached"));
    }
    let mut data = store.data.lock().await;
    let identity_key = (provider.clone(), provider_subject.clone());
    let user = if let Some(user_id) = data.identities.get(&identity_key).copied() {
        data.users
            .get(&user_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("user not found"))?
    } else if let Some(user_id) = data.users_by_email.get(&email).copied() {
        if input.strict_email_linking && user_has_non_bootstrap_identity(&data, user_id) {
            return Err(AppError::conflict(
                "email already belongs to an existing account",
            ));
        }
        let user = data
            .users
            .get(&user_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("user not found"))?;
        let identity = IdentityRecord {
            user_id: user.id,
            provider,
            provider_subject,
        };
        store
            .persist_locked("identity", LOCAL_ORG_ID, &user.id.to_string(), &identity)
            .await?;
        data.identities
            .insert((identity.provider, identity.provider_subject), user.id);
        user
    } else {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: email.clone(),
            display_name: input.display_name,
            avatar_url: input.avatar_url,
            created_at: Utc::now(),
            last_seen_at: Some(Utc::now()),
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
        user
    };
    let existing_org = existing_org_for_auth(
        &data,
        user.id,
        (mode == "signup")
            .then_some(input.org_name.as_deref())
            .flatten(),
        &account_type,
    );
    if let Some(org) = existing_org {
        drop(data);
        return create_session_for_org(store, user, org).await;
    }
    if let Some(invite_org_id) = input.accept_invite_org_id {
        if let Some(org) =
            activate_invited_membership(store, &mut data, user.id, invite_org_id).await?
        {
            drop(data);
            return create_session_for_org(store, user, org).await;
        }
        return Err(AppError::not_found("invitation not found"));
    }
    if mode != "signup" {
        let invites = pending_invites_for_user(&data, user.id);
        match invites.len() {
            0 => return Err(AppError::validation("organization is required for signup")),
            1 => {
                let org = activate_invited_membership(store, &mut data, user.id, invites[0].org_id)
                    .await?
                    .ok_or_else(|| AppError::not_found("invitation not found"))?;
                drop(data);
                return create_session_for_org(store, user, org).await;
            }
            _ => {
                return Err(AppError::with_code(
                    StatusCode::CONFLICT,
                    "multiple_pending_invites",
                    "multiple pending invitations",
                ))
            }
        }
    }
    // Resolve org name: use explicit org_name if provided, else auto-derive from Clerk profile.
    let (org_name, org_slug, auto_derived) = if let Some(name) = input.org_name {
        let slug = slugify(&name);
        if data.orgs_by_slug.contains_key(&slug) {
            return Err(AppError::conflict("organization name already exists"));
        }
        (name, slug, false)
    } else {
        // Auto-derive workspace name from Clerk display name or email handle.
        let base_slug = derive_workspace_slug(
            input.auto_derive_display_name.as_deref(),
            &input.auto_derive_email,
        );
        let slug = unique_slug(&data, &base_slug);
        let name = slug_to_name(&slug);
        (name, slug, true)
    };
    let effective_account_type = if auto_derived {
        "personal".to_string()
    } else {
        account_type.clone()
    };
    let org = OrganizationRow {
        id: Uuid::new_v4(),
        slug: org_slug,
        name: org_name,
        plan_tier: canonical_plan_tier,
        account_type: effective_account_type,
        seat_limit: plan.included_seats,
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
        let invited_user = get_or_create_placeholder_user(store, &mut data, &email).await?;
        if data.memberships.values().any(|membership| {
            membership.org_id == org.id
                && membership.user_id == invited_user.id
                && matches!(membership.status.as_str(), "active" | "invited")
        }) {
            continue;
        }
        let invited = membership_row(org.id, invited_user.id, "member", "invited");
        store
            .persist_locked("membership", org.id, &invited.id.to_string(), &invited)
            .await?;
        data.insert_membership(invited);
    }
    let (session, token) = new_session(user.id, org.id);
    store
        .persist_locked("session", org.id, &session.row.id.to_string(), &session)
        .await?;
    data.insert_session(session.clone());
    let payload = session_payload_from_data(&data, session.row.clone())?;
    drop(data);
    // Atomically mint an onboarding SDK key for the new org.
    let onboarding_api_key = mint_onboarding_api_key(store, org.id, user.id).await.ok();
    Ok(CreatedAuthSession {
        token,
        payload,
        onboarding_api_key,
    })
}

async fn create_session_for_org(
    store: &Store,
    user: UserRow,
    org: OrganizationRow,
) -> AppResult<CreatedAuthSession> {
    store.ensure_tenant_route(&org).await?;
    let mut data = store.data.lock().await;
    if !data.memberships.values().any(|membership| {
        membership.org_id == org.id
            && membership.user_id == user.id
            && membership.status == "active"
    }) {
        if org.created_by_user_id != Some(user.id) {
            return Err(AppError::forbidden(
                "user is not an active member of the organization",
            ));
        }
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
    Ok(CreatedAuthSession {
        token,
        payload,
        onboarding_api_key: None,
    })
}

fn user_has_non_bootstrap_identity(data: &StoreData, user_id: Uuid) -> bool {
    data.identities
        .iter()
        .any(|((provider, _), candidate)| *candidate == user_id && provider != "bootstrap")
}

fn existing_org_for_auth(
    data: &StoreData,
    user_id: Uuid,
    org_name: Option<&str>,
    account_type: &str,
) -> Option<OrganizationRow> {
    data.memberships
        .values()
        .filter(|membership| membership.user_id == user_id && membership.status == "active")
        .filter_map(|membership| data.organizations.get(&membership.org_id))
        .find(|org| {
            org_name
                .map(|name| org.name == name && org.account_type == account_type)
                .unwrap_or(true)
        })
        .cloned()
        .or_else(|| {
            org_name.and_then(|name| {
                data.organizations
                    .values()
                    .find(|org| {
                        org.created_by_user_id == Some(user_id)
                            && org.name == name
                            && org.account_type == account_type
                    })
                    .cloned()
            })
        })
}

fn validate_auth_mode(value: Option<&str>, signup_hint: bool) -> AppResult<String> {
    let mode = validate_optional_name(value, "mode")?
        .unwrap_or_else(|| if signup_hint { "signup" } else { "signin" }.to_string())
        .to_ascii_lowercase();
    if matches!(mode.as_str(), "signin" | "signup") {
        Ok(mode)
    } else {
        Err(AppError::validation("mode must be one of: signin, signup"))
    }
}

fn normalized_invite_emails(raw_emails: Vec<String>, owner_email: &str) -> AppResult<Vec<String>> {
    let mut seen = BTreeSet::new();
    let mut emails = Vec::new();
    for raw in raw_emails {
        let email = validate_email(Some(&raw))?;
        if email == owner_email || !seen.insert(email.clone()) {
            continue;
        }
        emails.push(email);
    }
    Ok(emails)
}

fn pending_invites_for_user(data: &StoreData, user_id: Uuid) -> Vec<MembershipRow> {
    data.memberships
        .values()
        .filter(|membership| membership.user_id == user_id && membership.status == "invited")
        .cloned()
        .collect()
}

async fn activate_invited_membership(
    store: &Store,
    data: &mut StoreData,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<Option<OrganizationRow>> {
    let Some(mut membership) = data
        .memberships
        .values()
        .find(|membership| {
            membership.org_id == org_id
                && membership.user_id == user_id
                && membership.status == "invited"
        })
        .cloned()
    else {
        return Ok(None);
    };
    let org = data
        .organizations
        .get(&org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    membership.status = "active".to_string();
    store
        .persist_locked(
            "membership",
            org_id,
            &membership.id.to_string(),
            &membership,
        )
        .await?;
    data.insert_membership(membership);
    Ok(Some(org))
}

async fn get_or_create_placeholder_user(
    store: &Store,
    data: &mut StoreData,
    email: &str,
) -> AppResult<UserRow> {
    if let Some(id) = data.users_by_email.get(email).copied() {
        return data
            .users
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::internal("user email index is inconsistent"));
    }
    let user = UserRow {
        id: Uuid::new_v4(),
        primary_email: email.to_string(),
        display_name: None,
        avatar_url: None,
        created_at: Utc::now(),
        last_seen_at: None,
    };
    store
        .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
        .await?;
    data.insert_user(user.clone());
    Ok(user)
}

struct NormalizedDevGoogleAuth {
    email: String,
    display_name: Option<String>,
    account_type: String,
    mode: Option<String>,
    org_name: Option<String>,
    plan_tier: Option<String>,
    seat_emails: Vec<String>,
    accept_invite_org_id: Option<Uuid>,
}

fn normalize_dev_google_auth(input: DevGoogleAuthRequest) -> AppResult<NormalizedDevGoogleAuth> {
    let email = validate_email(input.email.as_deref())?;
    if is_shared_demo_email(&email) {
        return Ok(NormalizedDevGoogleAuth {
            email: SHARED_DEMO_EMAIL.to_string(),
            display_name: Some(SHARED_DEMO_NAME.to_string()),
            account_type: SHARED_DEMO_ACCOUNT_TYPE.to_string(),
            mode: Some("signup".to_string()),
            org_name: Some(SHARED_DEMO_NAME.to_string()),
            plan_tier: Some("free".to_string()),
            seat_emails: Vec::new(),
            accept_invite_org_id: None,
        });
    }
    Ok(NormalizedDevGoogleAuth {
        email,
        display_name: validate_optional_name(input.display_name.as_deref(), "display_name")?,
        account_type: validate_account_type(input.account_type.as_deref())?,
        mode: input.mode,
        org_name: input
            .org_name
            .as_deref()
            .map(|name| validate_name(Some(name), "organization"))
            .transpose()?,
        plan_tier: input.plan_tier,
        seat_emails: input.seat_emails.unwrap_or_default(),
        accept_invite_org_id: input.accept_invite_org_id,
    })
}

fn is_shared_demo_email(email: &str) -> bool {
    SHARED_DEMO_EMAIL_ALIASES
        .iter()
        .any(|candidate| email.eq_ignore_ascii_case(candidate))
}

pub fn is_shared_demo_org(org: &OrganizationRow) -> bool {
    org.name == SHARED_DEMO_NAME && org.slug == slugify(SHARED_DEMO_NAME)
}

/// Derive a workspace slug from a Clerk display name or email handle.
/// Preference order: display_name → email handle.
pub(crate) fn derive_workspace_slug(display_name: Option<&str>, email: &str) -> String {
    let source = display_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            email
                .split_once('@')
                .map(|(handle, _)| handle)
                .unwrap_or(email)
        });
    let slug = slugify(source);
    if slug.is_empty() || slug == "workspace" {
        // Fallback: use email handle directly.
        let handle = email.split_once('@').map(|(h, _)| h).unwrap_or(email);
        slugify(handle)
    } else {
        slug
    }
}

/// Convert a slug such as "tony-xin" to a human-readable name "Tony Xin".
pub(crate) fn slug_to_name(slug: &str) -> String {
    slug.split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Mint a fresh `sdk:ingest`-scoped onboarding API key for a newly created org.
/// Returns `None` (and logs) on failure rather than aborting the signup.
async fn mint_onboarding_api_key(
    store: &Store,
    org_id: Uuid,
    user_id: Uuid,
) -> AppResult<OnboardingApiKey> {
    let result = create_api_key_inner(
        store,
        org_id,
        CreateApiKeyRequest {
            name: Some("Onboarding SDK key".to_string()),
            scopes: Some(
                ONBOARDING_API_KEY_SCOPES
                    .iter()
                    .map(|s| (*s).to_string())
                    .collect(),
            ),
            created_by_user_id: Some(user_id),
            project_id: None,
            project: None,
            expires_at: None,
        },
        Some(user_id),
    )
    .await?;
    let plaintext = result
        .get("api_key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let prefix = result
        .get("key")
        .and_then(|k| k.get("key_prefix"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let id_str = result
        .get("key")
        .and_then(|k| k.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let id = Uuid::parse_str(id_str).map_err(|_| AppError::internal("invalid key id"))?;
    if plaintext.is_empty() {
        return Err(AppError::internal("onboarding key plaintext was empty"));
    }
    Ok(OnboardingApiKey {
        plaintext,
        prefix,
        id,
    })
}

fn demo_api_key_scopes() -> Vec<String> {
    DEMO_API_KEY_SCOPES
        .iter()
        .map(|scope| (*scope).to_string())
        .collect()
}

fn effective_api_key_scopes(data: &StoreData, record: &ApiKeyRecord) -> Vec<String> {
    if data
        .organizations
        .get(&record.row.org_id)
        .is_some_and(is_shared_demo_org)
    {
        return demo_api_key_scopes();
    }
    record.row.scopes.clone()
}

pub async fn authenticate_session(store: &Store, token: &str) -> AppResult<AuthSessionPayload> {
    let token_hash = hash_secret(token);
    let data = store.data.lock().await;
    let session_id = data
        .sessions_by_hash
        .get(&token_hash)
        .copied()
        .ok_or_else(|| AppError::unauthorized("invalid session"))?;
    let session = data
        .sessions
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::unauthorized("invalid session"))?;
    if session.row.revoked_at.is_some() || session.row.expires_at <= Utc::now() {
        return Err(AppError::unauthorized("invalid session"));
    }
    let mut row = session.row;
    row.last_seen_at = Some(Utc::now());
    session_payload_from_data(&data, row)
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
    user_id: Option<Uuid>,
    org_id: Uuid,
    input: ReserveSeatRequest,
) -> AppResult<SeatRow> {
    let email = validate_email(input.email.as_deref())?;
    let role = validate_membership_role(input.role.as_deref().or(Some("member")))?;
    if role == "owner" {
        return Err(AppError::validation(
            "invited seats can use admin, member, or viewer roles",
        ));
    }
    let mut data = store.data.lock().await;
    let seat_limit = data
        .organizations
        .get(&org_id)
        .ok_or_else(|| AppError::not_found("organization not found"))?
        .seat_limit as usize;
    if let Some(user_id) = user_id {
        require_admin_in_data(&data, user_id, org_id)?;
    }
    let invited_user = get_or_create_placeholder_user(store, &mut data, &email).await?;
    if let Some(existing) = data
        .memberships
        .values()
        .find(|membership| {
            membership.org_id == org_id
                && membership.user_id == invited_user.id
                && matches!(membership.status.as_str(), "active" | "invited")
        })
        .cloned()
    {
        return seat_row_from_data(&data, existing);
    }
    let active_or_invited = data
        .memberships
        .values()
        .filter(|membership| {
            membership.org_id == org_id
                && matches!(membership.status.as_str(), "active" | "invited")
        })
        .count();
    if active_or_invited >= seat_limit {
        return Err(AppError::conflict("organization seat limit reached"));
    }
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
    seat_row_from_data(&data, membership)
}

pub async fn list_seats(store: &Store, org_id: Uuid) -> AppResult<Vec<SeatRow>> {
    let data = store.data.lock().await;
    if !data.organizations.contains_key(&org_id) {
        return Err(AppError::not_found("organization not found"));
    }
    let mut seats = data
        .memberships
        .values()
        .filter(|membership| membership.org_id == org_id)
        .cloned()
        .map(|membership| seat_row_from_data(&data, membership))
        .collect::<AppResult<Vec<_>>>()?;
    seats.sort_by(|left, right| {
        left.membership
            .created_at
            .cmp(&right.membership.created_at)
            .then_with(|| left.user.primary_email.cmp(&right.user.primary_email))
    });
    Ok(seats)
}

fn seat_row_from_data(data: &StoreData, membership: MembershipRow) -> AppResult<SeatRow> {
    let user = data
        .users
        .get(&membership.user_id)
        .ok_or_else(|| AppError::not_found("seat user not found"))?;
    Ok(SeatRow {
        membership,
        user: SeatUserRow {
            id: user.id,
            primary_email: user.primary_email.clone(),
            display_name: user.display_name.clone(),
            avatar_url: user.avatar_url.clone(),
        },
    })
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
    let requested_scopes = input.scopes.clone();
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
    let demo_org = is_shared_demo_org(&org);
    let default_scopes = if demo_org {
        DEMO_API_KEY_SCOPES
    } else if created_by_user_id.is_some() {
        ONBOARDING_API_KEY_SCOPES
    } else {
        DEFAULT_API_KEY_SCOPES
    };
    let scopes = if demo_org {
        validate_scopes(DEMO_API_KEY_SCOPES.iter().copied())?
    } else {
        match requested_scopes.as_ref() {
            Some(scopes) => validate_scopes(scopes.iter().map(String::as_str))?,
            None => validate_scopes(default_scopes.iter().copied())?,
        }
    };
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
    let api_key = if demo_org { Value::Null } else { json!(secret) };
    let message = demo_org.then_some("Demo workspace API keys are read-only and are not revealed.");
    Ok(json!({
        "api_key": api_key,
        "api_key_available": !demo_org,
        "key": key,
        "message": message,
        "service_account": service_account
    }))
}

pub async fn list_api_keys(store: &Store, org_id: Uuid) -> AppResult<Vec<PublicApiKeyRow>> {
    let data = store.data.lock().await;
    Ok(data
        .api_keys
        .values()
        .filter(|key| key.row.org_id == org_id)
        .map(|key| {
            let mut row = key.row.clone();
            row.scopes = effective_api_key_scopes(&data, key);
            row
        })
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
    let data = store.data.lock().await;
    let key_id = data
        .api_keys_by_hash
        .get(&key_hash)
        .copied()
        .ok_or_else(|| AppError::unauthorized("invalid API key"))?;
    let record = data
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
    let scopes = effective_api_key_scopes(&data, &record);
    Ok(AuthContext {
        org_id: record.row.org_id,
        api_key_id: record.row.id,
        service_account_id: record.row.service_account_id,
        project_id: record.row.project_id,
        scopes,
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
            mode: Some("signup".to_string()),
            account_type: Some("customer".to_string()),
            org_name: Some("Another Org".to_string()),
            plan_tier: Some("premium".to_string()),
            seat_emails: Some(vec!["teammate@example.com".to_string()]),
            accept_invite_org_id: Some(Uuid::new_v4()),
        })
        .unwrap();

        assert_eq!(normalized.email, SHARED_DEMO_EMAIL);
        assert_eq!(normalized.display_name.as_deref(), Some(SHARED_DEMO_NAME));
        assert_eq!(normalized.account_type, SHARED_DEMO_ACCOUNT_TYPE);
        assert_eq!(normalized.org_name.as_deref(), Some(SHARED_DEMO_NAME));
        assert_eq!(normalized.plan_tier.as_deref(), Some("free"));
        assert_eq!(normalized.accept_invite_org_id, None);
        assert!(normalized.seat_emails.is_empty());
    }

    #[test]
    fn non_demo_auth_preserves_requested_workspace() {
        let normalized = normalize_dev_google_auth(DevGoogleAuthRequest {
            email: Some("person@example.com".to_string()),
            display_name: Some("Person Example".to_string()),
            mode: Some("signup".to_string()),
            account_type: Some("customer".to_string()),
            org_name: Some("Personal Lab".to_string()),
            plan_tier: Some("pro".to_string()),
            seat_emails: Some(vec!["teammate@example.com".to_string()]),
            accept_invite_org_id: None,
        })
        .unwrap();

        assert_eq!(normalized.email, "person@example.com");
        assert_eq!(normalized.display_name.as_deref(), Some("Person Example"));
        assert_eq!(normalized.account_type, "customer");
        assert_eq!(normalized.mode.as_deref(), Some("signup"));
        assert_eq!(normalized.org_name.as_deref(), Some("Personal Lab"));
        assert_eq!(normalized.plan_tier.as_deref(), Some("pro"));
        assert_eq!(normalized.seat_emails, vec!["teammate@example.com"]);
    }

    #[test]
    fn strict_email_linking_allows_operator_bootstrap_identity() {
        let user_id = Uuid::new_v4();
        let mut data = StoreData::default();
        data.identities.insert(
            ("bootstrap".to_string(), "person@example.com".to_string()),
            user_id,
        );

        assert!(!user_has_non_bootstrap_identity(&data, user_id));

        data.identities
            .insert(("clerk".to_string(), "user_123".to_string()), user_id);

        assert!(user_has_non_bootstrap_identity(&data, user_id));
    }

    #[test]
    fn shared_demo_org_is_identified_by_canonical_name_and_slug() {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: slugify(SHARED_DEMO_NAME),
            name: SHARED_DEMO_NAME.to_string(),
            plan_tier: "free".to_string(),
            account_type: SHARED_DEMO_ACCOUNT_TYPE.to_string(),
            seat_limit: 25,
            created_by_user_id: None,
            created_at: Utc::now(),
        };

        assert!(is_shared_demo_org(&org));

        let mut renamed = org;
        renamed.name = "Customer Demo".to_string();
        assert!(!is_shared_demo_org(&renamed));
    }

    #[test]
    fn shared_demo_key_scopes_are_clamped_at_authorization_time() {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: slugify(SHARED_DEMO_NAME),
            name: SHARED_DEMO_NAME.to_string(),
            plan_tier: "free".to_string(),
            account_type: SHARED_DEMO_ACCOUNT_TYPE.to_string(),
            seat_limit: 25,
            created_by_user_id: None,
            created_at: Utc::now(),
        };
        let mut data = StoreData::default();
        data.insert_org(org.clone());
        let record = api_key_record_for_org(
            org.id,
            vec![
                "sdk:ingest".to_string(),
                "artifacts:write".to_string(),
                "api_keys:write".to_string(),
                "export:read".to_string(),
            ],
        );

        assert_eq!(
            effective_api_key_scopes(&data, &record),
            demo_api_key_scopes()
        );
        assert!(!effective_api_key_scopes(&data, &record).contains(&"api_keys:write".to_string()));
        assert!(!effective_api_key_scopes(&data, &record).contains(&"sdk:ingest".to_string()));
    }

    #[test]
    fn non_demo_key_scopes_are_preserved_at_authorization_time() {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "customer-lab".to_string(),
            name: "Customer Lab".to_string(),
            plan_tier: "free".to_string(),
            account_type: "customer".to_string(),
            seat_limit: 1,
            created_by_user_id: None,
            created_at: Utc::now(),
        };
        let mut data = StoreData::default();
        data.insert_org(org.clone());
        let requested = vec!["sdk:ingest".to_string(), "export:read".to_string()];
        let record = api_key_record_for_org(org.id, requested.clone());

        assert_eq!(effective_api_key_scopes(&data, &record), requested);
    }

    fn api_key_record_for_org(org_id: Uuid, scopes: Vec<String>) -> ApiKeyRecord {
        ApiKeyRecord {
            row: PublicApiKeyRow {
                id: Uuid::new_v4(),
                org_id,
                service_account_id: Uuid::new_v4(),
                name: "Legacy key".to_string(),
                key_prefix: "instantml_test".to_string(),
                scopes,
                project_id: None,
                created_at: Utc::now(),
                expires_at: None,
                last_used_at: None,
                revoked_at: None,
            },
            key_hash: vec![1, 2, 3],
        }
    }

    // --- Auto-derive workspace name tests ---

    #[test]
    fn auto_derive_workspace_name_from_display_name() {
        // Clerk display name "Tony Xin" → slug "tony-xin"
        let slug = derive_workspace_slug(Some("Tony Xin"), "tony@example.com");
        assert_eq!(slug, "tony-xin");

        // Name with special chars: "Ada Lovelace!" → "ada-lovelace"
        let slug = derive_workspace_slug(Some("Ada Lovelace!"), "ada@example.com");
        assert_eq!(slug, "ada-lovelace");
    }

    #[test]
    fn auto_derive_workspace_name_from_email_handle() {
        // No display name: email "ada@example.com" → slug "ada"
        let slug = derive_workspace_slug(None, "ada@example.com");
        assert_eq!(slug, "ada");

        // Blank display name falls through to email handle
        let slug = derive_workspace_slug(Some("  "), "researcher@lab.ai");
        assert_eq!(slug, "researcher");

        // Email without @: treat whole string as handle
        let slug = derive_workspace_slug(None, "standalone");
        assert_eq!(slug, "standalone");
    }

    #[test]
    fn slug_to_name_converts_slug_parts_to_title_case() {
        assert_eq!(slug_to_name("tony-xin"), "Tony Xin");
        assert_eq!(slug_to_name("ada"), "Ada");
        assert_eq!(
            slug_to_name("my-personal-workspace"),
            "My Personal Workspace"
        );
    }

    #[test]
    fn slug_collision_falls_back_to_unique_suffix() {
        // Pre-seed "tony-xin" in store data; unique_slug must produce a different slug.
        let mut data = StoreData::default();
        let existing_org = OrganizationRow {
            id: Uuid::from_u128(42),
            slug: "tony-xin".to_string(),
            name: "Tony Xin".to_string(),
            plan_tier: "free".to_string(),
            account_type: "personal".to_string(),
            seat_limit: 2,
            created_by_user_id: None,
            created_at: Utc::now(),
        };
        data.insert_org(existing_org);

        // derive base slug
        let base = derive_workspace_slug(Some("Tony Xin"), "tony@example.com");
        assert_eq!(base, "tony-xin");

        // unique_slug must return something different
        let slug = unique_slug(&data, &base);
        assert_ne!(slug, "tony-xin");
        // Must start with the base
        assert!(slug.starts_with("tony-xin-"));
    }
}
