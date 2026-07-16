use super::super::*;
use super::helpers::*;
use super::invitations::create_org_invitation;
use super::sessions::create_session_for_org;
use crate::config::{BillingConfig, EmailConfig, EmailProvider};

#[derive(Clone, Debug)]
pub struct CreatedCurrentUserOrganization {
    pub response: CurrentUserOrganizationCreateResponse,
    pub token: Option<String>,
}

#[derive(Clone, Debug)]
struct NormalizedInitialInvitation {
    email: String,
    role: String,
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
    let storage_choice = validate_storage_choice(input.storage_choice.as_deref())?;
    if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE && canonical_plan_tier != "premium" {
        return Err(AppError::forbidden(
            "customer-owned ClickHouse is available for Premium workspaces",
        ));
    }
    if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        store.require_customer_clickhouse_signup_ready()?;
    }
    let plan = plan_tier(&canonical_plan_tier);
    let account_type = "customer".to_string();
    let tenant_routing_tier = if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        "customer-clickhouse".to_string()
    } else if is_personal_account_type(&account_type) {
        "shared".to_string()
    } else {
        "dedicated".to_string()
    };
    let org = OrganizationRow {
        id: Uuid::new_v4(),
        slug,
        name,
        plan_tier: canonical_plan_tier,
        account_type,
        seat_limit: plan.included_seats,
        created_by_user_id: input.owner_user_id,
        created_at: Utc::now(),
        tenant_routing_tier,
        storage_choice: storage_choice.clone(),
        storage_state: if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
            STORAGE_STATE_UNCONFIGURED.to_string()
        } else {
            STORAGE_STATE_READY.to_string()
        },
    };
    let owner_membership = input
        .owner_user_id
        .map(|owner_id| membership_row(org.id, owner_id, "owner", "active"));

    if let Some(control_db) = store.control_db() {
        // Postgres is the authority: the org and its owner membership commit in
        // a single transaction, so a crash can never leave an org without an
        // owner, and the slug `UNIQUE` constraint rejects a concurrent duplicate.
        if let Some(owner_id) = input.owner_user_id {
            if control_db.get_user(owner_id).await?.is_none() {
                return Err(AppError::not_found("owner user not found"));
            }
        }
        control_db
            .create_org_with_owner(&org, owner_membership.as_ref())
            .await?;
        let mut data = store.data.lock().await;
        data.insert_org(org.clone());
        if let Some(membership) = &owner_membership {
            data.insert_membership(membership.clone());
        }
    } else {
        {
            let data = store.data.lock().await;
            if data.orgs_by_slug.contains_key(&org.slug) {
                return Err(AppError::conflict("organization already exists"));
            }
            if let Some(owner_id) = input.owner_user_id {
                if !data.users.contains_key(&owner_id) {
                    return Err(AppError::not_found("owner user not found"));
                }
            }
        }
        store
            .persist_locked("organization", org.id, &org.id.to_string(), &org)
            .await?;
        if let Some(membership) = &owner_membership {
            store
                .persist_locked("membership", org.id, &membership.id.to_string(), membership)
                .await?;
        }
        let mut data = store.data.lock().await;
        data.insert_org(org.clone());
        if let Some(membership) = &owner_membership {
            data.insert_membership(membership.clone());
        }
    }

    if org.storage_choice != STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        store.ensure_tenant_route(&org).await?;
    }
    Ok(org)
}

pub async fn create_current_user_organization(
    store: &Store,
    user_id: Uuid,
    current_org_id: Uuid,
    input: CreateCurrentUserOrganizationRequest,
    billing_config: &BillingConfig,
    email_config: &EmailConfig,
) -> AppResult<CreatedCurrentUserOrganization> {
    let name = validate_name(input.name.as_deref(), "organization name")?;
    let slug = slugify(&name);
    let account_type = validate_account_type(input.account_type.as_deref().or(Some("business")))?;
    if account_type == "customer" {
        return Err(AppError::validation(
            "account_type must be one of: business, personal",
        ));
    }
    let plan_id = validate_plan_tier(input.plan_tier.as_deref())?;
    let plan = plan_tier(&plan_id);
    let storage_choice = validate_storage_choice(input.storage_choice.as_deref())?;
    if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE && plan_id != "premium" {
        return Err(AppError::forbidden(
            "customer-owned ClickHouse is available for Premium workspaces",
        ));
    }
    if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        store.require_customer_clickhouse_signup_ready()?;
    }
    let switch_on_create = input.switch_on_create.unwrap_or(true);
    let initial_invitations =
        normalize_initial_invitations(input.initial_invitations.unwrap_or_default())?;
    if account_type == "personal" && !initial_invitations.is_empty() {
        return Err(AppError::validation(
            "personal workspaces cannot invite teammates; create an organization workspace instead",
        ));
    }
    let paid_checkout_required = require_paid_checkout_for_plan(Some(billing_config), plan.id)?;
    if paid_checkout_required && !initial_invitations.is_empty() {
        return Err(AppError::validation(
            "initial invitations for paid workspaces can be sent after checkout completes",
        ));
    }
    if 1 + initial_invitations.len() > plan.included_seats.max(0) as usize {
        return Err(AppError::conflict("organization seat limit reached"));
    }
    if !initial_invitations.is_empty() && matches!(email_config.provider, EmailProvider::Disabled) {
        return Err(AppError::with_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "email_delivery_unavailable",
            "email delivery is not configured",
        ));
    }

    // Validate against the projection and build the org/owner; then, when
    // Postgres is the authority, commit them in one transaction *without*
    // holding the StoreData lock across the network round trip (per the
    // multi-instance guidance). Clone the captured strings so this can run in
    // either branch.
    let build = |data: &StoreData| -> AppResult<(UserRow, OrganizationRow, MembershipRow)> {
        let user = data
            .users
            .get(&user_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("user not found"))?;
        if data.orgs_by_slug.contains_key(&slug) {
            return Err(AppError::conflict("organization already exists"));
        }
        if account_type == "personal" && user_has_personal_workspace(data, user_id) {
            return Err(AppError::conflict(
                "personal workspace already exists for this user",
            ));
        }
        if initial_invitations
            .iter()
            .any(|invitation| invitation.email.eq_ignore_ascii_case(&user.primary_email))
        {
            return Err(AppError::conflict(
                "workspace owner cannot be invited to the same workspace",
            ));
        }
        let stored_plan = plan_tier(plan.id);
        let tenant_routing_tier = if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
            "customer-clickhouse".to_string()
        } else if is_personal_account_type(&account_type) {
            "shared".to_string()
        } else {
            "dedicated".to_string()
        };
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: slug.clone(),
            name: name.clone(),
            plan_tier: stored_plan.id.to_string(),
            account_type: account_type.clone(),
            seat_limit: if account_type == "personal" {
                1
            } else {
                stored_plan.included_seats
            },
            created_by_user_id: Some(user_id),
            created_at: Utc::now(),
            tenant_routing_tier,
            storage_choice: storage_choice.clone(),
            storage_state: if storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
                STORAGE_STATE_UNCONFIGURED.to_string()
            } else {
                STORAGE_STATE_READY.to_string()
            },
        };
        let owner = membership_row(org.id, user_id, "owner", "active");
        Ok((user, org, owner))
    };

    let (org, owner, user) = if let Some(control_db) = store.control_db() {
        let (user, org, owner) = {
            let data = store.data.lock().await;
            build(&data)?
        };
        // Atomic org + owner membership, with the lock released. A crash can't
        // strand an org without its owner, and the slug `UNIQUE` constraint
        // rejects a concurrent duplicate, so the validate→commit gap is safe.
        control_db.create_org_with_owner(&org, Some(&owner)).await?;
        let mut data = store.data.lock().await;
        data.insert_org(org.clone());
        data.insert_membership(owner.clone());
        (org, owner, user)
    } else {
        let (user, org, owner) = {
            let data = store.data.lock().await;
            build(&data)?
        };
        store
            .persist_locked("organization", org.id, &org.id.to_string(), &org)
            .await?;
        store
            .persist_locked("membership", org.id, &owner.id.to_string(), &owner)
            .await?;
        let mut data = store.data.lock().await;
        data.insert_org(org.clone());
        data.insert_membership(owner.clone());
        (org, owner, user)
    };

    let mut created_invitations = Vec::new();
    let billing_checkout = if paid_checkout_required {
        Some(
            create_checkout_for_org(
                store,
                billing_config,
                org.id,
                user_id,
                plan.id,
                "new_org",
                Vec::new(),
            )
            .await?,
        )
    } else {
        if org.storage_choice != STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
            if let Err(error) = store.ensure_tenant_route(&org).await {
                let _ = abandon_current_user_org_create(store, &org, &owner).await;
                return Err(error);
            }
        }
        for invitation in &initial_invitations {
            let outcome = create_org_invitation(
                store,
                Some(user_id),
                org.id,
                CreateInvitationRequest {
                    email: Some(invitation.email.clone()),
                    role: Some(invitation.role.clone()),
                },
                email_config,
            )
            .await?;
            created_invitations.push(InitialInvitationCreateResult {
                invitation: outcome.invitation,
                preview_link: outcome.preview_link,
                delivery_error: outcome.delivery_error,
            });
        }
        None
    };

    let (session, token, active_org_id) = if switch_on_create {
        let created = create_session_for_org(store, user, org.clone()).await?;
        (Some(created.payload), Some(created.token), org.id)
    } else {
        (None, None, current_org_id)
    };
    let memberships = list_user_org_memberships(store, user_id, active_org_id).await?;
    Ok(CreatedCurrentUserOrganization {
        response: CurrentUserOrganizationCreateResponse {
            organization: org,
            membership: owner,
            memberships,
            invitations: created_invitations,
            session,
            billing_checkout,
            onboarding_api_key: None,
        },
        token,
    })
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

async fn abandon_current_user_org_create(
    store: &Store,
    org: &OrganizationRow,
    owner: &MembershipRow,
) -> AppResult<()> {
    let mut abandoned_org = org.clone();
    abandoned_org.slug = format!("failed-{}", org.id);
    abandoned_org.created_by_user_id = None;
    abandoned_org.storage_state = STORAGE_STATE_UNCONFIGURED.to_string();

    let mut revoked_owner = owner.clone();
    revoked_owner.status = "revoked".to_string();

    store
        .persist_locked(
            "organization",
            abandoned_org.id,
            &abandoned_org.id.to_string(),
            &abandoned_org,
        )
        .await?;
    store
        .persist_locked(
            "membership",
            revoked_owner.org_id,
            &revoked_owner.id.to_string(),
            &revoked_owner,
        )
        .await?;
    let mut data = store.data.lock().await;
    data.insert_org(abandoned_org);
    data.insert_membership(revoked_owner);
    Ok(())
}

fn normalize_initial_invitations(
    raw: Vec<InitialOrganizationInvitation>,
) -> AppResult<Vec<NormalizedInitialInvitation>> {
    let mut seen = BTreeSet::new();
    let mut invitations = Vec::new();
    for invitation in raw {
        let email = validate_email(Some(&invitation.email))?;
        if !seen.insert(email.clone()) {
            continue;
        }
        let role = validate_membership_role(invitation.role.as_deref().or(Some("member")))?;
        if role == "owner" {
            return Err(AppError::validation(
                "initial invitations can use admin, member, or viewer roles",
            ));
        }
        invitations.push(NormalizedInitialInvitation { email, role });
    }
    Ok(invitations)
}

fn user_has_personal_workspace(data: &StoreData, user_id: Uuid) -> bool {
    data.organizations.values().any(|org| {
        is_personal_account_type(&org.account_type)
            && (org.created_by_user_id == Some(user_id)
                || data.memberships.values().any(|membership| {
                    membership.org_id == org.id
                        && membership.user_id == user_id
                        && membership.role == "owner"
                        && membership.status == "active"
                }))
    })
}

pub fn is_shared_demo_org(org: &OrganizationRow) -> bool {
    org.name == SHARED_DEMO_NAME && org.slug == slugify(SHARED_DEMO_NAME)
}

/// Pure projection that the async list-memberships handler delegates to.
///
/// Extracted so tests can exercise the filter + sort + member-count logic
/// against a hand-built `StoreData` without spinning up a `Store`.
pub(super) fn collect_user_org_memberships(
    data: &StoreData,
    user_id: Uuid,
    current_org_id: Uuid,
) -> Vec<OrganizationMembershipSummary> {
    let mut summaries: Vec<OrganizationMembershipSummary> = data
        .memberships
        .values()
        .filter(|membership| membership.user_id == user_id && membership.status == "active")
        .filter_map(|membership| {
            let org = data.organizations.get(&membership.org_id)?;
            let member_count = data
                .memberships
                .values()
                .filter(|m| m.org_id == membership.org_id && m.status == "active")
                .count();
            Some(OrganizationMembershipSummary {
                org_id: org.id,
                name: org.name.clone(),
                slug: org.slug.clone(),
                account_type: org.account_type.clone(),
                is_personal: is_personal_account_type(&org.account_type),
                plan_tier: org.plan_tier.clone(),
                role: membership.role.clone(),
                role_label: membership_role_label(&membership.role).to_string(),
                status: membership.status.clone(),
                member_count,
                is_current: org.id == current_org_id,
                capabilities: membership_role_capabilities(&membership.role),
            })
        })
        .collect();
    // Stable order: current org first, then alphabetical by name. Keeps the
    // dropdown deterministic across reloads and across users.
    summaries.sort_by(|a, b| match (a.is_current, b.is_current) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    summaries
}

/// List the active orgs a user belongs to, decorated with role + member count.
///
/// Used by the dashboard org-switcher to populate the dropdown. Filters to
/// `status == "active"` memberships only — invited-but-not-accepted seats
/// should not appear as switch targets.
pub async fn list_user_org_memberships(
    store: &Store,
    user_id: Uuid,
    current_org_id: Uuid,
) -> AppResult<Vec<OrganizationMembershipSummary>> {
    let data = store.data.lock().await;
    Ok(collect_user_org_memberships(&data, user_id, current_org_id))
}

pub fn membership_role_label(role: &str) -> &'static str {
    match role {
        "owner" => "Owner",
        "admin" => "Admin",
        "member" => "Write/read",
        "viewer" => "Read only",
        _ => "Unknown",
    }
}

pub fn membership_role_capabilities(role: &str) -> OrganizationRoleCapabilities {
    let admin = matches!(role, "owner" | "admin");
    let write_runs = matches!(role, "owner" | "admin" | "member");
    OrganizationRoleCapabilities {
        manage_billing: admin,
        manage_members: admin,
        write_runs,
        manage_api_keys: admin,
    }
}

/// Pure authorization gate for the switch-organization handler.
///
/// Verifies the session row is live (not revoked / expired) and that the user
/// has an *active* membership in the target org. Extracted so tests can pin
/// the membership-check semantics without standing up persistence.
pub(super) fn validate_session_org_switch(
    data: &StoreData,
    session: &UserSessionRow,
    target_org_id: Uuid,
) -> AppResult<()> {
    if session.revoked_at.is_some() || session.expires_at <= Utc::now() {
        return Err(AppError::unauthorized("invalid session"));
    }
    if !data.organizations.contains_key(&target_org_id) {
        return Err(AppError::not_found("organization not found"));
    }
    let has_active_membership = data.memberships.values().any(|membership| {
        membership.user_id == session.user_id
            && membership.org_id == target_org_id
            && membership.status == "active"
    });
    if !has_active_membership {
        return Err(AppError::forbidden(
            "no active membership in target organization",
        ));
    }
    Ok(())
}

/// Switch a browser session to a different org the user belongs to.
///
/// The switch mints a fresh session token for the target org and revokes the
/// previous session row. Returning a new cookie avoids stale split-plane session
/// bindings while preserving the route's JSON payload shape for callers.
pub async fn switch_session_organization(
    store: &Store,
    token: &str,
    target_org_id: Uuid,
) -> AppResult<CreatedAuthSession> {
    let token_hash = hash_secret(token);
    let session = {
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
        validate_session_org_switch(&data, &session.row, target_org_id)?;
        if session.row.org_id == target_org_id {
            let mut row = session.row.clone();
            row.last_seen_at = Some(Utc::now());
            let payload = session_payload_from_data(&data, row)?;
            return Ok(CreatedAuthSession {
                token: token.to_string(),
                payload,
                onboarding_api_key: None,
                auto_provisioned: false,
            });
        }
        session
    };

    let (new_session, new_token) = new_session(session.row.user_id, target_org_id);
    let mut revoked = session.clone();
    revoked.row.revoked_at = Some(Utc::now());
    revoked.row.last_seen_at = Some(Utc::now());

    store
        .persist_locked(
            "session",
            target_org_id,
            &new_session.row.id.to_string(),
            &new_session,
        )
        .await?;
    store
        .persist_locked(
            "session",
            revoked.row.org_id,
            &revoked.row.id.to_string(),
            &revoked,
        )
        .await?;
    let mut data = store.data.lock().await;
    data.insert_session(new_session.clone());
    data.insert_session(revoked);
    let payload = session_payload_from_data(&data, new_session.row)?;
    Ok(CreatedAuthSession {
        token: new_token,
        payload,
        onboarding_api_key: None,
        auto_provisioned: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn org_fixture(name: &str, slug: &str) -> OrganizationRow {
        OrganizationRow {
            id: Uuid::new_v4(),
            slug: slug.to_string(),
            name: name.to_string(),
            plan_tier: "free".to_string(),
            account_type: "customer".to_string(),
            seat_limit: 5,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        }
    }

    fn live_session(user_id: Uuid, org_id: Uuid) -> UserSessionRow {
        UserSessionRow {
            id: Uuid::new_v4(),
            user_id,
            org_id,
            metadata: json!({}),
            created_at: Utc::now(),
            last_seen_at: Some(Utc::now()),
            expires_at: Utc::now() + ChronoDuration::days(SESSION_TTL_DAYS),
            revoked_at: None,
        }
    }

    fn store_with_data(data: StoreData) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_orgs_test",
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
            trace_ingest_capacity_locks: Arc::new(Mutex::new(HashMap::new())),
            project_create_locks: Arc::new(Mutex::new(HashMap::new())),
            artifact_upload_capacity_lock: Arc::new(Mutex::new(())),
            write_gate_usage: Arc::new(Mutex::new(HashMap::new())),
            data: Arc::new(Mutex::new(data)),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
    }

    fn hosted_store_with_data(data: StoreData) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_orgs_test",
                "TEST_CLICKHOUSE_URL",
            )
            .unwrap(),
            control_db: None,
            hosted_clickhouse: Some(crate::config::HostedClickHouseConfig {
                tenant_base_url: "http://default:@127.0.0.1:9/instantml_tenant_route_failure"
                    .to_string(),
                provisioner: crate::config::ClickHouseProvisioner::Database,
                allow_stored_tenant_passwords: false,
                cloud: None,
                shared_cell_url: None,
            }),
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
            trace_ingest_capacity_locks: Arc::new(Mutex::new(HashMap::new())),
            project_create_locks: Arc::new(Mutex::new(HashMap::new())),
            artifact_upload_capacity_lock: Arc::new(Mutex::new(())),
            write_gate_usage: Arc::new(Mutex::new(HashMap::new())),
            data: Arc::new(Mutex::new(data)),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
    }

    fn email_config() -> EmailConfig {
        EmailConfig {
            provider: EmailProvider::Log,
            from: "InstantML <invites@instantml.ai>".to_string(),
            reply_to: None,
            frontend_base_url: "http://localhost:3000".to_string(),
            resend_api_key: None,
        }
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
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };

        assert!(is_shared_demo_org(&org));

        let mut renamed = org;
        renamed.name = "Customer Demo".to_string();
        assert!(!is_shared_demo_org(&renamed));
    }

    #[test]
    fn personal_account_type_routes_to_shared_tier() {
        // "personal" and "customer" both map to the shared cell.
        assert!(is_personal_account_type("personal"));
        assert!(is_personal_account_type("customer"));
        assert!(!is_personal_account_type("business"));
    }

    #[test]
    fn org_routing_tier_defaults_to_dedicated_for_pre_existing_records() {
        // An OrganizationRow deserialized from JSON without tenant_routing_tier
        // must default to "dedicated" so existing orgs keep their dedicated routes.
        let json = r#"{
            "id": "00000000-0000-0000-0000-000000000001",
            "slug": "legacy",
            "name": "Legacy Org",
            "plan_tier": "free",
            "account_type": "customer",
            "seat_limit": 2,
            "created_by_user_id": null,
            "created_at": "2026-01-01T00:00:00Z"
        }"#;
        let org: OrganizationRow = serde_json::from_str(json).unwrap();
        assert_eq!(org.tenant_routing_tier, "dedicated");
        assert_eq!(org.storage_choice, STORAGE_CHOICE_HOSTED);
        assert_eq!(org.storage_state, STORAGE_STATE_READY);
    }

    #[test]
    fn new_personal_org_row_has_shared_routing_tier() {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "my-lab".to_string(),
            name: "My Lab".to_string(),
            plan_tier: "free".to_string(),
            account_type: "personal".to_string(),
            seat_limit: 2,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "shared".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        assert_eq!(org.tenant_routing_tier, "shared");
    }

    #[test]
    fn new_business_org_row_has_dedicated_routing_tier() {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "acme".to_string(),
            name: "Acme Corp".to_string(),
            plan_tier: "pro".to_string(),
            account_type: "business".to_string(),
            seat_limit: 3,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        assert_eq!(org.tenant_routing_tier, "dedicated");
    }

    #[test]
    fn list_user_org_memberships_filters_out_invited_seats() {
        // A user with one active membership in `acme` and one invited-only
        // seat in `beta` should only see acme in the switcher dropdown —
        // invited seats are not switch targets until the invite is accepted.
        let user_id = Uuid::new_v4();
        let other_user = Uuid::new_v4();
        let acme = org_fixture("Acme", "acme");
        let beta = org_fixture("Beta", "beta");
        let mut data = StoreData::default();
        data.insert_org(acme.clone());
        data.insert_org(beta.clone());
        data.insert_membership(membership_row(acme.id, user_id, "admin", "active"));
        data.insert_membership(membership_row(beta.id, user_id, "member", "invited"));
        data.insert_membership(membership_row(acme.id, other_user, "owner", "active"));

        let summaries = collect_user_org_memberships(&data, user_id, acme.id);
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].name, "Acme");
        assert!(summaries[0].is_current);
        assert_eq!(summaries[0].role, "admin");
        // member_count counts active memberships across all users.
        assert_eq!(summaries[0].member_count, 2);
    }

    #[test]
    fn membership_summaries_include_labels_capabilities_and_personal_flag() {
        let user_id = Uuid::new_v4();
        let mut personal = org_fixture("Ada", "ada");
        personal.account_type = "customer".to_string();
        let business = org_fixture("Acme", "acme");
        let mut data = StoreData::default();
        data.insert_org(personal.clone());
        data.insert_org(business.clone());
        data.insert_membership(membership_row(personal.id, user_id, "viewer", "active"));
        data.insert_membership(membership_row(business.id, user_id, "member", "active"));

        let summaries = collect_user_org_memberships(&data, user_id, business.id);
        let personal_summary = summaries
            .iter()
            .find(|summary| summary.org_id == personal.id)
            .expect("personal summary");
        assert!(personal_summary.is_personal);
        assert_eq!(personal_summary.role_label, "Read only");
        assert!(!personal_summary.capabilities.write_runs);
        assert!(!personal_summary.capabilities.manage_billing);

        let business_summary = summaries
            .iter()
            .find(|summary| summary.org_id == business.id)
            .expect("business summary");
        assert_eq!(business_summary.role_label, "Write/read");
        assert!(business_summary.capabilities.write_runs);
        assert!(!business_summary.capabilities.manage_api_keys);
    }

    #[tokio::test]
    async fn current_user_create_org_rejects_second_personal_workspace() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "Ada@Example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut personal = org_fixture("Ada", "ada");
        personal.account_type = "personal".to_string();
        personal.created_by_user_id = Some(user.id);
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.insert_org(personal.clone());
        data.insert_membership(membership_row(personal.id, user.id, "owner", "active"));
        let store = store_with_data(data);

        let error = create_current_user_organization(
            &store,
            user.id,
            personal.id,
            CreateCurrentUserOrganizationRequest {
                name: Some("Ada Lab".to_string()),
                account_type: Some("personal".to_string()),
                plan_tier: Some("free".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: None,
                switch_on_create: Some(false),
            },
            &crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            &email_config(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn current_user_create_org_rejects_personal_initial_invitations() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "ada@example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        let store = store_with_data(data);

        let error = create_current_user_organization(
            &store,
            user.id,
            Uuid::new_v4(),
            CreateCurrentUserOrganizationRequest {
                name: Some("Ada Personal".to_string()),
                account_type: Some("personal".to_string()),
                plan_tier: Some("free".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: Some(vec![InitialOrganizationInvitation {
                    email: "teammate@example.com".to_string(),
                    role: Some("member".to_string()),
                }]),
                switch_on_create: Some(false),
            },
            &crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            &email_config(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
        assert!(store.data.lock().await.organizations.is_empty());
    }

    #[tokio::test]
    async fn current_user_create_org_rejects_paid_plan_without_billing() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "ada@example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        let store = store_with_data(data);

        let error = create_current_user_organization(
            &store,
            user.id,
            Uuid::new_v4(),
            CreateCurrentUserOrganizationRequest {
                name: Some("Paid Lab".to_string()),
                account_type: Some("business".to_string()),
                plan_tier: Some("pro".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: None,
                switch_on_create: Some(false),
            },
            &crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            &email_config(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert!(store.data.lock().await.organizations.is_empty());
    }

    #[tokio::test]
    async fn current_user_create_org_rejects_legacy_customer_owner_workspace() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "ada@example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut personal = org_fixture("Ada", "ada");
        personal.account_type = "customer".to_string();
        personal.created_by_user_id = None;
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.insert_org(personal.clone());
        data.insert_membership(membership_row(personal.id, user.id, "owner", "active"));
        let store = store_with_data(data);

        let error = create_current_user_organization(
            &store,
            user.id,
            personal.id,
            CreateCurrentUserOrganizationRequest {
                name: Some("Ada Lab".to_string()),
                account_type: Some("personal".to_string()),
                plan_tier: Some("free".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: None,
                switch_on_create: Some(false),
            },
            &crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            &email_config(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn current_user_create_org_rejects_owner_initial_invite_before_persisting() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "ada@example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        let store = store_with_data(data);

        let error = create_current_user_organization(
            &store,
            user.id,
            Uuid::new_v4(),
            CreateCurrentUserOrganizationRequest {
                name: Some("Ada Lab".to_string()),
                account_type: Some("business".to_string()),
                plan_tier: Some("free".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: Some(vec![InitialOrganizationInvitation {
                    email: "ada@example.com".to_string(),
                    role: Some("member".to_string()),
                }]),
                switch_on_create: Some(false),
            },
            &crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            &email_config(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::CONFLICT);
        assert!(store.data.lock().await.organizations.is_empty());
    }

    #[tokio::test]
    async fn current_user_create_org_surfaces_initial_invitation_delivery_failure() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "ada@example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        let store = store_with_data(data);
        let failing_email = EmailConfig {
            provider: EmailProvider::Resend,
            resend_api_key: None,
            ..email_config()
        };

        let created = create_current_user_organization(
            &store,
            user.id,
            Uuid::new_v4(),
            CreateCurrentUserOrganizationRequest {
                name: Some("Ada Lab".to_string()),
                account_type: Some("business".to_string()),
                plan_tier: Some("free".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: Some(vec![InitialOrganizationInvitation {
                    email: "teammate@example.com".to_string(),
                    role: Some("member".to_string()),
                }]),
                switch_on_create: Some(false),
            },
            &crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            &failing_email,
        )
        .await
        .unwrap();

        assert_eq!(created.response.invitations.len(), 1);
        let invite = &created.response.invitations[0];
        assert_eq!(invite.invitation.email, "teammate@example.com");
        assert_eq!(invite.invitation.delivery_status, "send_failed");
        assert_eq!(
            invite.delivery_error.as_deref(),
            Some("email delivery failed")
        );
        assert!(invite.preview_link.is_none());
    }

    #[tokio::test]
    async fn current_user_create_org_abandons_active_membership_when_tenant_route_fails() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "ada@example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        let store = hosted_store_with_data(data);

        let error = create_current_user_organization(
            &store,
            user.id,
            Uuid::new_v4(),
            CreateCurrentUserOrganizationRequest {
                name: Some("Broken Lab".to_string()),
                account_type: Some("business".to_string()),
                plan_tier: Some("free".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: None,
                switch_on_create: Some(false),
            },
            &crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            &email_config(),
        )
        .await
        .unwrap_err();
        assert!(error.status().is_server_error());

        let data = store.data.lock().await;
        assert!(
            !data.orgs_by_slug.contains_key("broken-lab"),
            "failed user-facing creates should free the requested slug"
        );
        assert!(
            data.memberships
                .values()
                .all(|membership| membership.user_id != user.id || membership.status != "active"),
            "failed user-facing creates should not leave a switchable workspace"
        );
        assert!(collect_user_org_memberships(&data, user.id, Uuid::new_v4()).is_empty());
    }

    #[tokio::test]
    async fn current_user_create_org_rejects_paid_initial_invitations_before_persisting() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "ada@example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        let store = store_with_data(data);
        let mut billing = crate::config::BillingConfig::disabled(Some("http://localhost:3000"));
        billing.enabled = true;
        billing.stripe_secret_key = Some("sk_test_fake".to_string());

        let error = create_current_user_organization(
            &store,
            user.id,
            Uuid::new_v4(),
            CreateCurrentUserOrganizationRequest {
                name: Some("Paid Lab".to_string()),
                account_type: Some("business".to_string()),
                plan_tier: Some("pro".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: Some(vec![InitialOrganizationInvitation {
                    email: "teammate@example.com".to_string(),
                    role: Some("member".to_string()),
                }]),
                switch_on_create: Some(false),
            },
            &billing,
            &email_config(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
        assert!(store.data.lock().await.organizations.is_empty());
    }

    #[tokio::test]
    async fn current_user_create_org_rejects_legacy_customer_account_type() {
        let store = store_with_data(StoreData::default());
        let error = create_current_user_organization(
            &store,
            Uuid::new_v4(),
            Uuid::new_v4(),
            CreateCurrentUserOrganizationRequest {
                name: Some("Customer Legacy".to_string()),
                account_type: Some("customer".to_string()),
                plan_tier: Some("free".to_string()),
                storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
                initial_invitations: None,
                switch_on_create: Some(false),
            },
            &crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            &email_config(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn list_user_org_memberships_orders_current_first_then_alphabetical() {
        let user_id = Uuid::new_v4();
        let acme = org_fixture("Acme", "acme");
        let beta = org_fixture("Beta", "beta");
        let zeta = org_fixture("Zeta", "zeta");
        let mut data = StoreData::default();
        data.insert_org(acme.clone());
        data.insert_org(beta.clone());
        data.insert_org(zeta.clone());
        data.insert_membership(membership_row(acme.id, user_id, "member", "active"));
        data.insert_membership(membership_row(beta.id, user_id, "owner", "active"));
        data.insert_membership(membership_row(zeta.id, user_id, "admin", "active"));

        // With beta as current, ordering should be beta, acme, zeta.
        let summaries = collect_user_org_memberships(&data, user_id, beta.id);
        let names: Vec<_> = summaries.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["Beta", "Acme", "Zeta"]);
        assert!(summaries[0].is_current);
        assert!(!summaries[1].is_current);
        assert!(!summaries[2].is_current);
    }

    #[test]
    fn switch_org_validation_rejects_user_without_active_membership() {
        // User is invited (but not active) in `beta` — switch must be forbidden.
        let user_id = Uuid::new_v4();
        let acme = org_fixture("Acme", "acme");
        let beta = org_fixture("Beta", "beta");
        let mut data = StoreData::default();
        data.insert_org(acme.clone());
        data.insert_org(beta.clone());
        data.insert_membership(membership_row(acme.id, user_id, "owner", "active"));
        data.insert_membership(membership_row(beta.id, user_id, "member", "invited"));
        let session = live_session(user_id, acme.id);

        let err = validate_session_org_switch(&data, &session, beta.id).unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn switch_org_validation_allows_user_with_active_membership() {
        let user_id = Uuid::new_v4();
        let acme = org_fixture("Acme", "acme");
        let beta = org_fixture("Beta", "beta");
        let mut data = StoreData::default();
        data.insert_org(acme.clone());
        data.insert_org(beta.clone());
        data.insert_membership(membership_row(acme.id, user_id, "owner", "active"));
        data.insert_membership(membership_row(beta.id, user_id, "member", "active"));
        let session = live_session(user_id, acme.id);

        assert!(validate_session_org_switch(&data, &session, beta.id).is_ok());
    }

    #[test]
    fn switch_org_validation_rejects_missing_org() {
        let user_id = Uuid::new_v4();
        let acme = org_fixture("Acme", "acme");
        let mut data = StoreData::default();
        data.insert_org(acme.clone());
        data.insert_membership(membership_row(acme.id, user_id, "owner", "active"));
        let session = live_session(user_id, acme.id);

        let missing = Uuid::new_v4();
        let err = validate_session_org_switch(&data, &session, missing).unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[test]
    fn switch_org_validation_rejects_revoked_session() {
        let user_id = Uuid::new_v4();
        let acme = org_fixture("Acme", "acme");
        let beta = org_fixture("Beta", "beta");
        let mut data = StoreData::default();
        data.insert_org(acme.clone());
        data.insert_org(beta.clone());
        data.insert_membership(membership_row(acme.id, user_id, "owner", "active"));
        data.insert_membership(membership_row(beta.id, user_id, "member", "active"));
        let mut session = live_session(user_id, acme.id);
        session.revoked_at = Some(Utc::now());

        let err = validate_session_org_switch(&data, &session, beta.id).unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::UNAUTHORIZED);
    }
}
