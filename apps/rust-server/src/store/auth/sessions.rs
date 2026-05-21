use super::super::*;
use super::api_keys::mint_onboarding_api_key;
use super::helpers::*;
use super::invitations::activate_invited_membership;
use super::invitations::normalized_invite_emails;
use super::invitations::pending_invites_for_user;
use super::orgs::is_shared_demo_org;
use crate::managed_auth::ManagedAuthPrincipal;
use axum::http::StatusCode;

pub async fn create_dev_google_session(
    store: &Store,
    input: DevGoogleAuthRequest,
    billing_config: Option<&crate::config::BillingConfig>,
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
        billing_config,
    )
    .await
}

pub async fn create_clerk_session(
    store: &Store,
    principal: ManagedAuthPrincipal,
    input: ClerkAuthRequest,
    billing_config: Option<&crate::config::BillingConfig>,
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
        billing_config,
    )
    .await
}

pub(super) async fn create_verified_provider_session(
    store: &Store,
    input: VerifiedProviderSessionInput,
    billing_config: Option<&crate::config::BillingConfig>,
) -> AppResult<CreatedAuthSession> {
    let provider = validate_name(Some(&input.provider), "provider")?;
    let provider_subject = validate_name(Some(&input.provider_subject), "provider_subject")?;
    let email = validate_email(Some(&input.email))?;
    let mode = validate_auth_mode(input.mode.as_deref(), input.org_name.is_some())?;
    let account_type = validate_account_type(Some(&input.account_type))?;
    let canonical_plan_tier = validate_plan_tier(input.plan_tier.as_deref())?;
    let plan = plan_tier(&canonical_plan_tier);
    let paid_signup_requires_checkout =
        billing_config.is_some_and(|config| config.enabled) && canonical_plan_tier != "free";
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
    if let Some(mut org) = existing_org {
        if is_shared_demo_org(&org)
            && (org.plan_tier != "premium" || org.seat_limit != PLAN_PREMIUM.included_seats)
        {
            org.plan_tier = "premium".to_string();
            org.seat_limit = PLAN_PREMIUM.included_seats;
            store
                .persist_locked("organization", org.id, &org.id.to_string(), &org)
                .await?;
            data.insert_org(org.clone());
        }
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
    let (org_name, org_slug, auto_derived) = if let Some(name) = input.org_name {
        let slug = slugify(&name);
        if data.orgs_by_slug.contains_key(&slug) {
            return Err(AppError::conflict("organization name already exists"));
        }
        (name, slug, false)
    } else {
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
    let tenant_routing_tier = if is_personal_account_type(&effective_account_type) {
        "shared".to_string()
    } else {
        "dedicated".to_string()
    };
    let stored_plan_tier = if paid_signup_requires_checkout {
        "free".to_string()
    } else {
        canonical_plan_tier.clone()
    };
    let stored_plan = plan_tier(&stored_plan_tier);
    let org = OrganizationRow {
        id: Uuid::new_v4(),
        slug: org_slug,
        name: org_name,
        plan_tier: stored_plan_tier,
        account_type: effective_account_type,
        seat_limit: stored_plan.included_seats,
        created_by_user_id: Some(user.id),
        created_at: Utc::now(),
        tenant_routing_tier,
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
    if paid_signup_requires_checkout {
        let mut data = store.data.lock().await;
        let (session, token) = new_session(user.id, org.id);
        store
            .persist_locked("session", org.id, &session.row.id.to_string(), &session)
            .await?;
        data.insert_session(session.clone());
        let mut payload = session_payload_from_data(&data, session.row.clone())?;
        drop(data);
        let checkout = create_checkout_for_org(
            store,
            billing_config.expect("checked above"),
            org.id,
            user.id,
            &canonical_plan_tier,
            "paid_signup",
            seat_emails,
        )
        .await?;
        payload.billing_checkout = Some(checkout);
        return Ok(CreatedAuthSession {
            token,
            payload,
            onboarding_api_key: None,
        });
    }
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
    let onboarding_api_key = mint_onboarding_api_key(store, org.id, user.id).await.ok();
    Ok(CreatedAuthSession {
        token,
        payload,
        onboarding_api_key,
    })
}

pub(super) async fn create_session_for_org(
    store: &Store,
    user: UserRow,
    org: OrganizationRow,
) -> AppResult<CreatedAuthSession> {
    if !billing_blocks_tenant_route(store, org.id).await {
        store.ensure_tenant_route(&org).await?;
    }
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

async fn billing_blocks_tenant_route(store: &Store, org_id: Uuid) -> bool {
    let data = store.data.lock().await;
    data.billing_accounts.get(&org_id).is_some_and(|account| {
        matches!(
            account.access_state.as_str(),
            BILLING_CHECKOUT_PENDING | BILLING_READ_ONLY_PAYMENT_REQUIRED | BILLING_CANCELED
        )
    })
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(normalized.plan_tier.as_deref(), Some("premium"));
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
            tenant_routing_tier: "shared".to_string(),
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
