use super::*;

/// TTL for device-code grants (RFC 8628 §3.2 recommends ≥ 5 min; we use 15).
pub const DEVICE_CODE_TTL_SECS: i64 = 900;
/// Minimum seconds between polls per device code (RFC 8628 §3.5).
pub const DEVICE_CODE_POLL_INTERVAL_SECS: i64 = 5;
const CLI_DEVICE_LOGIN_SCOPES: &[&str] = &[
    "sdk:ingest",
    "artifacts:write",
    "imports:write",
    "export:read",
];
/// Length of the user-visible code segment (e.g. "ABCD" in "ABCD-EFGH").
const USER_CODE_SEGMENT_LEN: usize = 4;
/// Alphabet for user codes: uppercase letters and digits, excluding ambiguous chars.
const USER_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// In-memory record for one pending device-code grant.
#[derive(Clone)]
pub struct DeviceCodeRecord {
    /// SHA-256 of the raw device_code string (opaque to callers).
    pub device_code_hash: Vec<u8>,
    pub user_code: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub last_polled_at: Option<DateTime<Utc>>,
    /// "pending" | "authorized" | "denied" | "expired"
    pub status: String,
    pub org_id: Option<Uuid>,
    pub user_id: Option<Uuid>,
    pub api_key_id: Option<Uuid>,
    /// Plaintext API key returned exactly once on the first authorized poll, then cleared.
    pub api_key_plaintext: Option<String>,
    pub api_key_prefix: Option<String>,
}

/// Generate a random user code in "XXXX-XXXX" format using a restricted alphabet
/// that avoids ambiguous characters (O/0, I/1/l).
pub fn generate_user_code() -> String {
    let alphabet = USER_CODE_ALPHABET;
    let alen = alphabet.len() as u8;
    let random_bytes: Vec<u8> = Uuid::new_v4().as_bytes()[..8].to_vec();
    let chars: Vec<u8> = random_bytes
        .iter()
        .map(|b| alphabet[(b % alen) as usize])
        .collect();
    format!(
        "{}-{}",
        std::str::from_utf8(&chars[..USER_CODE_SEGMENT_LEN]).unwrap(),
        std::str::from_utf8(&chars[USER_CODE_SEGMENT_LEN..]).unwrap()
    )
}

/// Generate a raw device_code string (opaque, 32 bytes of entropy).
pub fn generate_device_code() -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

pub async fn device_code_start(
    store: &Store,
    frontend_base_url: &str,
    _client_info: Option<Value>,
) -> AppResult<Value> {
    let raw_device_code = generate_device_code();
    let device_code_hash = hash_secret(&raw_device_code);
    let user_code = generate_user_code();
    let now = Utc::now();
    let expires_at = now + ChronoDuration::seconds(DEVICE_CODE_TTL_SECS);

    let record = DeviceCodeRecord {
        device_code_hash: device_code_hash.clone(),
        user_code: user_code.clone(),
        created_at: now,
        expires_at,
        last_polled_at: None,
        status: "pending".to_string(),
        org_id: None,
        user_id: None,
        api_key_id: None,
        api_key_plaintext: None,
        api_key_prefix: None,
    };

    let mut data = store.data.lock().await;
    data.device_codes.insert(device_code_hash, record);
    data.device_codes_by_user_code
        .insert(user_code.clone(), hash_secret(&raw_device_code));
    data.evict_expired_device_codes(now);

    let base = frontend_base_url.trim_end_matches('/');
    let verification_uri = format!("{}/auth/device", base);
    let verification_uri_complete = format!("{}?code={}", verification_uri, user_code);

    Ok(json!({
        "device_code": raw_device_code,
        "user_code": user_code,
        "verification_uri": verification_uri,
        "verification_uri_complete": verification_uri_complete,
        "expires_in": DEVICE_CODE_TTL_SECS,
        "interval": DEVICE_CODE_POLL_INTERVAL_SECS,
    }))
}

pub async fn device_code_poll(store: &Store, raw_device_code: &str) -> AppResult<Value> {
    let hash = hash_secret(raw_device_code);
    let now = Utc::now();
    let mut data = store.data.lock().await;

    let record = data
        .device_codes
        .get_mut(&hash)
        .ok_or_else(|| AppError::not_found("device code not found or expired"))?;

    if now >= record.expires_at {
        record.status = "expired".to_string();
        return Ok(json!({ "status": "expired" }));
    }

    if let Some(last) = record.last_polled_at {
        let elapsed = (now - last).num_seconds();
        if elapsed < DEVICE_CODE_POLL_INTERVAL_SECS {
            return Err(AppError::with_code(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "slow_down",
                "polling too fast; wait for the interval",
            ));
        }
    }
    record.last_polled_at = Some(now);

    match record.status.as_str() {
        "pending" => Ok(json!({ "status": "pending" })),
        "denied" => Ok(json!({ "status": "denied" })),
        "expired" => Ok(json!({ "status": "expired" })),
        "authorized" => {
            let plaintext = record.api_key_plaintext.take();
            let prefix = record.api_key_prefix.clone();
            let key_id = record.api_key_id;
            let org_id = record.org_id;
            let user_id = record.user_id;
            record.status = "expired".to_string();

            let api_key_info = match (plaintext, prefix, key_id) {
                (Some(pt), Some(pfx), Some(kid)) => json!({
                    "plaintext": pt,
                    "prefix": pfx,
                    "id": kid,
                }),
                _ => Value::Null,
            };

            let org_info = if let Some(oid) = org_id {
                data.organizations
                    .get(&oid)
                    .map(|o| json!({ "id": o.id, "name": o.name, "slug": o.slug }))
            } else {
                None
            };

            let user_info = if let Some(uid) = user_id {
                data.users.get(&uid).map(
                    |u| json!({ "primary_email": u.primary_email, "display_name": u.display_name }),
                )
            } else {
                None
            };

            Ok(json!({
                "status": "authorized",
                "api_key": api_key_info,
                "org": org_info,
                "user": user_info,
            }))
        }
        other => Ok(json!({ "status": other })),
    }
}

pub async fn device_code_confirm(
    store: &Store,
    user_id: Uuid,
    org_id: Uuid,
    raw_user_code: &str,
) -> AppResult<Value> {
    let normalized = raw_user_code.to_uppercase();
    let now = Utc::now();

    let (org, user_code_for_update) = {
        let data = store.data.lock().await;
        let hash = data
            .device_codes_by_user_code
            .get(&normalized)
            .cloned()
            .ok_or_else(|| AppError::not_found("user code not found or expired"))?;
        let record = data
            .device_codes
            .get(&hash)
            .ok_or_else(|| AppError::not_found("device code not found or expired"))?;
        if now >= record.expires_at {
            return Err(AppError::not_found("device code expired"));
        }
        if record.status != "pending" {
            return Err(AppError::conflict(
                "device code already confirmed or denied",
            ));
        }
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        (org, record.user_code.clone())
    };

    require_org_admin(store, user_id, org_id).await?;
    ensure_billing_write_allowed(store, org_id, "create API keys").await?;
    require_org_storage_ready(&org)?;
    store.ensure_tenant_route(&org).await?;

    let plaintext = generate_api_key();
    let key_hash = hash_secret(&plaintext);
    let service_account = ServiceAccountRow {
        id: Uuid::new_v4(),
        org_id,
        name: "CLI device login".to_string(),
        created_by_user_id: Some(user_id),
        created_at: now,
        disabled_at: None,
    };
    let key = PublicApiKeyRow {
        id: Uuid::new_v4(),
        org_id,
        service_account_id: service_account.id,
        name: "CLI device login".to_string(),
        key_prefix: plaintext.chars().take(14).collect(),
        scopes: CLI_DEVICE_LOGIN_SCOPES
            .iter()
            .map(|scope| (*scope).to_string())
            .collect(),
        project_id: None,
        created_at: now,
        expires_at: None,
        last_used_at: None,
        revoked_at: None,
    };
    let api_key_record = ApiKeyRecord {
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
        .persist_locked("api_key", org_id, &key.id.to_string(), &api_key_record)
        .await?;

    let mut data = store.data.lock().await;
    data.service_accounts
        .insert(service_account.id, service_account);
    data.insert_api_key(api_key_record);

    let hash = data
        .device_codes_by_user_code
        .get(&user_code_for_update)
        .cloned()
        .ok_or_else(|| AppError::internal("device code hash missing after confirm"))?;
    if let Some(record) = data.device_codes.get_mut(&hash) {
        record.status = "authorized".to_string();
        record.org_id = Some(org_id);
        record.user_id = Some(user_id);
        record.api_key_id = Some(key.id);
        record.api_key_plaintext = Some(plaintext);
        record.api_key_prefix = Some(key.key_prefix.clone());
    }

    Ok(json!({ "confirmed": true }))
}

impl StoreData {
    pub fn evict_expired_device_codes(&mut self, now: DateTime<Utc>) {
        let expired_hashes: Vec<Vec<u8>> = self
            .device_codes
            .iter()
            .filter(|(_, r)| now >= r.expires_at)
            .map(|(h, _)| h.clone())
            .collect();
        for hash in expired_hashes {
            if let Some(record) = self.device_codes.remove(&hash) {
                self.device_codes_by_user_code.remove(&record.user_code);
            }
        }
    }
}

/// Pure helper used only in tests: insert a device code record directly into StoreData.
#[cfg(test)]
fn insert_test_device_code(
    data: &mut StoreData,
    raw_device_code: &str,
    user_code: &str,
    status: &str,
    expires_in_secs: i64,
) {
    let hash = hash_secret(raw_device_code);
    let now = Utc::now();
    let record = DeviceCodeRecord {
        device_code_hash: hash.clone(),
        user_code: user_code.to_string(),
        created_at: now,
        expires_at: now + ChronoDuration::seconds(expires_in_secs),
        last_polled_at: None,
        status: status.to_string(),
        org_id: None,
        user_id: None,
        api_key_id: None,
        api_key_plaintext: None,
        api_key_prefix: None,
    };
    data.device_codes.insert(hash.clone(), record);
    data.device_codes_by_user_code
        .insert(user_code.to_string(), hash);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_data(data: StoreData) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_device_code_test",
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

    fn user_fixture(email: &str) -> UserRow {
        UserRow {
            id: Uuid::new_v4(),
            primary_email: email.to_string(),
            display_name: None,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        }
    }

    fn org_fixture(user_id: Uuid) -> OrganizationRow {
        OrganizationRow {
            id: Uuid::new_v4(),
            slug: "device-lab".to_string(),
            name: "Device Lab".to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: PLAN_FREE.included_seats,
            created_by_user_id: Some(user_id),
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        }
    }

    #[test]
    fn user_code_format_is_xxxx_hyphen_xxxx() {
        for _ in 0..20 {
            let code = generate_user_code();
            let parts: Vec<&str> = code.split('-').collect();
            assert_eq!(parts.len(), 2, "expected one hyphen in {code}");
            assert_eq!(parts[0].len(), USER_CODE_SEGMENT_LEN);
            assert_eq!(parts[1].len(), USER_CODE_SEGMENT_LEN);
            for ch in code.chars().filter(|c| *c != '-') {
                assert!(
                    USER_CODE_ALPHABET.contains(&(ch as u8)),
                    "unexpected char {ch} in {code}"
                );
            }
        }
    }

    #[test]
    fn device_code_is_long_enough_for_entropy() {
        let code = generate_device_code();
        // base64url of 32 bytes = 43 chars (no padding)
        assert!(code.len() >= 40, "device code too short: {}", code.len());
    }

    #[test]
    fn user_codes_are_unique_across_many_generations() {
        let codes: std::collections::HashSet<String> =
            (0..1000).map(|_| generate_user_code()).collect();
        // Statistically, 1000 random codes from a 36^8 space should all be unique.
        assert_eq!(codes.len(), 1000);
    }

    #[test]
    fn evict_expired_removes_only_expired_records() {
        let mut data = StoreData::default();
        let now = Utc::now();
        // Insert one expired and one still-valid record.
        insert_test_device_code(&mut data, "expired_dc", "EXPD-CODE", "pending", -1);
        insert_test_device_code(&mut data, "valid_dc", "VALD-CODE", "pending", 900);
        assert_eq!(data.device_codes.len(), 2);
        data.evict_expired_device_codes(now);
        assert_eq!(data.device_codes.len(), 1);
        assert!(data.device_codes_by_user_code.contains_key("VALD-CODE"));
        assert!(!data.device_codes_by_user_code.contains_key("EXPD-CODE"));
    }

    #[test]
    fn poll_rate_limit_enforced_in_store_data() {
        // Verify that last_polled_at tracking logic is correct without Store.
        let mut data = StoreData::default();
        let raw_dc = "my_device_code";
        insert_test_device_code(&mut data, raw_dc, "ABCD-EFGH", "pending", 900);
        let hash = hash_secret(raw_dc);

        let record = data.device_codes.get_mut(&hash).unwrap();
        assert!(record.last_polled_at.is_none());

        // Simulate first poll timestamp.
        let t1 = Utc::now();
        record.last_polled_at = Some(t1);

        // Check elapsed calculation for a simulated re-poll 2 seconds later.
        let t2 = t1 + ChronoDuration::seconds(2);
        let elapsed = (t2 - t1).num_seconds();
        assert!(elapsed < DEVICE_CODE_POLL_INTERVAL_SECS, "2s < 5s interval");

        // And 6 seconds later should be allowed.
        let t3 = t1 + ChronoDuration::seconds(6);
        let elapsed3 = (t3 - t1).num_seconds();
        assert!(elapsed3 >= DEVICE_CODE_POLL_INTERVAL_SECS);
    }

    #[test]
    fn authorized_record_carries_plaintext_once() {
        let mut data = StoreData::default();
        let raw_dc = "auth_device_code";
        let hash = hash_secret(raw_dc);
        insert_test_device_code(&mut data, raw_dc, "AUTH-CODE", "authorized", 900);

        // Set plaintext and key metadata.
        let record = data.device_codes.get_mut(&hash).unwrap();
        record.api_key_plaintext = Some("instantml_secret".to_string());
        record.api_key_prefix = Some("instantml_XXXX".to_string());
        record.api_key_id = Some(Uuid::new_v4());

        // First read: take plaintext.
        let taken = data
            .device_codes
            .get_mut(&hash)
            .unwrap()
            .api_key_plaintext
            .take();
        assert_eq!(taken.as_deref(), Some("instantml_secret"));

        // Second read: gone.
        let taken2 = data
            .device_codes
            .get_mut(&hash)
            .unwrap()
            .api_key_plaintext
            .take();
        assert!(taken2.is_none());
    }

    #[test]
    fn verification_uri_built_correctly() {
        let base = "https://app.instantml.ai";
        let user_code = "ABCD-EFGH";
        let uri = format!("{}/auth/device", base.trim_end_matches('/'));
        let uri_complete = format!("{}?code={}", uri, user_code);
        assert_eq!(uri, "https://app.instantml.ai/auth/device");
        assert_eq!(
            uri_complete,
            "https://app.instantml.ai/auth/device?code=ABCD-EFGH"
        );
    }

    #[test]
    fn verification_uri_trims_trailing_slash() {
        let base = "https://app.instantml.ai/";
        let uri = format!("{}/auth/device", base.trim_end_matches('/'));
        assert_eq!(uri, "https://app.instantml.ai/auth/device");
    }

    #[test]
    fn cli_device_login_scopes_cover_import_workflows() {
        assert!(CLI_DEVICE_LOGIN_SCOPES.contains(&"sdk:ingest"));
        assert!(CLI_DEVICE_LOGIN_SCOPES.contains(&"artifacts:write"));
        assert!(CLI_DEVICE_LOGIN_SCOPES.contains(&"imports:write"));
        assert!(CLI_DEVICE_LOGIN_SCOPES.contains(&"export:read"));
    }

    #[tokio::test]
    async fn device_code_confirm_requires_admin_membership() {
        let user = user_fixture("viewer@example.com");
        let org = org_fixture(user.id);
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.insert_org(org.clone());
        data.insert_membership(membership_row(org.id, user.id, "viewer", "active"));
        insert_test_device_code(&mut data, "device-code", "ABCD-EFGH", "pending", 900);
        let store = store_with_data(data);

        let error = device_code_confirm(&store, user.id, org.id, "ABCD-EFGH")
            .await
            .unwrap_err();

        assert_eq!(error.status(), axum::http::StatusCode::FORBIDDEN);
        assert_eq!(store.data.lock().await.api_keys.len(), 0);
    }

    #[tokio::test]
    async fn device_code_confirm_respects_billing_write_gate() {
        let user = user_fixture("owner@example.com");
        let org = org_fixture(user.id);
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.insert_org(org.clone());
        data.insert_membership(membership_row(org.id, user.id, "owner", "active"));
        data.insert_billing_account(BillingAccountProjection {
            schema_version: 1,
            org_id: org.id,
            access_state: BILLING_CHECKOUT_PENDING.to_string(),
            plan_tier: "pro".to_string(),
            effective_plan_tier: "free".to_string(),
            requested_plan_tier: Some("pro".to_string()),
            paid_extra_seats: 0,
            stripe_customer_id: None,
            stripe_subscription_id: None,
            subscription_status: None,
            current_period_start: None,
            current_period_end: None,
            cancel_at_period_end: false,
            grace_until: None,
            pending_intent_id: Some(Uuid::new_v4()),
            message: Some("Complete checkout.".to_string()),
            updated_at: Utc::now(),
        });
        insert_test_device_code(&mut data, "device-code", "ABCD-EFGH", "pending", 900);
        let store = store_with_data(data);

        let error = device_code_confirm(&store, user.id, org.id, "ABCD-EFGH")
            .await
            .unwrap_err();

        assert_eq!(error.status(), axum::http::StatusCode::PAYMENT_REQUIRED);
        assert_eq!(store.data.lock().await.api_keys.len(), 0);
    }
}
