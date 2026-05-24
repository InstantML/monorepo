use super::*;
use std::collections::HashSet;
use url::Url;

use crate::domain::{
    AdminApiKeySummary, AdminBillingSummary, AdminOrgCounts, AdminOrganizationSummary,
    AdminOverviewQuerySummary, AdminOverviewResponse, AdminOverviewTotals, AdminRiskItem,
    AdminStorageSummary, AdminUsageGauge, AdminUserIdentity, AdminUserOrgMembership,
    AdminUserSummary,
};

pub const ADMIN_OVERVIEW_DEFAULT_LIMIT: usize = 100;
pub const ADMIN_OVERVIEW_MAX_LIMIT: usize = 200;

pub struct AdminOverviewOptions {
    pub q: Option<String>,
    pub limit: usize,
    pub data_counts_available: bool,
}

pub async fn admin_overview(
    store: &Store,
    options: AdminOverviewOptions,
) -> AppResult<AdminOverviewResponse> {
    let data = store.data.lock().await;
    Ok(build_admin_overview(&data, options, Utc::now()))
}

fn build_admin_overview(
    data: &StoreData,
    options: AdminOverviewOptions,
    now: DateTime<Utc>,
) -> AdminOverviewResponse {
    let q = normalize_query(options.q);
    let limit = options.limit.clamp(1, ADMIN_OVERVIEW_MAX_LIMIT);

    let mut organizations = data
        .organizations
        .values()
        .map(|org| organization_summary(data, org, options.data_counts_available, now))
        .collect::<Vec<_>>();
    organizations.sort_by(|left, right| {
        risk_rank(&right.risk_level)
            .cmp(&risk_rank(&left.risk_level))
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| left.name.cmp(&right.name))
    });
    let matched_organizations = count_matches(&organizations, |org| {
        q.as_ref()
            .map(|query| organization_matches(org, query))
            .unwrap_or(true)
    });
    let organizations = filter_and_limit(organizations, &q, limit, organization_matches);

    let mut users = data
        .users
        .values()
        .map(|user| user_summary(data, user))
        .collect::<Vec<_>>();
    users.sort_by(|left, right| {
        right
            .last_seen_at
            .cmp(&left.last_seen_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| left.primary_email.cmp(&right.primary_email))
    });
    let matched_users = count_matches(&users, |user| {
        q.as_ref()
            .map(|query| user_matches(user, query))
            .unwrap_or(true)
    });
    let users = filter_and_limit(users, &q, limit, user_matches);

    let mut api_keys = api_key_summaries(data, now);
    api_keys.sort_by(|left, right| {
        key_status_rank(&right.status)
            .cmp(&key_status_rank(&left.status))
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| left.name.cmp(&right.name))
    });
    let matched_api_keys = count_matches(&api_keys, |key| {
        q.as_ref()
            .map(|query| api_key_matches(key, query))
            .unwrap_or(true)
    });
    let api_keys = filter_and_limit(api_keys, &q, limit, api_key_matches);

    let mut risks = risk_items(data, options.data_counts_available, now);
    risks.sort_by(|left, right| {
        risk_rank(&right.severity)
            .cmp(&risk_rank(&left.severity))
            .then_with(|| left.category.cmp(&right.category))
            .then_with(|| left.target_label.cmp(&right.target_label))
    });
    let risk_total = risks.len();
    let risks = filter_and_limit(risks, &q, limit, risk_matches);

    AdminOverviewResponse {
        schema_version: 1,
        generated_at: now,
        data_counts_available: options.data_counts_available,
        query: AdminOverviewQuerySummary {
            q,
            limit,
            matched_organizations,
            matched_users,
            matched_api_keys,
        },
        totals: totals(data, risk_total, now),
        organizations,
        users,
        api_keys,
        risks,
    }
}

fn normalize_query(q: Option<String>) -> Option<String> {
    q.and_then(|raw| {
        let trimmed = raw.trim().to_ascii_lowercase();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

fn filter_and_limit<T>(
    values: Vec<T>,
    q: &Option<String>,
    limit: usize,
    matches: fn(&T, &str) -> bool,
) -> Vec<T> {
    values
        .into_iter()
        .filter(|value| {
            q.as_ref()
                .map(|query| matches(value, query))
                .unwrap_or(true)
        })
        .take(limit)
        .collect()
}

fn count_matches<T>(values: &[T], matches: impl Fn(&T) -> bool) -> usize {
    values.iter().filter(|value| matches(value)).count()
}

fn totals(data: &StoreData, risk_items: usize, now: DateTime<Utc>) -> AdminOverviewTotals {
    let active_memberships = data
        .memberships
        .values()
        .filter(|membership| membership.status == "active")
        .count();
    let invited_memberships = data
        .memberships
        .values()
        .filter(|membership| membership.status == "invited")
        .count();
    let pending_invitations = data
        .org_invitations
        .values()
        .filter(|invitation| invitation.status == "pending" && invitation.expires_at > now)
        .count();
    let disabled_service_accounts = data
        .service_accounts
        .values()
        .filter(|account| account.disabled_at.is_some())
        .count();
    let mut active_api_keys = 0;
    let mut revoked_api_keys = 0;
    let mut expired_api_keys = 0;
    for record in data.api_keys.values() {
        match api_key_status(data, &record.row, now).as_str() {
            "active" => active_api_keys += 1,
            "revoked" => revoked_api_keys += 1,
            "expired" => expired_api_keys += 1,
            _ => {}
        }
    }
    AdminOverviewTotals {
        users: data.users.len(),
        organizations: data.organizations.len(),
        active_memberships,
        invited_memberships,
        pending_invitations,
        active_api_keys,
        revoked_api_keys,
        expired_api_keys,
        disabled_service_accounts,
        storage_ready_orgs: data
            .organizations
            .values()
            .filter(|org| org.storage_state == STORAGE_STATE_READY)
            .count(),
        storage_unconfigured_orgs: data
            .organizations
            .values()
            .filter(|org| org.storage_state == STORAGE_STATE_UNCONFIGURED)
            .count(),
        storage_locked_orgs: data
            .organizations
            .values()
            .filter(|org| org.storage_state == STORAGE_STATE_LOCKED)
            .count(),
        billing_read_only_orgs: data
            .billing_accounts
            .values()
            .filter(|account| account.access_state == BILLING_READ_ONLY_PAYMENT_REQUIRED)
            .count(),
        risk_items,
    }
}

fn organization_summary(
    data: &StoreData,
    org: &OrganizationRow,
    data_counts_available: bool,
    now: DateTime<Utc>,
) -> AdminOrganizationSummary {
    let active_members = member_count(data, org.id, "active");
    let invited_members = member_count(data, org.id, "invited");
    let pending_invitations = pending_invitation_count(data, org.id, now);
    let active_api_keys = data
        .api_keys
        .values()
        .filter(|record| record.row.org_id == org.id)
        .filter(|record| api_key_status(data, &record.row, now) == "active")
        .count();
    let revoked_api_keys = data
        .api_keys
        .values()
        .filter(|record| record.row.org_id == org.id)
        .filter(|record| record.row.revoked_at.is_some())
        .count();
    let service_accounts = data
        .service_accounts
        .values()
        .filter(|account| account.org_id == org.id)
        .count();
    let disabled_service_accounts = data
        .service_accounts
        .values()
        .filter(|account| account.org_id == org.id && account.disabled_at.is_some())
        .count();
    let projects = data_counts_available.then(|| {
        data.projects
            .values()
            .filter(|project| project.org_id == org.id)
            .count()
    });
    let runs = data_counts_available.then(|| {
        data.runs
            .values()
            .filter(|run| run.org_id == org.id)
            .count()
    });
    let artifacts = data_counts_available.then(|| {
        data.artifacts
            .values()
            .filter(|artifact| artifact.org_id == org.id)
            .count()
    });
    let retained_artifact_bytes =
        data_counts_available.then(|| retained_artifact_bytes(data, org.id));

    let counts = AdminOrgCounts {
        active_members,
        invited_members,
        pending_invitations,
        active_api_keys,
        revoked_api_keys,
        service_accounts,
        disabled_service_accounts,
        projects,
        runs,
        artifacts,
        retained_artifact_bytes,
    };
    let usage = usage_gauges(org, &counts);
    let storage = storage_summary(data.tenant_routes.get(&org.id), org);
    let billing = data.billing_accounts.get(&org.id).map(billing_summary);
    let risk_reasons = org_risk_reasons(org, &counts, &usage, &storage, billing.as_ref());
    let risk_level = highest_risk_level(&risk_reasons);

    AdminOrganizationSummary {
        id: org.id,
        slug: org.slug.clone(),
        name: org.name.clone(),
        plan_tier: org.plan_tier.clone(),
        account_type: org.account_type.clone(),
        seat_limit: org.seat_limit,
        created_at: org.created_at,
        owner: owner_identity(data, org.id),
        counts,
        usage,
        storage,
        billing,
        risk_level,
        risk_reasons,
    }
}

fn owner_identity(data: &StoreData, org_id: Uuid) -> Option<AdminUserIdentity> {
    let owner = data
        .memberships
        .values()
        .filter(|membership| membership.org_id == org_id)
        .find(|membership| membership.role == "owner" && membership.status == "active")
        .or_else(|| {
            data.memberships
                .values()
                .filter(|membership| membership.org_id == org_id)
                .find(|membership| membership.status == "active")
        })?;
    let user = data.users.get(&owner.user_id)?;
    Some(AdminUserIdentity {
        id: user.id,
        primary_email: user.primary_email.clone(),
        display_name: user.display_name.clone(),
    })
}

fn member_count(data: &StoreData, org_id: Uuid, status: &str) -> usize {
    data.memberships
        .values()
        .filter(|membership| membership.org_id == org_id && membership.status == status)
        .count()
}

fn pending_invitation_count(data: &StoreData, org_id: Uuid, now: DateTime<Utc>) -> usize {
    data.org_invitations
        .values()
        .filter(|invitation| {
            invitation.org_id == org_id
                && invitation.status == "pending"
                && invitation.expires_at > now
        })
        .count()
}

fn retained_artifact_bytes(data: &StoreData, org_id: Uuid) -> i64 {
    data.artifacts
        .values()
        .filter(|artifact| artifact.org_id == org_id)
        .filter(|artifact| matches!(artifact.storage_backend.as_str(), "local" | "r2"))
        .filter_map(|artifact| artifact.size_bytes)
        .sum()
}

fn usage_gauges(org: &OrganizationRow, counts: &AdminOrgCounts) -> Vec<AdminUsageGauge> {
    let plan = plan_tier(&org.plan_tier);
    let mut gauges = vec![usage_gauge(
        "seats",
        (counts.active_members + counts.invited_members + counts.pending_invitations) as i64,
        org.seat_limit as i64,
    )];
    if let Some(projects) = counts.projects {
        gauges.push(usage_gauge("projects", projects as i64, plan.projects));
    }
    if let Some(runs) = counts.runs {
        gauges.push(usage_gauge("runs", runs as i64, plan.runs));
    }
    if let Some(bytes) = counts.retained_artifact_bytes {
        gauges.push(usage_gauge(
            "retained_artifact_bytes",
            bytes,
            plan.included_storage_bytes,
        ));
    }
    gauges
}

fn usage_gauge(target: &str, current: i64, limit: i64) -> AdminUsageGauge {
    let percent = if limit <= 0 {
        0.0
    } else {
        ((current as f64 / limit as f64) * 100.0).min(999.0)
    };
    let status = if limit > 0 && current >= limit {
        "limit"
    } else if percent >= 80.0 {
        "warning"
    } else {
        "ok"
    };
    AdminUsageGauge {
        target: target.to_string(),
        current,
        limit,
        percent,
        status: status.to_string(),
    }
}

fn storage_summary(
    route: Option<&TenantRouteRecord>,
    org: &OrganizationRow,
) -> AdminStorageSummary {
    AdminStorageSummary {
        storage_choice: org.storage_choice.clone(),
        storage_state: org.storage_state.clone(),
        tenant_routing_tier: org.tenant_routing_tier.clone(),
        route_status: route.map(|route| route.status.clone()),
        route_provisioner: route.map(|route| route.provisioner.clone()),
        route_plan_tier: route.and_then(|route| route.plan_tier.clone()),
        warehouse_kind: route.and_then(|route| route.warehouse_kind.clone()),
        endpoint_host: route.and_then(|route| endpoint_host(&route.endpoint)),
        database: route.map(|route| route.database.clone()),
        service_id: route.and_then(|route| route.service_id.clone()),
        requested_min_replica_memory_gb: route
            .and_then(|route| route.requested_min_replica_memory_gb),
        requested_max_replica_memory_gb: route
            .and_then(|route| route.requested_max_replica_memory_gb),
        requested_num_replicas: route.and_then(|route| route.requested_num_replicas),
        applied_min_replica_memory_gb: route.and_then(|route| route.applied_min_replica_memory_gb),
        applied_max_replica_memory_gb: route.and_then(|route| route.applied_max_replica_memory_gb),
        applied_num_replicas: route.and_then(|route| route.applied_num_replicas),
        schema_version: route.and_then(|route| route.schema_version),
        updated_at: route.map(|route| route.updated_at),
        error: route
            .and_then(|route| route.error.as_ref())
            .map(|_| "route_error_recorded".to_string()),
    }
}

fn endpoint_host(endpoint: &str) -> Option<String> {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}

fn billing_summary(account: &BillingAccountProjection) -> AdminBillingSummary {
    AdminBillingSummary {
        access_state: account.access_state.clone(),
        effective_plan_tier: account.effective_plan_tier.clone(),
        requested_plan_tier: account.requested_plan_tier.clone(),
        paid_extra_seats: account.paid_extra_seats,
        subscription_status: account.subscription_status.clone(),
        stripe_customer_id: account.stripe_customer_id.clone(),
        stripe_subscription_id: account.stripe_subscription_id.clone(),
        current_period_end: account.current_period_end,
        cancel_at_period_end: account.cancel_at_period_end,
        grace_until: account.grace_until,
        updated_at: account.updated_at,
    }
}

fn org_risk_reasons(
    org: &OrganizationRow,
    counts: &AdminOrgCounts,
    usage: &[AdminUsageGauge],
    storage: &AdminStorageSummary,
    billing: Option<&AdminBillingSummary>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if storage.storage_state == STORAGE_STATE_UNCONFIGURED {
        reasons.push("high:storage_unconfigured".to_string());
    }
    if storage.storage_state == STORAGE_STATE_LOCKED {
        reasons.push("medium:storage_locked".to_string());
    }
    if matches!(storage.route_status.as_deref(), Some("failed")) {
        reasons.push("high:tenant_route_failed".to_string());
    }
    if matches!(storage.route_status.as_deref(), Some("provisioning")) {
        reasons.push("medium:tenant_route_provisioning".to_string());
    }
    if storage.error.is_some() {
        reasons.push("medium:tenant_route_error_recorded".to_string());
    }
    if org.storage_choice == STORAGE_CHOICE_HOSTED
        && org.storage_state == STORAGE_STATE_READY
        && storage.route_status.is_none()
    {
        reasons.push("medium:tenant_route_missing".to_string());
    }
    if counts.disabled_service_accounts > 0 {
        reasons.push("low:disabled_service_accounts".to_string());
    }
    for gauge in usage {
        if gauge.status == "limit" {
            reasons.push(format!("high:{}_at_limit", gauge.target));
        } else if gauge.status == "warning" {
            reasons.push(format!("medium:{}_near_limit", gauge.target));
        }
    }
    if let Some(billing) = billing {
        if billing.access_state == BILLING_READ_ONLY_PAYMENT_REQUIRED {
            reasons.push("high:billing_read_only".to_string());
        } else if billing.access_state == BILLING_PAST_DUE_GRACE {
            reasons.push("medium:billing_past_due_grace".to_string());
        } else if billing.access_state == BILLING_CHECKOUT_PENDING {
            reasons.push("low:billing_checkout_pending".to_string());
        } else if billing.access_state == BILLING_CANCELED {
            reasons.push("medium:billing_canceled".to_string());
        }
    }
    reasons
}

fn highest_risk_level(reasons: &[String]) -> String {
    if reasons.iter().any(|reason| reason.starts_with("high:")) {
        "high"
    } else if reasons.iter().any(|reason| reason.starts_with("medium:")) {
        "medium"
    } else if reasons.iter().any(|reason| reason.starts_with("low:")) {
        "low"
    } else {
        "ok"
    }
    .to_string()
}

fn user_summary(data: &StoreData, user: &UserRow) -> AdminUserSummary {
    let orgs = data
        .memberships
        .values()
        .filter(|membership| membership.user_id == user.id)
        .filter_map(|membership| {
            data.organizations
                .get(&membership.org_id)
                .map(|org| AdminUserOrgMembership {
                    org_id: org.id,
                    org_name: org.name.clone(),
                    role: membership.role.clone(),
                    status: membership.status.clone(),
                })
        })
        .collect::<Vec<_>>();
    let active_memberships = orgs.iter().filter(|org| org.status == "active").count();
    let invited_memberships = orgs.iter().filter(|org| org.status == "invited").count();
    let last_seen_at = data
        .sessions
        .values()
        .filter(|session| session.row.user_id == user.id)
        .filter_map(|session| session.row.last_seen_at)
        .chain(user.last_seen_at)
        .max();
    let status = if active_memberships > 0 {
        "active"
    } else if invited_memberships > 0 {
        "invited"
    } else {
        "no_org"
    };

    AdminUserSummary {
        id: user.id,
        primary_email: user.primary_email.clone(),
        display_name: user.display_name.clone(),
        created_at: user.created_at,
        last_seen_at,
        status: status.to_string(),
        active_memberships,
        invited_memberships,
        orgs,
    }
}

fn api_key_summaries(data: &StoreData, now: DateTime<Utc>) -> Vec<AdminApiKeySummary> {
    data.api_keys
        .values()
        .filter_map(|record| {
            let org = data.organizations.get(&record.row.org_id)?;
            let service_account = data.service_accounts.get(&record.row.service_account_id);
            Some(AdminApiKeySummary {
                id: record.row.id,
                org_id: record.row.org_id,
                org_name: org.name.clone(),
                service_account_id: record.row.service_account_id,
                service_account_name: service_account.map(|account| account.name.clone()),
                name: record.row.name.clone(),
                key_prefix: record.row.key_prefix.clone(),
                scopes: effective_admin_api_key_scopes(data, record),
                project_id: record.row.project_id,
                status: api_key_status(data, &record.row, now),
                created_at: record.row.created_at,
                expires_at: record.row.expires_at,
                last_used_at: record.row.last_used_at,
                revoked_at: record.row.revoked_at,
            })
        })
        .collect()
}

fn effective_admin_api_key_scopes(data: &StoreData, record: &ApiKeyRecord) -> Vec<String> {
    if data
        .organizations
        .get(&record.row.org_id)
        .is_some_and(is_shared_demo_org)
    {
        return DEMO_API_KEY_SCOPES
            .iter()
            .map(|scope| (*scope).to_string())
            .collect();
    }
    record.row.scopes.clone()
}

fn api_key_status(data: &StoreData, key: &PublicApiKeyRow, now: DateTime<Utc>) -> String {
    if key.revoked_at.is_some() {
        "revoked"
    } else if key
        .expires_at
        .map(|expires| expires <= now)
        .unwrap_or(false)
    {
        "expired"
    } else if data
        .service_accounts
        .get(&key.service_account_id)
        .and_then(|account| account.disabled_at)
        .is_some()
    {
        "disabled"
    } else {
        "active"
    }
    .to_string()
}

fn risk_items(
    data: &StoreData,
    data_counts_available: bool,
    now: DateTime<Utc>,
) -> Vec<AdminRiskItem> {
    let mut risks = Vec::new();
    for org in data.organizations.values() {
        let summary = organization_summary(data, org, data_counts_available, now);
        for reason in summary.risk_reasons {
            let (severity, code) = reason.split_once(':').unwrap_or(("low", reason.as_str()));
            risks.push(AdminRiskItem {
                id: format!("org:{}:{code}", org.id),
                target_type: "organization".to_string(),
                target_id: org.id.to_string(),
                target_label: org.name.clone(),
                severity: severity.to_string(),
                category: code_category(code),
                message: humanize_risk(code, &org.name),
                observed_at: now,
            });
        }
    }
    for key in api_key_summaries(data, now) {
        if key.status == "active" {
            if key.last_used_at.is_none() && key.created_at < now - ChronoDuration::days(30) {
                risks.push(AdminRiskItem {
                    id: format!("api_key:{}:never_used", key.id),
                    target_type: "api_key".to_string(),
                    target_id: key.id.to_string(),
                    target_label: format!("{} / {}", key.org_name, key.name),
                    severity: "low".to_string(),
                    category: "api_key".to_string(),
                    message: "Active API key has never been used after 30 days.".to_string(),
                    observed_at: now,
                });
            } else if key
                .last_used_at
                .map(|last_used| last_used < now - ChronoDuration::days(90))
                .unwrap_or(false)
            {
                risks.push(AdminRiskItem {
                    id: format!("api_key:{}:stale", key.id),
                    target_type: "api_key".to_string(),
                    target_id: key.id.to_string(),
                    target_label: format!("{} / {}", key.org_name, key.name),
                    severity: "medium".to_string(),
                    category: "api_key".to_string(),
                    message: "Active API key has not been used in over 90 days.".to_string(),
                    observed_at: now,
                });
            }
        }
    }
    dedupe_risks(risks)
}

fn dedupe_risks(risks: Vec<AdminRiskItem>) -> Vec<AdminRiskItem> {
    let mut seen = HashSet::new();
    risks
        .into_iter()
        .filter(|risk| seen.insert(risk.id.clone()))
        .collect()
}

fn code_category(code: &str) -> String {
    if code.starts_with("billing") {
        "billing"
    } else if code.starts_with("tenant") || code.starts_with("storage") {
        "storage"
    } else if code.starts_with("seats") {
        "seats"
    } else if code.starts_with("projects") || code.starts_with("runs") {
        "limits"
    } else {
        "operations"
    }
    .to_string()
}

fn humanize_risk(code: &str, org_name: &str) -> String {
    match code {
        "storage_unconfigured" => format!("{org_name} has not completed storage setup."),
        "storage_locked" => format!("{org_name} storage is locked."),
        "tenant_route_failed" => format!("{org_name} tenant route provisioning failed."),
        "tenant_route_provisioning" => format!("{org_name} tenant route is still provisioning."),
        "tenant_route_error_recorded" => format!("{org_name} has a tenant route error marker."),
        "tenant_route_missing" => format!("{org_name} is ready but has no tenant route."),
        "billing_read_only" => format!("{org_name} is read-only because payment is required."),
        "billing_past_due_grace" => format!("{org_name} is in payment grace."),
        "billing_checkout_pending" => format!("{org_name} has checkout pending."),
        "billing_canceled" => format!("{org_name} billing is canceled."),
        "disabled_service_accounts" => format!("{org_name} has disabled service accounts."),
        other if other.ends_with("_at_limit") => {
            format!(
                "{org_name} is at the {} limit.",
                other.trim_end_matches("_at_limit")
            )
        }
        other if other.ends_with("_near_limit") => {
            format!(
                "{org_name} is near the {} limit.",
                other.trim_end_matches("_near_limit")
            )
        }
        _ => format!("{org_name} needs operator review for {code}."),
    }
}

fn organization_matches(org: &AdminOrganizationSummary, query: &str) -> bool {
    text_matches(
        query,
        [
            org.id.to_string(),
            org.name.clone(),
            org.slug.clone(),
            org.plan_tier.clone(),
            org.account_type.clone(),
            org.storage.storage_choice.clone(),
            org.storage.storage_state.clone(),
            org.storage.tenant_routing_tier.clone(),
            org.storage.route_status.clone().unwrap_or_default(),
            org.storage.route_provisioner.clone().unwrap_or_default(),
            org.storage.database.clone().unwrap_or_default(),
            org.owner
                .as_ref()
                .map(|owner| owner.primary_email.clone())
                .unwrap_or_default(),
            org.risk_level.clone(),
            org.risk_reasons.join(" "),
        ],
    )
}

fn user_matches(user: &AdminUserSummary, query: &str) -> bool {
    text_matches(
        query,
        [
            user.id.to_string(),
            user.primary_email.clone(),
            user.display_name.clone().unwrap_or_default(),
            user.status.clone(),
            user.orgs
                .iter()
                .map(|org| format!("{} {} {}", org.org_name, org.role, org.status))
                .collect::<Vec<_>>()
                .join(" "),
        ],
    )
}

fn api_key_matches(key: &AdminApiKeySummary, query: &str) -> bool {
    text_matches(
        query,
        [
            key.id.to_string(),
            key.org_id.to_string(),
            key.org_name.clone(),
            key.name.clone(),
            key.key_prefix.clone(),
            key.status.clone(),
            key.scopes.join(" "),
            key.service_account_name.clone().unwrap_or_default(),
        ],
    )
}

fn risk_matches(risk: &AdminRiskItem, query: &str) -> bool {
    text_matches(
        query,
        [
            risk.id.clone(),
            risk.target_type.clone(),
            risk.target_id.clone(),
            risk.target_label.clone(),
            risk.severity.clone(),
            risk.category.clone(),
            risk.message.clone(),
        ],
    )
}

fn text_matches<const N: usize>(query: &str, fields: [String; N]) -> bool {
    fields
        .iter()
        .any(|field| field.to_ascii_lowercase().contains(query))
}

fn risk_rank(level: &str) -> i32 {
    match level {
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 0,
    }
}

fn key_status_rank(status: &str) -> i32 {
    match status {
        "active" => 3,
        "disabled" => 2,
        "expired" => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 5, day, 12, 0, 0).unwrap()
    }

    fn base_data() -> StoreData {
        let now = ts(24);
        let owner = UserRow {
            id: Uuid::new_v4(),
            primary_email: "owner@acme.test".to_string(),
            display_name: Some("Acme Owner".to_string()),
            avatar_url: None,
            created_at: ts(1),
            last_seen_at: Some(ts(23)),
        };
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "acme-research".to_string(),
            name: "Acme Research".to_string(),
            plan_tier: "pro".to_string(),
            account_type: "customer".to_string(),
            seat_limit: 1,
            created_by_user_id: Some(owner.id),
            created_at: ts(1),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        let service_account = ServiceAccountRow {
            id: Uuid::new_v4(),
            org_id: org.id,
            name: "Training key".to_string(),
            created_by_user_id: Some(owner.id),
            created_at: ts(2),
            disabled_at: None,
        };
        let api_key = PublicApiKeyRow {
            id: Uuid::new_v4(),
            org_id: org.id,
            service_account_id: service_account.id,
            name: "Training key".to_string(),
            key_prefix: "instantml_live".to_string(),
            scopes: vec!["sdk:ingest".to_string(), "usage:read".to_string()],
            project_id: None,
            created_at: ts(2),
            expires_at: None,
            last_used_at: None,
            revoked_at: None,
        };
        let route = TenantRouteRecord {
            org_id: org.id,
            status: "failed".to_string(),
            provisioner: "cloud-service".to_string(),
            plan_tier: Some("pro".to_string()),
            warehouse_kind: Some("standard".to_string()),
            requested_min_replica_memory_gb: Some(12),
            requested_max_replica_memory_gb: Some(12),
            requested_num_replicas: Some(1),
            applied_min_replica_memory_gb: Some(8),
            applied_max_replica_memory_gb: Some(8),
            applied_num_replicas: Some(1),
            endpoint: "https://user:secret@clickhouse.example.com:8443/db".to_string(),
            database: "tenant_acme".to_string(),
            username: "tenant_user".to_string(),
            password_secret_ref: Some("secret/ref".to_string()),
            password_ciphertext: Some("ciphertext".to_string()),
            schema_version: Some(1),
            service_id: Some("svc_123".to_string()),
            created_at: now,
            updated_at: now,
            error: Some("provider leaked internal details".to_string()),
        };

        let mut data = StoreData::default();
        data.insert_user(owner.clone());
        data.insert_org(org.clone());
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id: org.id,
            user_id: owner.id,
            role: "owner".to_string(),
            status: "active".to_string(),
            created_at: ts(1),
        });
        data.service_accounts
            .insert(service_account.id, service_account);
        data.insert_api_key(ApiKeyRecord {
            row: api_key,
            key_hash: vec![1, 2, 3],
        });
        data.insert_tenant_route(route);
        data
    }

    #[test]
    fn admin_overview_redacts_storage_and_key_secrets() {
        let data = base_data();
        let overview = build_admin_overview(
            &data,
            AdminOverviewOptions {
                q: None,
                limit: 10,
                data_counts_available: true,
            },
            Utc.with_ymd_and_hms(2026, 6, 24, 12, 0, 0).unwrap(),
        );
        let serialized = serde_json::to_string(&overview).unwrap();
        assert!(serialized.contains("clickhouse.example.com"));
        assert!(serialized.contains("route_error_recorded"));
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("ciphertext"));
        assert!(!serialized.contains("provider leaked"));
        assert!(!serialized.contains("key_hash"));
    }

    #[test]
    fn admin_overview_filters_across_org_users_and_keys() {
        let data = base_data();
        let overview = build_admin_overview(
            &data,
            AdminOverviewOptions {
                q: Some("acme".to_string()),
                limit: 10,
                data_counts_available: true,
            },
            Utc.with_ymd_and_hms(2026, 6, 24, 12, 0, 0).unwrap(),
        );
        assert_eq!(overview.query.matched_organizations, 1);
        assert_eq!(overview.query.matched_users, 1);
        assert_eq!(overview.query.matched_api_keys, 1);
        assert_eq!(overview.organizations[0].name, "Acme Research");
        assert_eq!(overview.users[0].primary_email, "owner@acme.test");
    }

    #[test]
    fn admin_overview_reports_storage_and_api_key_risks() {
        let data = base_data();
        let now = Utc.with_ymd_and_hms(2026, 6, 24, 12, 0, 0).unwrap();
        let overview = build_admin_overview(
            &data,
            AdminOverviewOptions {
                q: None,
                limit: 10,
                data_counts_available: true,
            },
            now,
        );
        assert_eq!(overview.organizations[0].risk_level, "high");
        assert!(overview
            .risks
            .iter()
            .any(|risk| risk.category == "storage" && risk.severity == "high"));
        assert!(overview
            .risks
            .iter()
            .any(|risk| risk.category == "api_key" && risk.message.contains("never been used")));
    }
}
