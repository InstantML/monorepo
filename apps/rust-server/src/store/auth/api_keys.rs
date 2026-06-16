use super::super::*;
use super::orgs::is_shared_demo_org;

pub(super) fn demo_api_key_scopes() -> Vec<String> {
    DEMO_API_KEY_SCOPES
        .iter()
        .map(|scope| (*scope).to_string())
        .collect()
}

pub(super) fn effective_api_key_scopes(data: &StoreData, record: &ApiKeyRecord) -> Vec<String> {
    if data
        .organizations
        .get(&record.row.org_id)
        .is_some_and(is_shared_demo_org)
    {
        return demo_api_key_scopes();
    }
    record.row.scopes.clone()
}

/// Mint a fresh `sdk:ingest`-scoped onboarding API key for a newly created org.
/// Returns `None` (and logs) on failure rather than aborting the signup.
pub(super) async fn mint_onboarding_api_key(
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
    ensure_billing_write_allowed(store, org_id, "create API keys").await?;
    require_org_storage_ready(&org)?;
    store.ensure_tenant_route(&org).await?;
    let project_id = {
        let data = store.data.lock().await;
        resolve_key_project(&data, org_id, input.project_id, input.project.as_deref())?
    };
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
    let mut data = store.data.lock().await;
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
    let mut record = {
        let data = store.data.lock().await;
        data.api_keys
            .get(&api_key_id)
            .cloned()
            .filter(|key| key.row.org_id == org_id)
            .ok_or_else(|| AppError::not_found("api key not found"))?
    };
    record.row.revoked_at = Some(Utc::now());
    store
        .persist_locked("api_key", org_id, &api_key_id.to_string(), &record)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_api_key(record.clone());
    Ok(record.row)
}

pub async fn disable_service_account(
    store: &Store,
    org_id: Uuid,
    service_account_id: Uuid,
) -> AppResult<ServiceAccountRow> {
    let mut row = {
        let data = store.data.lock().await;
        data.service_accounts
            .get(&service_account_id)
            .cloned()
            .filter(|account| account.org_id == org_id)
            .ok_or_else(|| AppError::not_found("service account not found"))?
    };
    row.disabled_at = Some(Utc::now());
    store
        .persist_locked("service_account", org_id, &row.id.to_string(), &row)
        .await?;
    let mut data = store.data.lock().await;
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
    use super::super::helpers::{SHARED_DEMO_ACCOUNT_TYPE, SHARED_DEMO_NAME};
    use super::*;

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
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        let mut data = StoreData::default();
        data.insert_org(org.clone());
        let record = api_key_record_for_org(
            org.id,
            vec![
                "sdk:ingest".to_string(),
                "artifacts:write".to_string(),
                "api_keys:write".to_string(),
                "runs:control".to_string(),
                "export:read".to_string(),
            ],
        );

        assert_eq!(
            effective_api_key_scopes(&data, &record),
            demo_api_key_scopes()
        );
        assert!(!effective_api_key_scopes(&data, &record).contains(&"api_keys:write".to_string()));
        assert!(!effective_api_key_scopes(&data, &record).contains(&"runs:control".to_string()));
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
            tenant_routing_tier: "shared".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        let mut data = StoreData::default();
        data.insert_org(org.clone());
        let requested = vec!["sdk:ingest".to_string(), "export:read".to_string()];
        let record = api_key_record_for_org(org.id, requested.clone());

        assert_eq!(effective_api_key_scopes(&data, &record), requested);
    }
}
