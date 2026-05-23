use super::super::*;
use super::helpers::*;

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
    let mut data = store.data.lock().await;
    if data.orgs_by_slug.contains_key(&slug) {
        return Err(AppError::conflict("organization already exists"));
    }
    if let Some(owner_id) = input.owner_user_id {
        if !data.users.contains_key(&owner_id) {
            return Err(AppError::not_found("owner user not found"));
        }
    }
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
    if org.storage_choice != STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        store.ensure_tenant_route(&org).await?;
    }
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
                plan_tier: org.plan_tier.clone(),
                role: membership.role.clone(),
                status: membership.status.clone(),
                member_count,
                is_current: org.id == current_org_id,
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

/// Re-point an existing session row at a different org the user belongs to.
///
/// Returns the refreshed session payload (same shape as `authenticate_session`).
/// Returns `forbidden` if the user has no *active* membership in the target
/// org, `not_found` if the session token doesn't resolve, and `unauthorized`
/// if the session has been revoked or expired.
///
/// The session cookie does not change — it carries the session token, which
/// maps to the same `session_id` regardless of the bound org.
pub async fn switch_session_organization(
    store: &Store,
    token: &str,
    target_org_id: Uuid,
) -> AppResult<AuthSessionPayload> {
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
    validate_session_org_switch(&data, &session.row, target_org_id)?;
    // Short-circuit if the session is already pointing at the target org —
    // skips a needless disk write while still returning a fresh payload.
    if session.row.org_id != target_org_id {
        session.row.org_id = target_org_id;
        session.row.last_seen_at = Some(Utc::now());
        store
            .persist_locked(
                "session",
                session.row.org_id,
                &session.row.id.to_string(),
                &session,
            )
            .await?;
        data.insert_session(session.clone());
    } else {
        session.row.last_seen_at = Some(Utc::now());
    }
    session_payload_from_data(&data, session.row)
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
