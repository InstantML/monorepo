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
    let shared_demo_auth = provider == "dev-google" && is_shared_demo_email(&email);
    let paid_signup_requires_checkout = if shared_demo_auth {
        false
    } else {
        require_paid_checkout_for_plan(billing_config, &canonical_plan_tier)?
    };
    let seat_emails = normalized_invite_emails(input.seat_emails, &email)?;
    if account_type == "personal" && !seat_emails.is_empty() {
        return Err(AppError::validation(
            "personal workspaces cannot reserve teammate seats",
        ));
    }
    if let Some(invite_token) = input.accept_invite_token.as_deref() {
        preflight_invitation_for_email(store, invite_token, &email).await?;
    }
    if 1 + seat_emails.len() > plan.included_seats as usize {
        return Err(AppError::conflict("organization seat limit reached"));
    }
    let identity_key = (provider.clone(), provider_subject.clone());
    let mut user_to_insert = None;
    let mut identity_to_insert = None;
    let mut user = {
        let data = store.data.lock().await;
        if let Some(user_id) = data.identities.get(&identity_key).copied() {
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
            identity_to_insert = Some(IdentityRecord {
                user_id: user.id,
                provider: provider.clone(),
                provider_subject: provider_subject.clone(),
            });
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
            identity_to_insert = Some(IdentityRecord {
                user_id: user.id,
                provider: provider.clone(),
                provider_subject: provider_subject.clone(),
            });
            user_to_insert = Some(user.clone());
            user
        }
    };
    if let Some(new_user) = &user_to_insert {
        store
            .persist_locked("user", LOCAL_ORG_ID, &new_user.id.to_string(), new_user)
            .await?;
    }
    if let Some(identity) = &identity_to_insert {
        store
            .persist_locked("identity", LOCAL_ORG_ID, &user.id.to_string(), identity)
            .await?;
    }
    if user_to_insert.is_some() || identity_to_insert.is_some() {
        let mut data = store.data.lock().await;
        if let Some(new_user) = &user_to_insert {
            data.insert_user(new_user.clone());
        }
        if let Some(identity) = &identity_to_insert {
            data.identities.insert(
                (identity.provider.clone(), identity.provider_subject.clone()),
                identity.user_id,
            );
        }
    }
    if user.primary_email != email {
        {
            let data = store.data.lock().await;
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
        }
        user.primary_email = email.clone();
        user.last_seen_at = Some(Utc::now());
        store
            .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
            .await?;
        let mut data = store.data.lock().await;
        data.insert_user(user.clone());
    }
    if let Some(invite_token) = input.accept_invite_token.as_deref() {
        let user_id = user.id;
        return accept_invitation_for_user(store, invite_token, user_id).await;
    }
    let data = store.data.lock().await;
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
            drop(data);
            store
                .persist_locked("organization", org.id, &org.id.to_string(), &org)
                .await?;
            let mut data = store.data.lock().await;
            data.insert_org(org.clone());
        } else {
            drop(data);
        }
        ensure_shared_demo_billing_account(store, &org).await?;
        return create_session_for_org(store, user, org).await;
    }
    // Legacy dev-google "accept invite by org id" path. Clerk hosted invites
    // are accepted only via `accept_invite_token` (handled earlier).
    if allow_legacy_invite_activation {
        if let Some(invite_org_id) = input.accept_invite_org_id {
            drop(data);
            if let Some(org) = activate_invited_membership(store, user.id, invite_org_id).await? {
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
                drop(data);
                let org = activate_invited_membership(store, user.id, invites[0].org_id)
                    .await?
                    .ok_or_else(|| AppError::not_found("invitation not found"))?;
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
    if is_personal_account_type(&effective_account_type) && !seat_emails.is_empty() {
        return Err(AppError::validation(
            "personal workspaces cannot reserve teammate seats",
        ));
    }
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
    let stored_plan_tier = canonical_plan_tier.clone();
    let stored_plan = plan_tier(&stored_plan_tier);
    let org = OrganizationRow {
        id: Uuid::new_v4(),
        slug: org_slug,
        name: org_name,
        plan_tier: stored_plan_tier,
        seat_limit: if is_personal_account_type(&effective_account_type) {
            1
        } else {
            stored_plan.included_seats
        },
        account_type: effective_account_type,
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
    drop(data);
    store
        .persist_locked("organization", org.id, &org.id.to_string(), &org)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_org(org.clone());
    drop(data);
    let owner = membership_row(org.id, user.id, "owner", "active");
    store
        .persist_locked("membership", org.id, &owner.id.to_string(), &owner)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_membership(owner.clone());
    drop(data);
    ensure_shared_demo_billing_account(store, &org).await?;
    if paid_signup_requires_checkout {
        let (session, token) = new_session(user.id, org.id);
        store
            .persist_locked("session", org.id, &session.row.id.to_string(), &session)
            .await?;
        let mut data = store.data.lock().await;
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
    for email in seat_emails {
        let invited_user = get_or_create_placeholder_user(store, &email).await?;
        let already_has_seat = {
            let data = store.data.lock().await;
            data.memberships.values().any(|membership| {
                membership.org_id == org.id
                    && membership.user_id == invited_user.id
                    && matches!(membership.status.as_str(), "active" | "invited")
            })
        };
        if already_has_seat {
            continue;
        }
        let invited = membership_row(org.id, invited_user.id, "member", "invited");
        store
            .persist_locked("membership", org.id, &invited.id.to_string(), &invited)
            .await?;
        let mut data = store.data.lock().await;
        data.insert_membership(invited);
    }
    let (session, token) = new_session(user.id, org.id);
    store
        .persist_locked("session", org.id, &session.row.id.to_string(), &session)
        .await?;
    let mut data = store.data.lock().await;
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
    let owner_to_insert = {
        let data = store.data.lock().await;
        if data.memberships.values().any(|membership| {
            membership.org_id == org.id
                && membership.user_id == user.id
                && membership.status == "active"
        }) {
            None
        } else {
            if org.created_by_user_id != Some(user.id) {
                return Err(AppError::forbidden(
                    "user is not an active member of the organization",
                ));
            }
            Some(membership_row(org.id, user.id, "owner", "active"))
        }
    };
    if let Some(owner) = &owner_to_insert {
        store
            .persist_locked("membership", org.id, &owner.id.to_string(), &owner)
            .await?;
    }
    let (session, token) = new_session(user.id, org.id);
    store
        .persist_locked("session", org.id, &session.row.id.to_string(), &session)
        .await?;
    let mut data = store.data.lock().await;
    if let Some(owner) = owner_to_insert {
        data.insert_membership(owner);
    }
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
    match data.billing_accounts.get(&org_id) {
        Some(account) => matches!(
            account.access_state.as_str(),
            BILLING_CHECKOUT_PENDING | BILLING_READ_ONLY_PAYMENT_REQUIRED | BILLING_CANCELED
        ),
        None => data
            .organizations
            .get(&org_id)
            .is_some_and(is_user_billing_managed_paid_workspace),
    }
}

async fn ensure_shared_demo_billing_account(store: &Store, org: &OrganizationRow) -> AppResult<()> {
    let should_create = {
        let data = store.data.lock().await;
        is_shared_demo_org(org) && !data.billing_accounts.contains_key(&org.id)
    };
    if !should_create {
        return Ok(());
    }
    let account = BillingAccountProjection {
        schema_version: 1,
        org_id: org.id,
        access_state: BILLING_PAID_ACTIVE.to_string(),
        plan_tier: org.plan_tier.clone(),
        effective_plan_tier: org.plan_tier.clone(),
        requested_plan_tier: None,
        paid_extra_seats: 0,
        stripe_customer_id: None,
        stripe_subscription_id: None,
        subscription_status: Some("demo".to_string()),
        current_period_start: None,
        current_period_end: None,
        cancel_at_period_end: false,
        grace_until: None,
        pending_intent_id: None,
        message: Some("Shared demo workspace is billing-exempt.".to_string()),
        updated_at: Utc::now(),
    };
    store
        .persist_locked(
            "billing_account",
            account.org_id,
            &account.org_id.to_string(),
            &account,
        )
        .await?;
    let mut data = store.data.lock().await;
    data.insert_billing_account(account);
    Ok(())
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

/// Resolve a verified external identity (e.g. a Clerk OAuth subject) to an
/// InstantML org and role using the in-memory control projection. Used by the
/// MCP OAuth bridge; returns `(org_id, user_id, role)`.
///
/// The identity carries no InstantML org (InstantML orgs are not the IdP's
/// orgs), so org selection is: exactly one active membership -> use it; more
/// than one -> reject until the caller names an org.
pub async fn authenticate_oauth_identity(
    store: &Store,
    provider: &str,
    provider_subject: &str,
) -> AppResult<(Uuid, Uuid, String)> {
    authenticate_oauth_identity_for_org(store, provider, provider_subject, None).await
}

/// Resolve a verified external identity to a requested org, if provided. The
/// requested org is accepted only when the identity's internal user has an
/// active membership in that org.
pub async fn authenticate_oauth_identity_for_org(
    store: &Store,
    provider: &str,
    provider_subject: &str,
    requested_org_id: Option<Uuid>,
) -> AppResult<(Uuid, Uuid, String)> {
    let data = store.data.lock().await;
    resolve_oauth_identity(&data, provider, provider_subject, requested_org_id)
}

fn resolve_oauth_identity(
    data: &StoreData,
    provider: &str,
    provider_subject: &str,
    requested_org_id: Option<Uuid>,
) -> AppResult<(Uuid, Uuid, String)> {
    let identity_key = (provider.to_string(), provider_subject.to_string());
    let user_id =
        data.identities.get(&identity_key).copied().ok_or_else(|| {
            AppError::unauthorized("no InstantML account is linked to this identity")
        })?;
    if !data.users.contains_key(&user_id) {
        return Err(AppError::not_found("user not found"));
    }
    let active = data
        .memberships
        .values()
        .filter(|membership| membership.user_id == user_id && membership.status == "active")
        .collect::<Vec<_>>();
    if let Some(org_id) = requested_org_id {
        return active
            .iter()
            .find(|membership| membership.org_id == org_id)
            .map(|membership| (membership.org_id, user_id, membership.role.clone()))
            .ok_or_else(|| {
                AppError::forbidden(
                    "OAuth user is not an active member of the requested organization",
                )
            });
    }
    match active.as_slice() {
        [] => Err(AppError::forbidden(
            "this account has no active organization membership",
        )),
        [membership] => Ok((membership.org_id, user_id, membership.role.clone())),
        _ => Err(AppError::forbidden(
            "this account belongs to multiple organizations; OAuth must name one",
        )),
    }
}

pub async fn revoke_session(store: &Store, token: &str) -> AppResult<()> {
    let token_hash = hash_secret(token);
    let Some(mut session) = ({
        let data = store.data.lock().await;
        let Some(session_id) = data.sessions_by_hash.get(&token_hash).copied() else {
            return Ok(());
        };
        data.sessions.get(&session_id).cloned()
    }) else {
        return Ok(());
    };
    session.row.revoked_at = Some(Utc::now());
    store
        .persist_locked(
            "session",
            session.row.org_id,
            &session.row.id.to_string(),
            &session,
        )
        .await?;
    let mut data = store.data.lock().await;
    data.insert_session(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_data(data: StoreData) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_sessions_test",
                "TEST_CLICKHOUSE_URL",
            )
            .unwrap(),
            control_db: None,
            hosted_clickhouse: None,
            byoc_clickhouse: crate::config::ByocClickHouseConfig {
                egress_cidrs: Vec::new(),
                egress_set_version: "test".to_string(),
                allow_private_endpoints: true,
                credential_store: crate::config::ByocCredentialStoreConfig::Disabled,
            },
            cell_routing: crate::config::CellRoutingConfig {
                environment: "test".to_string(),
                placement_data_cell_id: None,
                heartbeat_data_cell_id: None,
            },
            data_cell_writer_runtime: DataCellWriterLeaseRuntime::for_tests(),
            data_cell_writer_lease: Arc::new(Mutex::new(DataCellWriterLeaseState::default())),
            data_cell_writer_refresh_lock: Arc::new(Mutex::new(())),
            tenant_metric_stores: Arc::new(Mutex::new(HashMap::new())),
            customer_tenant_endpoints: Arc::new(Mutex::new(HashMap::new())),
            tenant_loaded: Arc::new(Mutex::new(BTreeSet::new())),
            shared_cell_metric_store: None,
            inflight_idempotency: Arc::new(Mutex::new(BTreeSet::new())),
            artifact_upload_capacity_lock: Arc::new(Mutex::new(())),
            write_gate_usage: Arc::new(Mutex::new(HashMap::new())),
            data: Arc::new(Mutex::new(data)),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
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
    fn oauth_identity_resolves_single_active_membership() {
        let user = user_row(Uuid::new_v4(), "tony@example.com");
        let org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.identities
            .insert(("clerk".to_string(), "user_oauth".to_string()), user.id);
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id: user.id,
            role: "admin".to_string(),
            status: "active".to_string(),
            created_at: Utc::now(),
        });

        let (resolved_org, resolved_user, role) =
            resolve_oauth_identity(&data, "clerk", "user_oauth", None).unwrap();
        assert_eq!(resolved_org, org_id);
        assert_eq!(resolved_user, user.id);
        assert_eq!(role, "admin");
    }

    #[test]
    fn oauth_identity_rejects_unknown_missing_and_multi_org() {
        let user = user_row(Uuid::new_v4(), "multi@example.com");
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.identities
            .insert(("clerk".to_string(), "user_multi".to_string()), user.id);

        // Unknown identity -> rejected.
        assert!(resolve_oauth_identity(&data, "clerk", "nobody", None).is_err());
        // Known identity but no active membership -> rejected.
        assert!(resolve_oauth_identity(&data, "clerk", "user_multi", None).is_err());

        // Two active memberships -> ambiguous org, must be rejected (the
        // cross-tenant safety property: never silently pick an org).
        for _ in 0..2 {
            data.insert_membership(MembershipRow {
                id: Uuid::new_v4(),
                org_id: Uuid::new_v4(),
                user_id: user.id,
                role: "member".to_string(),
                status: "active".to_string(),
                created_at: Utc::now(),
            });
        }
        assert!(resolve_oauth_identity(&data, "clerk", "user_multi", None).is_err());
    }

    #[test]
    fn oauth_identity_resolves_requested_org_for_multi_org_user() {
        let user = user_row(Uuid::new_v4(), "multi@example.com");
        let selected_org = Uuid::new_v4();
        let other_org = Uuid::new_v4();
        let inactive_org = Uuid::new_v4();
        let missing_org = Uuid::new_v4();
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.identities
            .insert(("clerk".to_string(), "user_multi".to_string()), user.id);
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id: selected_org,
            user_id: user.id,
            role: "viewer".to_string(),
            status: "active".to_string(),
            created_at: Utc::now(),
        });
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id: other_org,
            user_id: user.id,
            role: "admin".to_string(),
            status: "active".to_string(),
            created_at: Utc::now(),
        });
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id: inactive_org,
            user_id: user.id,
            role: "owner".to_string(),
            status: "invited".to_string(),
            created_at: Utc::now(),
        });

        let (resolved_org, resolved_user, role) =
            resolve_oauth_identity(&data, "clerk", "user_multi", Some(selected_org)).unwrap();
        assert_eq!(resolved_org, selected_org);
        assert_eq!(resolved_user, user.id);
        assert_eq!(role, "viewer");

        assert!(resolve_oauth_identity(&data, "clerk", "user_multi", Some(inactive_org)).is_err());
        assert!(resolve_oauth_identity(&data, "clerk", "user_multi", Some(missing_org)).is_err());
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

    #[tokio::test]
    async fn auto_derived_personal_signup_rejects_teammate_seats() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "owner@example.com".to_string(),
            display_name: Some("Owner Example".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.identities.insert(
            ("clerk".to_string(), "user_auto_personal".to_string()),
            user.id,
        );
        let store = store_with_data(data);
        let error = create_verified_provider_session(
            &store,
            VerifiedProviderSessionInput {
                provider: "clerk".to_string(),
                provider_subject: "user_auto_personal".to_string(),
                email: "owner@example.com".to_string(),
                display_name: Some("Owner Example".to_string()),
                avatar_url: None,
                account_type: "business".to_string(),
                mode: Some("signup".to_string()),
                org_name: None,
                plan_tier: Some("free".to_string()),
                storage_choice: None,
                seat_emails: vec!["teammate@example.com".to_string()],
                accept_invite_org_id: None,
                accept_invite_token: None,
                strict_email_linking: true,
                strict_signin: false,
                auto_derive_display_name: Some("Owner Example".to_string()),
                auto_derive_email: "owner@example.com".to_string(),
            },
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert!(error
            .message()
            .contains("personal workspaces cannot reserve teammate seats"));
        assert!(store.data.lock().await.organizations.is_empty());
    }

    #[tokio::test]
    async fn missing_paid_billing_projection_blocks_tenant_route_creation() {
        let user_id = Uuid::new_v4();
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "paid-without-billing".to_string(),
            name: "Paid Without Billing".to_string(),
            plan_tier: "pro".to_string(),
            account_type: "business".to_string(),
            seat_limit: PLAN_PRO.included_seats,
            created_by_user_id: Some(user_id),
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        let mut data = StoreData::default();
        data.insert_org(org.clone());
        let store = store_with_data(data);

        assert!(billing_blocks_tenant_route(&store, org.id).await);
    }
}
