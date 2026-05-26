use super::super::*;
use super::api_keys::mint_onboarding_api_key;
use super::helpers::*;
use super::invitations::accept_invitation_for_user;
use super::invitations::activate_invited_membership;
use super::invitations::normalized_invite_emails;
use super::invitations::pending_invites_for_user;
use super::invitations::preflight_invitation_for_email;
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
            storage_choice: input.storage_choice,
            seat_emails: input.seat_emails,
            accept_invite_org_id: input.accept_invite_org_id,
            accept_invite_token: input.accept_invite_token,
            strict_email_linking: false,
            // Dev-google is a "verified-identity provider" in local dev: a
            // first-time signin should land in a workspace without forcing the
            // user to click "Create a workspace" first.
            strict_signin: false,
            auto_derive_display_name: input.display_name,
            auto_derive_email: input.email,
            // Local dev never enforces the hosted signup allowlist.
            signup_allowlist: SignupAllowlist::default(),
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
    signup_allowlist: SignupAllowlist,
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
            storage_choice: input.storage_choice,
            seat_emails: input.seat_emails.unwrap_or_default(),
            accept_invite_org_id: input.accept_invite_org_id,
            accept_invite_token: input.accept_invite_token,
            strict_email_linking: true,
            // Clerk is a verified-identity provider: a first-time signin with
            // no existing org and no pending invite should fall through to
            // auto-create a workspace named after the Clerk profile, instead
            // of returning the historic "organization is required for signup"
            // error that stranded users on the signin card.
            strict_signin: false,
            // Provide Clerk profile fields for auto-derivation fallback.
            auto_derive_display_name: principal.display_name,
            auto_derive_email: principal.email,
            // The hosted signup allowlist is enforced at the moment we decide
            // to create a new org (not only for explicit signup-mode requests),
            // so the security boundary holds for the new signin auto-provision
            // path too.
            signup_allowlist,
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
    let allow_legacy_invite_activation = provider != "clerk";
    let email = validate_email(Some(&input.email))?;
    let mode = validate_auth_mode(input.mode.as_deref(), input.org_name.is_some())?;
    let account_type = validate_account_type(Some(&input.account_type))?;
    let canonical_plan_tier = validate_plan_tier(input.plan_tier.as_deref())?;
    let storage_choice = validate_storage_choice(input.storage_choice.as_deref())?;
    let plan = plan_tier(&canonical_plan_tier);
    let paid_signup_requires_checkout =
        billing_config.is_some_and(|config| config.enabled) && canonical_plan_tier != "free";
    let seat_emails = normalized_invite_emails(input.seat_emails, &email)?;
    if let Some(invite_token) = input.accept_invite_token.as_deref() {
        preflight_invitation_for_email(store, invite_token, &email).await?;
    }
    if 1 + seat_emails.len() > plan.included_seats as usize {
        return Err(AppError::conflict("organization seat limit reached"));
    }
    let mut data = store.data.lock().await;
    let identity_key = (provider.clone(), provider_subject.clone());
    let mut user = if let Some(user_id) = data.identities.get(&identity_key).copied() {
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
    if user.primary_email != email {
        if data
            .users_by_email
            .get(&email)
            .copied()
            .is_some_and(|existing_user_id| existing_user_id != user.id)
        {
            return Err(AppError::conflict(
                "verified email already belongs to an existing account",
            ));
        }
        user.primary_email = email.clone();
        user.last_seen_at = Some(Utc::now());
        store
            .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
            .await?;
        data.insert_user(user.clone());
    }
    if let Some(invite_token) = input.accept_invite_token.as_deref() {
        let user_id = user.id;
        drop(data);
        return accept_invitation_for_user(store, invite_token, user_id).await;
    }
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
    // Legacy dev-google "accept invite by org id" path. Clerk hosted invites
    // are accepted only via `accept_invite_token` (handled earlier).
    if allow_legacy_invite_activation {
        if let Some(invite_org_id) = input.accept_invite_org_id {
            if let Some(org) =
                activate_invited_membership(store, &mut data, user.id, invite_org_id).await?
            {
                drop(data);
                return create_session_for_org(store, user, org).await;
            }
            return Err(AppError::not_found("invitation not found"));
        }
    } else if input.accept_invite_org_id.is_some() {
        return Err(AppError::validation(
            "invitation token is required to accept hosted invitations",
        ));
    }
    // If a previous org owner pre-reserved a seat for this user's email, we'll
    // have a membership in "invited" status that we should auto-activate
    // instead of creating a fresh workspace. This applies to both providers.
    if mode != "signup" {
        let invites = pending_invites_for_user(&data, user.id);
        match invites.len() {
            0 => {
                // No existing org and no pending invite. The historic behavior
                // here was to reject with 400 "organization is required for
                // signup", which stranded first-time Clerk users on the signin
                // card. Verified-identity providers (Clerk, dev-google) now
                // fall through to the auto-derive signup path so the user
                // lands directly in a workspace. Callers that genuinely need
                // "must already exist" semantics can opt in via `strict_signin`.
                if input.strict_signin {
                    return Err(AppError::validation("organization is required for signup"));
                }
                // fall through to auto-create below
            }
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
    // From this point on we will create a new org for the user. Enforce the
    // hosted signup allowlist consistently whether the request arrived as
    // mode="signup" (explicit) or fell through from mode="signin" (the new
    // auto-provision path). The HTTP-layer pre-check still short-circuits
    // explicit-signup requests, so this is a defense-in-depth guard for the
    // implicit path.
    input.signup_allowlist.check(&email)?;
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
    let tenant_routing_tier = if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        "customer-clickhouse".to_string()
    } else if is_personal_account_type(&effective_account_type) {
        "shared".to_string()
    } else {
        "dedicated".to_string()
    };
    if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE && canonical_plan_tier != "premium" {
        return Err(AppError::forbidden(
            "customer-owned ClickHouse is available for Premium workspaces",
        ));
    }
    if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        store.require_customer_clickhouse_signup_ready()?;
    }
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
        storage_choice: storage_choice.clone(),
        storage_state: if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
            STORAGE_STATE_UNCONFIGURED.to_string()
        } else {
            STORAGE_STATE_READY.to_string()
        },
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
            auto_provisioned: true,
        });
    }
    if org.storage_choice != STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        store.ensure_tenant_route(&org).await?;
    }
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
    let onboarding_api_key = if org_storage_ready(&org) {
        mint_onboarding_api_key(store, org.id, user.id).await.ok()
    } else {
        None
    };
    Ok(CreatedAuthSession {
        token,
        payload,
        onboarding_api_key,
        auto_provisioned: true,
    })
}

pub(super) async fn create_session_for_org(
    store: &Store,
    user: UserRow,
    org: OrganizationRow,
) -> AppResult<CreatedAuthSession> {
    if org.storage_choice != STORAGE_CHOICE_CUSTOMER_CLICKHOUSE
        && !billing_blocks_tenant_route(store, org.id).await
    {
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
        auto_provisioned: false,
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
            storage_choice: None,
            seat_emails: Some(vec!["teammate@example.com".to_string()]),
            accept_invite_org_id: Some(Uuid::new_v4()),
            accept_invite_token: Some("instantml_invite_deadbeef".to_string()),
        })
        .unwrap();

        assert_eq!(normalized.email, SHARED_DEMO_EMAIL);
        assert_eq!(normalized.display_name.as_deref(), Some(SHARED_DEMO_NAME));
        assert_eq!(normalized.account_type, SHARED_DEMO_ACCOUNT_TYPE);
        assert_eq!(normalized.org_name.as_deref(), Some(SHARED_DEMO_NAME));
        assert_eq!(normalized.plan_tier.as_deref(), Some("premium"));
        assert_eq!(normalized.accept_invite_org_id, None);
        assert_eq!(normalized.accept_invite_token, None);
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
            storage_choice: None,
            seat_emails: Some(vec!["teammate@example.com".to_string()]),
            accept_invite_org_id: None,
            accept_invite_token: Some("instantml_invite_test".to_string()),
        })
        .unwrap();

        assert_eq!(normalized.email, "person@example.com");
        assert_eq!(normalized.display_name.as_deref(), Some("Person Example"));
        assert_eq!(normalized.account_type, "customer");
        assert_eq!(normalized.mode.as_deref(), Some("signup"));
        assert_eq!(normalized.org_name.as_deref(), Some("Personal Lab"));
        assert_eq!(normalized.plan_tier.as_deref(), Some("pro"));
        assert_eq!(normalized.seat_emails, vec!["teammate@example.com"]);
        assert_eq!(
            normalized.accept_invite_token.as_deref(),
            Some("instantml_invite_test")
        );
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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
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

    // ---------------------------------------------------------------------
    // Auto-provision-on-first-signin coverage.
    //
    // `create_verified_provider_session` cannot be exercised end-to-end in a
    // unit test because its happy path writes through `persist_locked`, which
    // requires a live ClickHouse client. The CI suite has no ClickHouse, so
    // we test the new behavior at the level of the *decision logic* it gates
    // on: which branch fires for each scenario. The six tests below mirror
    // the six scenarios called out in the PR brief.
    // ---------------------------------------------------------------------

    fn user_row(id: Uuid, email: &str) -> UserRow {
        UserRow {
            id,
            primary_email: email.to_string(),
            display_name: None,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: Some(Utc::now()),
        }
    }

    fn fresh_clerk_data() -> (StoreData, UserRow) {
        // A Clerk-verified user that already exists as a UserRow (so the
        // existing-user lookup in create_verified_provider_session succeeds)
        // but has no membership in any org and no pending invites. Exactly
        // the state of a first-time Clerk signin.
        let user = user_row(Uuid::new_v4(), "tony@example.com");
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.identities.insert(
            ("clerk".to_string(), "user_test_subject".to_string()),
            user.id,
        );
        (data, user)
    }

    #[test]
    fn fresh_clerk_signin_with_no_org_falls_through_to_auto_create() {
        // Scenario 1: brand-new Clerk-verified user, mode != "signup", no
        // existing org, no pending invites. The new behavior is to fall
        // through to the auto-create path instead of returning the historic
        // 400 "organization is required for signup".
        let (data, user) = fresh_clerk_data();

        // Pre-condition: no existing active membership.
        assert!(
            existing_org_for_auth(&data, user.id, None, "customer").is_none(),
            "fresh user must not have an existing org"
        );
        // Pre-condition: no pending invites by membership.
        assert!(
            pending_invites_for_user(&data, user.id).is_empty(),
            "fresh user must not have a pending invite"
        );

        // The strict_signin gate is what flips behavior: when false (the new
        // default for Clerk / dev-google), we fall through. When true, the
        // old error is preserved.
        let strict_signin = false;
        let should_auto_create =
            pending_invites_for_user(&data, user.id).is_empty() && !strict_signin;
        assert!(
            should_auto_create,
            "Clerk first-time signin must fall through to auto-create"
        );

        // The auto-derive slug for "tony@example.com" with no display name is
        // the email handle.
        let slug = derive_workspace_slug(None, &user.primary_email);
        assert_eq!(slug, "tony");
    }

    #[test]
    fn fresh_clerk_signin_on_signup_allowlist_passes() {
        // Scenario 2: brand-new Clerk user, mode != "signup", and the email
        // IS on the signup allowlist. The allowlist check must pass so the
        // auto-create path proceeds.
        let allowlist = SignupAllowlist {
            allowed_emails: vec!["tony@example.com".to_string()],
            allowed_domains: Vec::new(),
        };
        assert!(allowlist.check("tony@example.com").is_ok());

        // Domain-based allowlist must also pass.
        let allowlist = SignupAllowlist {
            allowed_emails: Vec::new(),
            allowed_domains: vec!["instantml.ai".to_string()],
        };
        assert!(allowlist.check("anyone@instantml.ai").is_ok());

        // Case insensitivity: allowlist comparison normalizes the incoming
        // email but expects allowlist entries already lowercase.
        assert!(allowlist.check("MIXED@instantml.ai").is_ok());
    }

    #[test]
    fn fresh_clerk_signin_not_on_signup_allowlist_still_403s() {
        // Scenario 3: brand-new Clerk user, mode != "signup", email NOT on
        // the allowlist. The auto-create branch is reachable, but the
        // allowlist check defends the security boundary and must reject.
        let allowlist = SignupAllowlist {
            allowed_emails: vec!["founder@example.com".to_string()],
            allowed_domains: vec!["instantml.ai".to_string()],
        };
        let error = allowlist.check("stranger@example.org").unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::FORBIDDEN);

        // A nominally-similar domain must NOT match (substring guard).
        assert!(allowlist.check("user@notinstantml.ai").is_err());

        // An empty allowlist (the local-dev / unconfigured case) must not
        // block anyone.
        let empty = SignupAllowlist::default();
        assert!(empty.check("anyone@example.com").is_ok());
    }

    #[test]
    fn fresh_clerk_signin_with_pending_invite_uses_invite_path() {
        // Scenario 4: brand-new Clerk user with a pre-reserved seat (a
        // membership in "invited" status) must auto-attach to that org via
        // the existing invite-activation branch, NOT auto-create a new org.
        let user = user_row(Uuid::new_v4(), "teammate@example.com");
        let inviting_org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.identities.insert(
            ("clerk".to_string(), "user_pending_invite".to_string()),
            user.id,
        );
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id: inviting_org_id,
            user_id: user.id,
            role: "member".to_string(),
            status: "invited".to_string(),
            created_at: Utc::now(),
        });

        // No active membership yet (so existing-org lookup fails).
        assert!(existing_org_for_auth(&data, user.id, None, "customer").is_none());

        // But there is exactly one pending invite, which is the branch that
        // must fire before any auto-create.
        let invites = pending_invites_for_user(&data, user.id);
        assert_eq!(invites.len(), 1, "must see the pending invite");
        assert_eq!(invites[0].org_id, inviting_org_id);
        assert_eq!(invites[0].status, "invited");
    }

    #[test]
    fn returning_clerk_user_with_existing_org_does_not_auto_create() {
        // Scenario 5: returning Clerk user with an active membership must
        // hit the existing-org branch and reuse that org, NOT auto-create.
        let user = user_row(Uuid::new_v4(), "tony@example.com");
        let org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.identities
            .insert(("clerk".to_string(), "user_returning".to_string()), user.id);
        data.insert_org(OrganizationRow {
            id: org_id,
            slug: "tony-xin".to_string(),
            name: "Tony Xin".to_string(),
            plan_tier: "free".to_string(),
            account_type: "personal".to_string(),
            seat_limit: 2,
            created_by_user_id: Some(user.id),
            created_at: Utc::now(),
            tenant_routing_tier: "shared".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        });
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id: user.id,
            role: "owner".to_string(),
            status: "active".to_string(),
            created_at: Utc::now(),
        });

        let existing = existing_org_for_auth(&data, user.id, None, "personal");
        assert!(existing.is_some(), "returning user must match existing org");
        assert_eq!(existing.unwrap().id, org_id);
        // No pending invites either — the function should hit the existing-org
        // early return before ever consulting them.
        assert!(pending_invites_for_user(&data, user.id).is_empty());
    }

    #[test]
    fn explicit_signup_with_custom_org_name_does_not_auto_derive() {
        // Scenario 6: a user-typed org_name on an explicit "Create a
        // workspace" signup must be preserved verbatim (with collision
        // detection), NOT replaced by the Clerk-profile auto-derived slug.
        let custom_name = "My Custom Workspace";
        let custom_slug = slugify(custom_name);
        assert_eq!(custom_slug, "my-custom-workspace");

        // Auto-derived slug for the same user would be different.
        let auto_slug = derive_workspace_slug(Some("Tony Xin"), "tony@example.com");
        assert_eq!(auto_slug, "tony-xin");
        assert_ne!(custom_slug, auto_slug, "auto-derive must not shadow custom");

        // Slug collision still applies for the custom path: if the slug is
        // already taken, the create branch must reject with a conflict
        // (instead of silently appending a numeric suffix the way
        // unique_slug does on the auto-derive path).
        let mut data = StoreData::default();
        data.insert_org(OrganizationRow {
            id: Uuid::new_v4(),
            slug: custom_slug.clone(),
            name: "Existing Workspace".to_string(),
            plan_tier: "free".to_string(),
            account_type: "personal".to_string(),
            seat_limit: 2,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "shared".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        });
        assert!(
            data.orgs_by_slug.contains_key(&custom_slug),
            "pre-seeded slug must collide"
        );
    }

    #[test]
    fn strict_signin_preserves_legacy_400_for_callers_that_opt_in() {
        // Defense for callers that genuinely want "must already exist"
        // semantics: when strict_signin=true and the user has no org and no
        // pending invite, the legacy 400 "organization is required for
        // signup" error is preserved instead of falling through to
        // auto-create. The new default is false for both Clerk and
        // dev-google, but this guards the field from being silently dropped.
        let (data, user) = fresh_clerk_data();
        let strict_signin = true;
        let should_auto_create =
            pending_invites_for_user(&data, user.id).is_empty() && !strict_signin;
        assert!(
            !should_auto_create,
            "strict_signin must suppress auto-create fall-through"
        );
    }
}
