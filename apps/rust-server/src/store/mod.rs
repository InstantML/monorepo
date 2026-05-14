use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    artifact_store::LocalArtifactStore,
    auth::{generate_api_key, generate_session_token, hash_idempotency, hash_secret},
    config::AppConfig,
    domain::{
        validate_account_type, validate_email, validate_json_object, validate_limit,
        validate_membership_role, validate_name, validate_offset, validate_optional_name,
        validate_optional_step, validate_plan_tier, validate_slug, validate_status, validate_step,
        validate_tags, validate_timestamp, ArtifactRow, AttributeInput, AttributeRow, AuthContext,
        AuthSessionPayload, CreateApiKeyRequest, CreateArtifactRequest, CreateAttributesRequest,
        CreateObjectRequest, CreateOrganizationRequest, CreateProjectRequest, CreateRunRequest,
        CreateUserRequest, CreatedAuthSession, DevGoogleAuthRequest, LogMetricsRequest,
        MembershipRow, MetricSeriesRow, OrganizationRow, ProjectRow, PublicApiKeyRow,
        RequestContext, ReserveSeatRequest, RunRow, ServiceAccountRow, UpdateRunRequest,
        UploadArtifactRequest, UserRow, UserSessionRow, DEFAULT_METRIC_LIMIT, DEFAULT_RUN_LIMIT,
        MAX_METRICS_PER_BATCH, MAX_METRIC_LIMIT, MAX_METRIC_SERIES_RUN_IDS, MAX_RUN_LIMIT,
    },
    errors::{AppError, AppResult},
    metric_store::{
        MetricPointRow as ChMetricPointRow, MetricStore, OperationalRecordRow, SeriesReadRow,
    },
};

pub const LOCAL_ORG_ID: Uuid = Uuid::from_u128(1);
const LOCAL_ORG_SLUG: &str = "local";
const DEFAULT_API_KEY_SCOPES: &[&str] = &[
    "sdk:ingest",
    "artifacts:write",
    "imports:write",
    "export:read",
];
const ONBOARDING_API_KEY_SCOPES: &[&str] = &["sdk:ingest", "artifacts:write", "export:read"];
const ALLOWED_SCOPES: &[&str] = &[
    "sdk:ingest",
    "artifacts:write",
    "imports:write",
    "usage:read",
    "export:read",
    "api_keys:write",
];
const SESSION_TTL_DAYS: i64 = 30;
const MAX_EXPORT_RUNS: usize = 500;
const MAX_EXPORT_METRICS: i64 = 100_000;
const MAX_EXPORT_ATTRIBUTES: usize = 25_000;
const MAX_EXPORT_ARTIFACTS: usize = 10_000;
const MAX_EXPORT_TABLE_OBJECT_ROWS: usize = 25_000;
const MAX_SIDE_BY_SIDE_RUNS: usize = 50;
const MAX_SIDE_BY_SIDE_ROWS: usize = 5_000;
const MAX_ARTIFACT_LIST: i64 = 1_000;
const DEFAULT_OBJECT_LIMIT: i64 = 100;
const MAX_OBJECT_LIMIT: i64 = 500;
const DEFAULT_OBJECT_ROW_LIMIT: i64 = 100;
const MAX_OBJECT_ROW_LIMIT: i64 = 1_000;
const MAX_OBJECT_METADATA_BYTES: usize = 16_384;
const MAX_OBJECT_SUMMARY_BYTES: usize = 16_384;
const MAX_TABLE_ROWS_PER_CREATE: usize = 1_000;
const MAX_TABLE_ROW_BYTES: usize = 16_384;
const MAX_TABLE_COLUMNS: usize = 128;
const MAX_HISTOGRAM_BINS: usize = 1_024;
const MAX_IMPORT_LIST: i64 = 500;
const DEMO_RUN_COUNT: usize = 1_000;
const DEMO_STEPS: [i64; 6] = [0, 40, 80, 120, 160, 200];

#[derive(Clone)]
pub struct Store {
    metric_store: MetricStore,
    data: Arc<Mutex<StoreData>>,
    record_clock_micros: Arc<Mutex<i64>>,
}

impl Store {
    pub async fn connect(metric_store: MetricStore) -> AppResult<Self> {
        let store = Self {
            metric_store,
            data: Arc::new(Mutex::new(StoreData::default())),
            record_clock_micros: Arc::new(Mutex::new(0)),
        };
        store.rebuild().await?;
        store.ensure_local_org().await?;
        Ok(store)
    }

    pub fn metric_store(&self) -> &MetricStore {
        &self.metric_store
    }

    async fn rebuild(&self) -> AppResult<()> {
        let records = self.metric_store.load_operational_records().await?;
        let latest_record_micros = records
            .iter()
            .map(|record| record.created_at.timestamp_micros())
            .max()
            .unwrap_or(0);
        let mut data = StoreData::default();
        for record in records {
            data.apply_record(&record.kind, &record.payload)?;
        }
        data.recompute_counters();
        *self.data.lock().await = data;
        *self.record_clock_micros.lock().await = latest_record_micros;
        Ok(())
    }

    async fn ensure_local_org(&self) -> AppResult<()> {
        let mut data = self.data.lock().await;
        if data.organizations.contains_key(&LOCAL_ORG_ID) {
            return Ok(());
        }
        let org = OrganizationRow {
            id: LOCAL_ORG_ID,
            slug: LOCAL_ORG_SLUG.to_string(),
            name: "Local".to_string(),
            plan_tier: "free".to_string(),
            account_type: "customer".to_string(),
            seat_limit: 1,
            created_by_user_id: None,
            created_at: epoch(),
        };
        self.persist_locked(
            "organization",
            LOCAL_ORG_ID,
            &LOCAL_ORG_ID.to_string(),
            &org,
        )
        .await?;
        data.insert_org(org);
        Ok(())
    }

    async fn persist_locked<T: Serialize>(
        &self,
        kind: &str,
        org_id: Uuid,
        entity_id: &str,
        payload: &T,
    ) -> AppResult<()> {
        let row = OperationalRecordRow {
            kind: kind.to_string(),
            org_id,
            entity_id: entity_id.to_string(),
            payload: serde_json::to_string(payload)
                .map_err(|_| AppError::internal("operational payload serialization failed"))?,
            created_at: self.next_record_created_at().await,
        };
        self.metric_store.insert_operational_record(&row).await
    }

    async fn next_record_created_at(&self) -> DateTime<Utc> {
        let mut clock = self.record_clock_micros.lock().await;
        let next = Utc::now().timestamp_micros().max(*clock + 1);
        *clock = next;
        datetime_from_micros(next)
    }
}

#[derive(Default)]
struct StoreData {
    users: BTreeMap<Uuid, UserRow>,
    users_by_email: HashMap<String, Uuid>,
    identities: HashMap<(String, String), Uuid>,
    organizations: BTreeMap<Uuid, OrganizationRow>,
    orgs_by_slug: HashMap<String, Uuid>,
    memberships: BTreeMap<Uuid, MembershipRow>,
    sessions: BTreeMap<Uuid, SessionRecord>,
    sessions_by_hash: HashMap<Vec<u8>, Uuid>,
    service_accounts: BTreeMap<Uuid, ServiceAccountRow>,
    api_keys: BTreeMap<Uuid, ApiKeyRecord>,
    api_keys_by_hash: HashMap<Vec<u8>, Uuid>,
    projects: BTreeMap<Uuid, ProjectRow>,
    projects_by_org_name: HashMap<(Uuid, String), Uuid>,
    runs: BTreeMap<Uuid, RunRow>,
    attributes: BTreeMap<i64, AttributeRow>,
    attributes_by_run: HashMap<Uuid, Vec<i64>>,
    artifacts: BTreeMap<Uuid, ArtifactRow>,
    artifacts_by_run: HashMap<Uuid, Vec<Uuid>>,
    table_rows: HashMap<i64, Vec<TableObjectRow>>,
    imports: BTreeMap<i64, ImportRow>,
    idempotency: HashMap<(Uuid, String), IdempotencyRecord>,
    usage_daily: Vec<Value>,
    next_attribute_id: i64,
    next_import_id: i64,
}

impl StoreData {
    fn apply_record(&mut self, kind: &str, payload: &str) -> AppResult<()> {
        match kind {
            "user" => self.insert_user(parse_payload(payload)?),
            "identity" => {
                let item: IdentityRecord = parse_payload(payload)?;
                self.identities
                    .insert((item.provider, item.provider_subject), item.user_id);
            }
            "organization" => self.insert_org(parse_payload(payload)?),
            "membership" => self.insert_membership(parse_payload(payload)?),
            "session" => self.insert_session(parse_payload(payload)?),
            "service_account" => {
                let row: ServiceAccountRow = parse_payload(payload)?;
                self.service_accounts.insert(row.id, row);
            }
            "api_key" => self.insert_api_key(parse_payload(payload)?),
            "project" => self.insert_project(parse_payload(payload)?),
            "project_delete" => self.apply_project_delete(parse_payload(payload)?),
            "run" => self.insert_run(parse_payload(payload)?),
            "attribute" => self.insert_attribute(parse_payload(payload)?),
            "artifact" => self.insert_artifact(parse_payload(payload)?),
            "table_rows" => {
                let item: TableRowsRecord = parse_payload(payload)?;
                self.table_rows.insert(item.attribute_id, item.rows);
            }
            "import" => {
                let item: ImportRow = parse_payload(payload)?;
                self.imports.insert(item.id, item);
            }
            "idempotency" => {
                let item: IdempotencyRecord = parse_payload(payload)?;
                self.idempotency
                    .insert((item.org_id, item.key.clone()), item);
            }
            "usage_daily" => self.usage_daily.push(parse_payload(payload)?),
            _ => {}
        }
        Ok(())
    }

    fn recompute_counters(&mut self) {
        self.next_attribute_id = self.attributes.keys().last().copied().unwrap_or(0) + 1;
        self.next_import_id = self.imports.keys().last().copied().unwrap_or(0) + 1;
    }

    fn insert_user(&mut self, user: UserRow) {
        self.users_by_email
            .insert(user.primary_email.to_ascii_lowercase(), user.id);
        self.users.insert(user.id, user);
    }

    fn insert_org(&mut self, org: OrganizationRow) {
        self.orgs_by_slug.insert(org.slug.clone(), org.id);
        self.organizations.insert(org.id, org);
    }

    fn insert_membership(&mut self, membership: MembershipRow) {
        self.memberships.insert(membership.id, membership);
    }

    fn insert_session(&mut self, session: SessionRecord) {
        self.sessions_by_hash
            .insert(session.token_hash.clone(), session.row.id);
        self.sessions.insert(session.row.id, session);
    }

    fn insert_api_key(&mut self, key: ApiKeyRecord) {
        self.api_keys_by_hash
            .insert(key.key_hash.clone(), key.row.id);
        self.api_keys.insert(key.row.id, key);
    }

    fn insert_project(&mut self, project: ProjectRow) {
        self.projects_by_org_name
            .insert((project.org_id, project.name.clone()), project.id);
        self.projects.insert(project.id, project);
    }

    fn insert_run(&mut self, run: RunRow) {
        self.runs.insert(run.id, run);
    }

    fn insert_attribute(&mut self, attribute: AttributeRow) {
        self.next_attribute_id = self.next_attribute_id.max(attribute.id + 1);
        self.attributes_by_run
            .entry(attribute.run_id)
            .or_default()
            .retain(|id| *id != attribute.id);
        self.attributes_by_run
            .entry(attribute.run_id)
            .or_default()
            .push(attribute.id);
        self.attributes.insert(attribute.id, attribute);
    }

    fn insert_artifact(&mut self, artifact: ArtifactRow) {
        self.artifacts_by_run
            .entry(artifact.run_id)
            .or_default()
            .retain(|id| *id != artifact.id);
        self.artifacts_by_run
            .entry(artifact.run_id)
            .or_default()
            .push(artifact.id);
        self.artifacts.insert(artifact.id, artifact);
    }

    fn apply_project_delete(&mut self, delete: ProjectDeleteRecord) {
        let Some(project_id) = self
            .projects_by_org_name
            .remove(&(delete.org_id, delete.project_name))
        else {
            return;
        };
        self.projects.remove(&project_id);
        let run_ids = self
            .runs
            .values()
            .filter(|run| run.org_id == delete.org_id && run.project_id == project_id)
            .map(|run| run.id)
            .collect::<Vec<_>>();
        for run_id in run_ids {
            self.runs.remove(&run_id);
            if let Some(attribute_ids) = self.attributes_by_run.remove(&run_id) {
                for id in attribute_ids {
                    self.attributes.remove(&id);
                    self.table_rows.remove(&id);
                }
            }
            if let Some(artifact_ids) = self.artifacts_by_run.remove(&run_id) {
                for id in artifact_ids {
                    self.artifacts.remove(&id);
                }
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct IdentityRecord {
    user_id: Uuid,
    provider: String,
    provider_subject: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct SessionRecord {
    row: UserSessionRow,
    token_hash: Vec<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ApiKeyRecord {
    row: PublicApiKeyRow,
    key_hash: Vec<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
struct IdempotencyRecord {
    org_id: Uuid,
    key: String,
    request_hash: Vec<u8>,
    response_json: Value,
    expires_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ImportRow {
    id: i64,
    org_id: Uuid,
    project_id: Option<Uuid>,
    source_type: String,
    status: String,
    summary: Value,
    run_ids: Vec<Uuid>,
    created_at: DateTime<Utc>,
    completed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct TableObjectRow {
    row_index: i64,
    row: Value,
    created_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
struct TableRowsRecord {
    attribute_id: i64,
    rows: Vec<TableObjectRow>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ProjectDeleteRecord {
    org_id: Uuid,
    project_name: String,
}

fn parse_payload<T: for<'de> Deserialize<'de>>(payload: &str) -> AppResult<T> {
    serde_json::from_str(payload)
        .map_err(|_| AppError::internal("stored operational record is invalid"))
}

pub async fn ready(store: &Store) -> bool {
    crate::metric_store::ready(store.metric_store()).await
}

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
    let email = validate_email(input.email.as_deref())?;
    let display_name = validate_optional_name(input.display_name.as_deref(), "display_name")?;
    let account_type = validate_account_type(input.account_type.as_deref())?;
    let seat_emails = input.seat_emails.unwrap_or_default();
    let org_name = validate_name(
        input.org_name.as_deref().or(Some("Personal Workspace")),
        "organization",
    )?;
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
    if let Some(org) = data
        .memberships
        .values()
        .filter(|membership| membership.user_id == user.id && membership.status == "active")
        .filter_map(|membership| data.organizations.get(&membership.org_id))
        .find(|org| org.name == org_name && org.account_type == account_type)
        .cloned()
    {
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
    let mut data = store.data.lock().await;
    if !data.organizations.contains_key(&org_id) {
        return Err(AppError::not_found("organization not found"));
    }
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

pub async fn create_project(
    store: &Store,
    ctx: &RequestContext,
    input: CreateProjectRequest,
) -> AppResult<ProjectRow> {
    if let Some(auth) = &ctx.auth {
        if auth.project_id.is_some() {
            return Err(AppError::forbidden(
                "project-scoped API keys cannot create projects",
            ));
        }
    }
    let name = validate_name(input.name.as_deref(), "project name")?;
    let description = validate_optional_name(input.description.as_deref(), "project description")?;
    let mut data = store.data.lock().await;
    if let Some(project_id) = data
        .projects_by_org_name
        .get(&(ctx.org_id, name.clone()))
        .copied()
    {
        return data
            .projects
            .get(&project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("project not found"));
    }
    let project = ProjectRow {
        id: Uuid::new_v4(),
        org_id: ctx.org_id,
        name,
        description,
        created_at: Utc::now(),
    };
    store
        .persist_locked("project", ctx.org_id, &project.id.to_string(), &project)
        .await?;
    data.insert_project(project.clone());
    Ok(project)
}

pub async fn list_projects(store: &Store, ctx: &RequestContext) -> AppResult<Vec<ProjectRow>> {
    let data = store.data.lock().await;
    let mut projects = data
        .projects
        .values()
        .filter(|project| project.org_id == ctx.org_id)
        .filter(|project| {
            ctx.auth
                .as_ref()
                .and_then(|auth| auth.project_id)
                .map(|id| id == project.id)
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    projects.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(projects)
}

pub async fn create_run(
    store: &Store,
    ctx: &RequestContext,
    input: CreateRunRequest,
) -> AppResult<RunRow> {
    let project_name = validate_name(input.project.as_deref(), "project")?;
    let name = validate_name(input.name.as_deref().or(Some("run")), "run name")?;
    let config = validate_json_object(input.config, "config")?;
    let tags = validate_tags(input.tags)?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    let mut data = store.data.lock().await;
    let project_id = match data
        .projects_by_org_name
        .get(&(ctx.org_id, project_name.clone()))
        .copied()
    {
        Some(id) => id,
        None => {
            if let Some(auth) = &ctx.auth {
                if auth.project_id.is_some() {
                    return Err(AppError::forbidden(
                        "project-scoped API key cannot create a different project",
                    ));
                }
            }
            let project = ProjectRow {
                id: Uuid::new_v4(),
                org_id: ctx.org_id,
                name: project_name.clone(),
                description: None,
                created_at: Utc::now(),
            };
            store
                .persist_locked("project", ctx.org_id, &project.id.to_string(), &project)
                .await?;
            let id = project.id;
            data.insert_project(project);
            id
        }
    };
    if let Some(auth) = &ctx.auth {
        if auth.project_id.is_some_and(|id| id != project_id) {
            return Err(AppError::forbidden("run belongs to a different project"));
        }
    }
    let run = RunRow {
        id: Uuid::new_v4(),
        org_id: ctx.org_id,
        project_id,
        project: project_name,
        name,
        status: "running".to_string(),
        config,
        tags,
        metadata,
        created_at: Utc::now(),
        started_at: Utc::now(),
        finished_at: None,
    };
    store
        .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
        .await?;
    data.insert_run(run.clone());
    Ok(run)
}

pub async fn update_run(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: UpdateRunRequest,
) -> AppResult<RunRow> {
    let mut data = store.data.lock().await;
    let mut run = fetch_run_in_data(&data, ctx, run_id)?;
    if input.status.is_none() && input.tags.is_none() && input.notes.is_none() {
        return Err(AppError::validation(
            "at least one of status, tags, or notes is required",
        ));
    }
    if let Some(status) = input.status {
        run.status = validate_status(&status)?;
        if matches!(run.status.as_str(), "finished" | "failed") && run.finished_at.is_none() {
            run.finished_at = Some(Utc::now());
        }
    }
    if let Some(tags) = input.tags {
        run.tags = validate_tags(Some(tags))?;
    }
    if let Some(notes) = input.notes {
        let metadata = run
            .metadata
            .as_object_mut()
            .ok_or_else(|| AppError::validation("metadata must be an object"))?;
        if notes.trim().is_empty() {
            metadata.remove("notes");
        } else {
            metadata.insert(
                "notes".to_string(),
                json!(validate_name(Some(&notes), "notes")?),
            );
        }
    }
    store
        .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
        .await?;
    data.insert_run(run.clone());
    Ok(run)
}

pub async fn get_run(store: &Store, ctx: &RequestContext, run_id: Uuid) -> AppResult<Value> {
    let run = {
        let data = store.data.lock().await;
        fetch_run_in_data(&data, ctx, run_id)?
    };
    run_summary_value(store, run).await
}

pub async fn list_runs(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_RUN_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let runs = filtered_runs(store, ctx, query).await?;
    let values = summarize_runs(store, runs.into_iter().skip(offset).take(limit).collect()).await?;
    Ok(json!({ "runs": values }))
}

pub async fn overview(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let runs = filtered_runs(store, ctx, query).await?;
    let total_runs = runs.len();
    let active_runs = runs.iter().filter(|run| run.status == "running").count();
    let failed_runs = runs.iter().filter(|run| run.status == "failed").count();
    let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_key = query
        .get("metric_key")
        .map(String::as_str)
        .unwrap_or("eval/return_mean");
    let series =
        metric_series_for_runs_key(store.metric_store(), ctx.org_id, &run_ids, metric_key).await?;
    let best_eval_return = series
        .iter()
        .filter_map(|row| row.best)
        .max_by(|a, b| a.total_cmp(b));
    let metric_points = store
        .metric_store()
        .count_points_for_runs(ctx.org_id, &run_ids)
        .await
        .unwrap_or(0);
    Ok(json!({
        "overview": {
            "total_runs": total_runs,
            "active_runs": active_runs,
            "failed_runs": failed_runs,
            "best_eval_return": best_eval_return,
            "metric_points": metric_points
        }
    }))
}

pub async fn runs_summary(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_RUN_LIMIT,
    )? as usize;
    let offset = if let Some(cursor) = query.get("cursor") {
        cursor
            .strip_prefix("offset:")
            .and_then(|raw| raw.parse::<usize>().ok())
            .unwrap_or(0)
    } else {
        validate_offset(query.get("offset").map(String::as_str))? as usize
    };
    let all_runs = filtered_runs(store, ctx, query).await?;
    let total = all_runs.len();
    let page_runs = all_runs
        .iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let run_ids = all_runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_keys = store
        .metric_store()
        .query_keys_for_runs(ctx.org_id, &run_ids, 250_i64)
        .await?;
    let next_offset = offset + page_runs.len();
    let has_next = next_offset < total;
    Ok(json!({
        "runs": summarize_runs(store, page_runs).await?,
        "metric_keys": metric_keys,
        "total": total,
        "next_cursor": if has_next { json!(format!("offset:{next_offset}")) } else { Value::Null },
        "page_info": { "pagination": "cursor", "has_next_page": has_next }
    }))
}

async fn filtered_runs(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Vec<RunRow>> {
    let project = query
        .get("project")
        .filter(|value| !value.is_empty() && value.as_str() != "all");
    let status = query
        .get("status")
        .filter(|value| !value.is_empty() && value.as_str() != "all");
    let tokens = query
        .get("q")
        .map(|q| {
            q.split_whitespace()
                .map(|part| part.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut runs = {
        let data = store.data.lock().await;
        data.runs
            .values()
            .filter(|run| run.org_id == ctx.org_id)
            .filter(|run| {
                ctx.auth
                    .as_ref()
                    .and_then(|auth| auth.project_id)
                    .map(|id| id == run.project_id)
                    .unwrap_or(true)
            })
            .filter(|run| project.map(|name| run.project == *name).unwrap_or(true))
            .filter(|run| status.map(|value| run.status == *value).unwrap_or(true))
            .filter(|run| {
                if tokens.is_empty() {
                    return true;
                }
                let haystack = run_search_text(run);
                tokens.iter().all(|token| haystack.contains(token))
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    let sort_by = validate_run_sort(
        query
            .get("sort_by")
            .map(String::as_str)
            .unwrap_or("created"),
    )?;
    let metric_key = query
        .get("metric_key")
        .map(String::as_str)
        .unwrap_or("eval/return_mean");
    match sort_by.as_str() {
        "metric-latest" | "metric-best" => {
            let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
            let series =
                metric_series_for_runs_key(store.metric_store(), ctx.org_id, &run_ids, metric_key)
                    .await?
                    .into_iter()
                    .map(|row| (row.run_id, row))
                    .collect::<HashMap<_, _>>();
            sort_runs_by_metric(&mut runs, &sort_by, metric_key, &series);
        }
        "duration" => runs.sort_by(|a, b| {
            numeric_desc(duration_seconds(a), duration_seconds(b))
                .then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "name" => runs.sort_by(|a, b| {
            a.name
                .cmp(&b.name)
                .then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "status" => runs.sort_by(|a, b| {
            a.status
                .cmp(&b.status)
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "created" => runs.sort_by_key(|run| std::cmp::Reverse(run.created_at)),
        _ => unreachable!("validate_run_sort restricts values"),
    }
    Ok(runs)
}

fn validate_run_sort(sort_by: &str) -> AppResult<String> {
    let sort_by = validate_name(Some(sort_by), "sort_by")?;
    if matches!(
        sort_by.as_str(),
        "created" | "duration" | "metric-best" | "metric-latest" | "name" | "status"
    ) {
        Ok(sort_by)
    } else {
        Err(AppError::validation(
            "sort_by must be one of: created, duration, metric-best, metric-latest, name, status",
        ))
    }
}

fn sort_runs_by_metric(
    runs: &mut [RunRow],
    sort_by: &str,
    metric_key: &str,
    series: &HashMap<Uuid, MetricSeriesRow>,
) {
    runs.sort_by(|a, b| {
        let left = metric_sort_value(series.get(&a.id), sort_by, metric_key);
        let right = metric_sort_value(series.get(&b.id), sort_by, metric_key);
        let order = if sort_by == "metric-best" && is_minimize_metric(metric_key) {
            numeric_asc(left, right)
        } else {
            numeric_desc(left, right)
        };
        order.then_with(|| b.created_at.cmp(&a.created_at))
    });
}

fn metric_sort_value(
    series: Option<&MetricSeriesRow>,
    sort_by: &str,
    metric_key: &str,
) -> Option<f64> {
    let series = series?;
    if sort_by == "metric-latest" {
        return series.latest;
    }
    if is_minimize_metric(metric_key) {
        series.min
    } else {
        series.max
    }
}

fn is_minimize_metric(key: &str) -> bool {
    key.split(['/', '_']).any(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "loss"
                | "error"
                | "err"
                | "perplexity"
                | "ppl"
                | "wer"
                | "cer"
                | "mae"
                | "mse"
                | "rmse"
                | "nll"
                | "kl"
                | "regret"
        )
    })
}

fn numeric_desc(left: Option<f64>, right: Option<f64>) -> std::cmp::Ordering {
    let left = left.unwrap_or(f64::NEG_INFINITY);
    let right = right.unwrap_or(f64::NEG_INFINITY);
    right.total_cmp(&left)
}

fn numeric_asc(left: Option<f64>, right: Option<f64>) -> std::cmp::Ordering {
    let left = left.unwrap_or(f64::INFINITY);
    let right = right.unwrap_or(f64::INFINITY);
    left.total_cmp(&right)
}

fn duration_seconds(run: &RunRow) -> Option<f64> {
    run.finished_at
        .map(|finished| (finished - run.started_at).num_milliseconds() as f64 / 1_000.0)
}

pub async fn log_metrics(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: LogMetricsRequest,
    idempotency_key: Option<String>,
) -> AppResult<usize> {
    let metrics = validate_metrics(input.metrics)?;
    let step = validate_step(&input.step, "step")?;
    let timestamp = validate_timestamp(input.timestamp.as_deref())?;
    let request_hash = hash_idempotency(run_id, &raw);
    let points = metrics
        .iter()
        .map(|(key, value)| ChMetricPointRow {
            org_id: ctx.org_id,
            run_id,
            key: key.clone(),
            step,
            value: *value,
            logged_at: timestamp,
            created_at: Utc::now(),
        })
        .collect::<Vec<_>>();
    let mut data = store.data.lock().await;
    if let Some(key) = &idempotency_key {
        if let Some(existing) = data
            .idempotency
            .get(&(ctx.org_id, key.clone()))
            .filter(|record| record.expires_at > Utc::now())
        {
            if existing.request_hash == request_hash {
                return existing
                    .response_json
                    .get("inserted")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
                    .ok_or_else(|| AppError::internal("stored idempotency response is invalid"));
            }
            return Err(AppError::conflict(
                "idempotency key was already used with a different request body",
            ));
        }
    }
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    store.metric_store().insert_points(&points).await?;
    if let Some(key) = idempotency_key {
        let record = IdempotencyRecord {
            org_id: ctx.org_id,
            key: key.clone(),
            request_hash,
            response_json: json!({ "inserted": points.len() }),
            expires_at: Utc::now() + ChronoDuration::days(7),
        };
        store
            .persist_locked("idempotency", ctx.org_id, &key, &record)
            .await?;
        data.idempotency.insert((ctx.org_id, key), record);
    }
    Ok(points.len())
}

pub async fn get_metrics(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    {
        let data = store.data.lock().await;
        let run = fetch_run_in_data(&data, ctx, run_id)?;
        ensure_run_access_in_data(ctx, &run)?;
    }
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )?;
    let start_step = query
        .get("start_step")
        .map(|raw| validate_query_step(raw, "start_step"))
        .transpose()?;
    let end_step = query
        .get("end_step")
        .map(|raw| validate_query_step(raw, "end_step"))
        .transpose()?;
    let rows = store
        .metric_store()
        .query_points(
            ctx.org_id,
            run_id,
            query.get("key").map(String::as_str),
            start_step,
            end_step,
            limit,
        )
        .await?;
    Ok(json!({ "metrics": rows.into_iter().map(metric_point_value).collect::<Vec<_>>() }))
}

pub async fn metrics_series_batched(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let key = validate_name(query.get("key").map(String::as_str), "key")?;
    let run_ids = parse_run_ids(query.get("run_ids"))?;
    if run_ids.len() > MAX_METRIC_SERIES_RUN_IDS {
        return Err(AppError::validation(format!(
            "run_ids cannot include more than {MAX_METRIC_SERIES_RUN_IDS} runs"
        )));
    }
    {
        let data = store.data.lock().await;
        for run_id in &run_ids {
            let run = fetch_run_in_data(&data, ctx, *run_id)?;
            ensure_run_access_in_data(ctx, &run)?;
        }
    }
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )?;
    let start_step = query_step(query, "start_step")?;
    let end_step = query_step(query, "end_step")?;
    let rows = store
        .metric_store()
        .query_points_for_runs(ctx.org_id, &run_ids, &key, start_step, end_step, limit)
        .await?;
    let mut grouped: BTreeMap<Uuid, Vec<Value>> = BTreeMap::new();
    for row in rows {
        grouped.entry(row.run_id).or_default().push(json!({
            "key": row.key,
            "step": row.step,
            "value": row.value,
            "created_at": row.created_at
        }));
    }
    Ok(json!({
        "series": run_ids.into_iter().map(|run_id| json!({
            "run_id": run_id,
            "metrics": grouped.remove(&run_id).unwrap_or_default()
        })).collect::<Vec<_>>()
    }))
}

pub async fn create_attributes(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateAttributesRequest,
) -> AppResult<Vec<Value>> {
    let items = normalize_attribute_inputs(input)?;
    let mut created = Vec::new();
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    for item in items {
        if matches!(item.kind.as_str(), "table" | "image" | "video" | "audio") {
            return Err(AppError::validation(
                "rich object types must use /api/runs/:run_id/objects",
            ));
        }
        let attribute = attribute_from_input(&mut data, ctx.org_id, run_id, item)?;
        store
            .persist_locked(
                "attribute",
                ctx.org_id,
                &attribute.id.to_string(),
                &attribute,
            )
            .await?;
        data.insert_attribute(attribute.clone());
        created.push(attribute_value(&attribute));
    }
    Ok(created)
}

pub async fn list_attributes(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Vec<Value>> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let kind = query
        .get("type")
        .map(|value| validate_name(Some(value), "attribute type"))
        .transpose()?;
    let path_prefix = query
        .get("path_prefix")
        .map(|value| validate_name(Some(value), "path_prefix"))
        .transpose()?;
    let mut rows = data
        .attributes_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.attributes.get(id))
        .filter(|row| {
            kind.as_ref()
                .map(|value| row.kind == *value)
                .unwrap_or(true)
        })
        .filter(|row| {
            path_prefix
                .as_ref()
                .map(|value| row.path.starts_with(value))
                .unwrap_or(true)
        })
        .map(attribute_value)
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        json_step(a)
            .total_cmp(&json_step(b))
            .then_with(|| json_i64(a, "id").cmp(&json_i64(b, "id")))
    });
    rows = rows.into_iter().skip(offset).take(limit).collect();
    Ok(rows)
}

pub async fn create_object(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateObjectRequest,
) -> AppResult<Value> {
    let key = validate_name(input.key.as_deref(), "object key")?;
    let requested_kind = validate_name(input.kind.as_deref(), "object kind")?;
    let kind = normalize_object_kind(&requested_kind)?;
    let is_table = kind == "table";
    let mut step = validate_optional_step(input.step.as_ref(), "step")?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    validate_json_size(&metadata, "metadata", MAX_OBJECT_METADATA_BYTES)?;
    let mut summary = validate_json_object(input.summary, "summary")?;
    validate_json_size(&summary, "summary", MAX_OBJECT_SUMMARY_BYTES)?;
    let mut value = input
        .value
        .unwrap_or_else(|| json!({ "kind": requested_kind, "metadata": metadata.clone() }));
    let rows = input.rows.unwrap_or_default();
    if is_table {
        validate_table_rows(&rows)?;
    } else if !rows.is_empty() {
        return Err(AppError::validation(format!(
            "rows are only accepted for table objects, not {requested_kind}"
        )));
    }
    if kind == "histogram_series" {
        validate_histogram_value(&value)?;
    }
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let mut artifact_id = input.artifact_id;
    if matches!(kind.as_str(), "image" | "video" | "audio") {
        let id = artifact_id
            .ok_or_else(|| AppError::validation("artifact_id is required for media objects"))?;
        let artifact = data
            .artifacts
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::not_found("artifact not found"))?;
        if artifact.org_id != ctx.org_id || artifact.run_id != run_id {
            return Err(AppError::validation("artifact must belong to the same run"));
        }
        step = step.or(artifact.step);
        value = json!({
            "kind": requested_kind,
            "uri": artifact.uri,
            "metadata": metadata
        });
        summary = media_summary(summary, &artifact);
        artifact_id = Some(artifact.id);
    } else if let Some(id) = artifact_id {
        let artifact = data
            .artifacts
            .get(&id)
            .ok_or_else(|| AppError::not_found("artifact not found"))?;
        if artifact.org_id != ctx.org_id || artifact.run_id != run_id {
            return Err(AppError::validation("artifact must belong to the same run"));
        }
        if kind == "histogram_series" {
            artifact_id = None;
        }
    }
    let attribute = AttributeRow {
        id: data.next_attribute_id,
        org_id: ctx.org_id,
        run_id,
        path: key,
        kind,
        step,
        logged_at: Some(Utc::now()),
        value,
        summary: if is_table {
            table_summary(summary, &rows)?
        } else {
            summary
        },
        artifact_id,
        created_at: Utc::now(),
    };
    let object = object_value(&data, &attribute);
    store
        .persist_locked(
            "attribute",
            ctx.org_id,
            &attribute.id.to_string(),
            &attribute,
        )
        .await?;
    data.insert_attribute(attribute.clone());
    if is_table && !rows.is_empty() {
        let rows_record = TableRowsRecord {
            attribute_id: attribute.id,
            rows: rows
                .into_iter()
                .enumerate()
                .map(|(index, row)| TableObjectRow {
                    row_index: index as i64,
                    row,
                    created_at: Utc::now(),
                })
                .collect(),
        };
        store
            .persist_locked(
                "table_rows",
                ctx.org_id,
                &attribute.id.to_string(),
                &rows_record,
            )
            .await?;
        data.table_rows
            .insert(rows_record.attribute_id, rows_record.rows);
    }
    Ok(object)
}

pub async fn list_objects(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_OBJECT_LIMIT,
        MAX_OBJECT_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let kind = query
        .get("kind")
        .map(|value| normalize_object_kind(value))
        .transpose()?;
    let key = query
        .get("key")
        .map(|value| validate_name(Some(value), "object key"))
        .transpose()?;
    let mut rows = data
        .attributes_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.attributes.get(id))
        .filter(|row| {
            matches!(
                row.kind.as_str(),
                "table" | "image" | "video" | "audio" | "histogram_series"
            )
        })
        .filter(|row| {
            kind.as_ref()
                .map(|value| row.kind == *value)
                .unwrap_or(true)
        })
        .filter(|row| key.as_ref().map(|value| row.path == *value).unwrap_or(true))
        .map(|row| object_value(&data, row))
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        numeric_desc(Some(json_step(a)), Some(json_step(b)))
            .then_with(|| json_time(b).cmp(&json_time(a)))
            .then_with(|| json_i64(b, "id").cmp(&json_i64(a, "id")))
    });
    rows = rows.into_iter().skip(offset).take(limit).collect();
    Ok(json!({ "objects": rows, "limit": limit, "offset": offset }))
}

pub async fn list_object_rows(
    store: &Store,
    ctx: &RequestContext,
    object_id: i64,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let object = data
        .attributes
        .get(&object_id)
        .ok_or_else(|| AppError::not_found("object not found"))?;
    let run = fetch_run_in_data(&data, ctx, object.run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    if object.kind != "table" {
        return Err(AppError::validation(
            "object rows are only available for table objects",
        ));
    }
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_OBJECT_ROW_LIMIT,
        MAX_OBJECT_ROW_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let rows = data
        .table_rows
        .get(&object_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|row| {
            json!({
                "row_index": row.row_index,
                "row": row.row,
                "created_at": row.created_at
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "object_id": object_id, "rows": rows, "limit": limit, "offset": offset }))
}

pub async fn create_artifact(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateArtifactRequest,
) -> AppResult<ArtifactRow> {
    let artifact = artifact_from_input(store, ctx, run_id, input, None).await?;
    Ok(artifact)
}

pub async fn upload_artifact(
    store: &Store,
    config: &AppConfig,
    ctx: &RequestContext,
    run_id: Uuid,
    input: UploadArtifactRequest,
) -> AppResult<ArtifactRow> {
    let name = validate_name(input.name.as_deref(), "artifact name")?;
    let artifact_id = Uuid::new_v4();
    let content = input
        .content_base64
        .as_deref()
        .ok_or_else(|| AppError::validation("content_base64 is required"))?;
    if content.trim().is_empty() {
        return Err(AppError::validation("content_base64 is required"));
    }
    let artifact_store = LocalArtifactStore::new(&config.artifact_root);
    let staged = artifact_store
        .stage_base64(ctx.org_id, run_id, artifact_id, &name, content)
        .await?;
    if let Err(error) = artifact_store.finalize(&staged).await {
        artifact_store.cleanup(&staged.tmp_path).await;
        artifact_store.cleanup(&staged.final_path).await;
        return Err(error);
    }
    let request = CreateArtifactRequest {
        kind: input.kind,
        name: Some(name),
        uri: Some(staged.uri.clone()),
        step: input.step,
        size_bytes: Some(json!(staged.size_bytes)),
        sha256: Some(staged.sha256.clone()),
        mime_type: input.mime_type,
        metadata: input.metadata,
        path: input.path,
    };
    let storage_key = staged.storage_key.clone();
    let artifact = match artifact_from_input(
        store,
        ctx,
        run_id,
        request,
        Some((artifact_id, storage_key)),
    )
    .await
    {
        Ok(artifact) => artifact,
        Err(error) => {
            artifact_store.cleanup(&staged.final_path).await;
            return Err(error);
        }
    };
    Ok(artifact)
}

async fn artifact_from_input(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateArtifactRequest,
    stored: Option<(Uuid, String)>,
) -> AppResult<ArtifactRow> {
    let name = validate_name(input.name.as_deref(), "artifact name")?;
    let kind = validate_artifact_type(input.kind.as_deref().unwrap_or("file"))?;
    let uri = validate_name(
        input
            .uri
            .as_deref()
            .or(input.path.as_deref())
            .or(Some(&name)),
        "artifact uri",
    )?;
    let step = validate_optional_step(input.step.as_ref(), "step")?;
    let size_bytes = input
        .size_bytes
        .as_ref()
        .map(validate_size_bytes)
        .transpose()?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let (id, storage_key) = stored.unwrap_or_else(|| (Uuid::new_v4(), String::new()));
    let artifact = ArtifactRow {
        id,
        org_id: ctx.org_id,
        run_id,
        kind,
        name: name.clone(),
        uri,
        step,
        size_bytes,
        sha256: input.sha256,
        mime_type: input
            .mime_type
            .or_else(|| mime_guess::from_path(&name).first_raw().map(str::to_string)),
        storage_backend: if storage_key.is_empty() {
            "external".to_string()
        } else {
            "local".to_string()
        },
        storage_key: (!storage_key.is_empty()).then_some(storage_key),
        storage_path: None,
        metadata,
        created_at: Utc::now(),
    };
    store
        .persist_locked("artifact", ctx.org_id, &artifact.id.to_string(), &artifact)
        .await?;
    data.insert_artifact(artifact.clone());
    Ok(artifact)
}

pub async fn list_artifacts(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Vec<ArtifactRow>> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_ARTIFACT_LIST,
    )? as usize;
    let mut rows = data
        .artifacts_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifacts.get(id).cloned())
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    rows.truncate(limit);
    Ok(rows)
}

pub async fn get_artifact_for_context(
    store: &Store,
    ctx: &RequestContext,
    artifact_id: Uuid,
) -> AppResult<ArtifactRow> {
    let data = store.data.lock().await;
    let artifact = data
        .artifacts
        .get(&artifact_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact not found"))?;
    let run = fetch_run_in_data(&data, ctx, artifact.run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    Ok(artifact)
}

pub async fn side_by_side(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let run_ids = parse_run_ids(query.get("run_ids").or_else(|| query.get("runs")))?;
    if run_ids.len() > MAX_SIDE_BY_SIDE_RUNS {
        return Err(AppError::validation(format!(
            "run_ids must include at most {MAX_SIDE_BY_SIDE_RUNS} runs"
        )));
    }
    let reference_run_id = query
        .get("reference_run_id")
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .or_else(|| run_ids.first().copied());
    let diff_only = query
        .get("diff_only")
        .map(|value| value == "true")
        .unwrap_or(false);
    let (runs, attributes) = {
        let data = store.data.lock().await;
        let mut runs = Vec::new();
        let mut attributes = Vec::new();
        for run_id in &run_ids {
            let run = fetch_run_in_data(&data, ctx, *run_id)?;
            ensure_run_access_in_data(ctx, &run)?;
            attributes.extend(
                data.attributes_by_run
                    .get(run_id)
                    .into_iter()
                    .flatten()
                    .filter_map(|id| data.attributes.get(id).cloned()),
            );
            runs.push(run);
        }
        (runs, attributes)
    };
    let series = metric_series_for_runs_limited(
        store.metric_store(),
        ctx.org_id,
        &run_ids,
        MAX_SIDE_BY_SIDE_ROWS as i64 + 1,
    )
    .await?;
    let mut values_by_run: HashMap<Uuid, BTreeMap<String, Value>> = HashMap::new();
    for run in &runs {
        let mut values = BTreeMap::new();
        if let Some(config) = run.config.as_object() {
            for (key, value) in config {
                values.insert(format!("config/{key}"), value.clone());
            }
        }
        if let Some(metadata) = run.metadata.as_object() {
            for (key, value) in metadata {
                values.insert(format!("metadata/{key}"), value.clone());
            }
        }
        for tag in &run.tags {
            values.insert(format!("tag/{tag}"), json!(true));
        }
        for item in series.iter().filter(|item| item.run_id == run.id) {
            values.insert(format!("metric/{}/latest", item.key), json!(item.latest));
            values.insert(format!("metric/{}/max", item.key), json!(item.max));
            values.insert(format!("metric/{}/mean", item.key), json!(item.mean));
        }
        for attribute in attributes.iter().filter(|item| item.run_id == run.id) {
            values.insert(
                format!("attribute/{}", attribute.path),
                attribute.value.clone(),
            );
        }
        values_by_run.insert(run.id, values);
    }
    let mut paths = BTreeSet::new();
    for values in values_by_run.values() {
        paths.extend(values.keys().cloned());
    }
    let rows = paths
        .into_iter()
        .take(MAX_SIDE_BY_SIDE_ROWS)
        .filter_map(|path| {
            let mut values = Map::new();
            for run in &runs {
                values.insert(
                    run.id.to_string(),
                    values_by_run[&run.id].get(&path).cloned().unwrap_or(Value::Null),
                );
            }
            let different = values
                .values()
                .map(|value| serde_json::to_string(value).unwrap_or_default())
                .collect::<BTreeSet<_>>()
                .len()
                > 1;
            if diff_only && !different {
                return None;
            }
            let reference = reference_run_id
                .and_then(|id| values.get(&id.to_string()).cloned())
                .unwrap_or(Value::Null);
            Some(json!({ "path": path, "values": values, "reference_run_id": reference_run_id, "reference": reference, "different": different }))
        })
        .collect::<Vec<_>>();
    Ok(
        json!({ "runs": runs, "reference_run_id": reference_run_id, "rows": rows, "truncated": false }),
    )
}

pub async fn export_data(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    if let Some(auth) = &ctx.auth {
        auth.require_scope("export:read")?;
    }
    let runs = filtered_runs(store, ctx, query).await?;
    let total_runs = runs.len();
    let selected = runs.into_iter().take(MAX_EXPORT_RUNS).collect::<Vec<_>>();
    let run_ids = selected.iter().map(|run| run.id).collect::<Vec<_>>();
    let metrics = metric_point_values_for_runs(store.metric_store(), ctx.org_id, &run_ids).await?;
    let metric_series =
        metric_series_values_for_runs(store.metric_store(), ctx.org_id, &run_ids).await?;
    let data = store.data.lock().await;
    let run_id_set = run_ids.iter().copied().collect::<BTreeSet<_>>();
    let projects = {
        let mut map = BTreeMap::new();
        for run in &selected {
            if let Some(project) = data.projects.get(&run.project_id) {
                map.insert(project.id, project.clone());
            }
        }
        map.into_values().collect::<Vec<_>>()
    };
    let organization = data
        .organizations
        .get(&ctx.org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let mut attributes = run_ids
        .iter()
        .flat_map(|run_id| data.attributes_by_run.get(run_id).into_iter().flatten())
        .filter_map(|id| data.attributes.get(id))
        .map(attribute_value)
        .collect::<Vec<_>>();
    let attributes_truncated = attributes.len() > MAX_EXPORT_ATTRIBUTES;
    attributes.truncate(MAX_EXPORT_ATTRIBUTES);
    let mut artifacts = run_ids
        .iter()
        .flat_map(|run_id| data.artifacts_by_run.get(run_id).into_iter().flatten())
        .filter_map(|id| data.artifacts.get(id))
        .cloned()
        .collect::<Vec<_>>();
    let artifacts_truncated = artifacts.len() > MAX_EXPORT_ARTIFACTS;
    artifacts.truncate(MAX_EXPORT_ARTIFACTS);
    let mut table_object_rows = data
        .attributes
        .values()
        .filter(|attribute| run_id_set.contains(&attribute.run_id))
        .flat_map(|attribute| {
            data.table_rows
                .get(&attribute.id)
                .into_iter()
                .flatten()
                .map(move |row| {
                    json!({
                        "org_id": ctx.org_id,
                        "run_id": attribute.run_id,
                        "attribute_id": attribute.id,
                        "row_index": row.row_index,
                        "row": row.row.clone(),
                        "created_at": row.created_at
                    })
                })
        })
        .collect::<Vec<_>>();
    let table_object_rows_truncated = table_object_rows.len() > MAX_EXPORT_TABLE_OBJECT_ROWS;
    table_object_rows.truncate(MAX_EXPORT_TABLE_OBJECT_ROWS);
    let mut imports = data
        .imports
        .values()
        .filter(|row| row.org_id == ctx.org_id)
        .filter(|row| row.run_ids.iter().any(|id| run_id_set.contains(id)))
        .cloned()
        .collect::<Vec<_>>();
    imports.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    imports.truncate(MAX_IMPORT_LIST as usize);
    let exported_at = Utc::now();
    Ok(json!({
        "version": 1,
        "exported_at": exported_at,
        "generated_at": exported_at,
        "organizations": [organization],
        "projects": projects,
        "runs": selected,
        "metric_series": metric_series,
        "metrics": metrics,
        "attributes": attributes,
        "artifacts": artifacts,
        "table_object_rows": table_object_rows,
        "imports": imports,
        "limits": {
            "runs": MAX_EXPORT_RUNS,
            "metrics": MAX_EXPORT_METRICS,
            "attributes": MAX_EXPORT_ATTRIBUTES,
            "artifacts": MAX_EXPORT_ARTIFACTS,
            "table_object_rows": MAX_EXPORT_TABLE_OBJECT_ROWS,
            "imports": MAX_IMPORT_LIST
        },
        "truncated": total_runs > run_ids.len()
            || metrics.len() as i64 >= MAX_EXPORT_METRICS
            || attributes_truncated
            || artifacts_truncated
            || table_object_rows_truncated
    }))
}

pub async fn usage_summary(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    let data = store.data.lock().await;
    let org = data
        .organizations
        .get(&ctx.org_id)
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let artifact_bytes_exact: i64 = data
        .artifacts
        .values()
        .filter(|artifact| artifact.org_id == ctx.org_id)
        .filter_map(|artifact| artifact.size_bytes)
        .sum();
    let metric_points = store
        .metric_store()
        .count_points_for_org(ctx.org_id)
        .await
        .unwrap_or(0);
    Ok(json!({
        "schema_version": 1,
        "generated_at": Utc::now(),
        "source": "computed_current_state",
        "organizations": [{
            "org_id": ctx.org_id,
            "org_slug": org.slug,
            "plan_tier": org.plan_tier,
            "usage": {
                "seats": data.memberships.values().filter(|m| m.org_id == ctx.org_id).count(),
                "projects": data.projects.values().filter(|p| p.org_id == ctx.org_id).count(),
                "runs": data.runs.values().filter(|r| r.org_id == ctx.org_id).count(),
                "metric_points": metric_points,
                "metric_series": store.metric_store().count_series_for_org(ctx.org_id).await.unwrap_or(0),
                "artifacts": data.artifacts.values().filter(|a| a.org_id == ctx.org_id).count(),
                "artifact_bytes_exact": artifact_bytes_exact,
                "artifact_bytes_unknown": 0
            }
        }]
    }))
}

pub async fn usage_export(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    let summary = usage_summary(store, ctx).await?;
    Ok(json!({
        "schema_version": summary["schema_version"],
        "generated_at": summary["generated_at"],
        "source": "computed_current_state",
        "organizations": summary["organizations"]
    }))
}

pub async fn write_usage_daily_snapshots(store: &Store) -> AppResult<usize> {
    let org_ids = {
        let data = store.data.lock().await;
        data.organizations.keys().copied().collect::<Vec<_>>()
    };
    let mut written = 0;
    for org_id in org_ids {
        let ctx = RequestContext {
            org_id,
            auth: None,
            session: None,
        };
        let snapshot = usage_summary(store, &ctx).await?;
        let mut data = store.data.lock().await;
        store
            .persist_locked(
                "usage_daily",
                org_id,
                &format!("{}-{}", org_id, Utc::now().date_naive()),
                &snapshot,
            )
            .await?;
        data.usage_daily.push(snapshot);
        written += 1;
    }
    Ok(written)
}

pub async fn delete_expired_idempotency(store: &Store) -> AppResult<u64> {
    let mut data = store.data.lock().await;
    let before = data.idempotency.len();
    data.idempotency
        .retain(|_, row| row.expires_at > Utc::now());
    Ok((before - data.idempotency.len()) as u64)
}

pub async fn delete_expired_or_revoked_sessions(store: &Store) -> AppResult<u64> {
    let mut data = store.data.lock().await;
    let before = data.sessions.len();
    let expired = data
        .sessions
        .iter()
        .filter(|(_, session)| {
            session.row.expires_at <= Utc::now() || session.row.revoked_at.is_some()
        })
        .map(|(id, _)| *id)
        .collect::<Vec<_>>();
    for id in expired {
        if let Some(session) = data.sessions.remove(&id) {
            data.sessions_by_hash.remove(&session.token_hash);
        }
    }
    Ok((before - data.sessions.len()) as u64)
}

pub async fn list_imports(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    let data = store.data.lock().await;
    let restricted_project_id = ctx.auth.as_ref().and_then(|auth| auth.project_id);
    let mut rows = data
        .imports
        .values()
        .filter(|row| row.org_id == ctx.org_id)
        .filter(|row| {
            restricted_project_id
                .map(|project_id| row.project_id == Some(project_id))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    rows.truncate(MAX_IMPORT_LIST as usize);
    Ok(json!({ "imports": rows }))
}

pub async fn import_payload(
    store: &Store,
    ctx: &RequestContext,
    source: &str,
    dry_run: bool,
    raw: Value,
) -> AppResult<Value> {
    let canonical = normalize_import(source, raw)?;
    let summary = json!({
        "runs": canonical.runs.len(),
        "metrics": canonical.runs.iter().map(|run| run.metrics.len()).sum::<usize>(),
        "attributes": canonical.runs.iter().map(|run| run.attributes.len()).sum::<usize>(),
        "artifacts": canonical.runs.iter().map(|run| run.artifacts.len()).sum::<usize>(),
    });
    if dry_run {
        ensure_import_project_access(store, ctx, &canonical.project).await?;
        return Ok(json!({ "dry_run": true, "summary": summary }));
    }
    let mut data = store.data.lock().await;
    let project = match ctx.auth.as_ref().and_then(|auth| auth.project_id) {
        Some(project_id) => {
            let project = data
                .projects
                .get(&project_id)
                .cloned()
                .filter(|project| project.org_id == ctx.org_id)
                .ok_or_else(|| AppError::forbidden("project-scoped API key project not found"))?;
            if project.name != canonical.project {
                return Err(AppError::forbidden(
                    "project-scoped API keys cannot import into another project",
                ));
            }
            project
        }
        None => ensure_project_locked(store, &mut data, ctx.org_id, &canonical.project).await?,
    };
    let mut run_ids = Vec::new();
    for item in canonical.runs {
        let started_at = item.started_at.unwrap_or_else(Utc::now);
        let finished_at = if item.status == "running" {
            None
        } else {
            Some(item.finished_at.unwrap_or_else(Utc::now))
        };
        let run = RunRow {
            id: Uuid::new_v4(),
            org_id: ctx.org_id,
            project_id: project.id,
            project: project.name.clone(),
            name: item.name,
            status: item.status,
            config: item.config,
            tags: item.tags,
            metadata: item.metadata,
            created_at: Utc::now(),
            started_at,
            finished_at,
        };
        store
            .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
            .await?;
        data.insert_run(run.clone());
        let points = item
            .metrics
            .into_iter()
            .map(|metric| ChMetricPointRow {
                org_id: ctx.org_id,
                run_id: run.id,
                key: metric.key,
                step: metric.step,
                value: metric.value,
                logged_at: metric.logged_at,
                created_at: Utc::now(),
            })
            .collect::<Vec<_>>();
        store.metric_store().insert_points(&points).await?;
        for attribute in item.attributes {
            let attribute = attribute_from_input(&mut data, ctx.org_id, run.id, attribute)?;
            store
                .persist_locked(
                    "attribute",
                    ctx.org_id,
                    &attribute.id.to_string(),
                    &attribute,
                )
                .await?;
            data.insert_attribute(attribute);
        }
        for artifact in item.artifacts {
            let artifact = ArtifactRow {
                id: Uuid::new_v4(),
                org_id: ctx.org_id,
                run_id: run.id,
                kind: artifact.kind,
                name: artifact.name.clone(),
                uri: artifact.uri,
                step: artifact.step,
                size_bytes: artifact.size_bytes,
                sha256: None,
                mime_type: artifact.mime_type.or_else(|| {
                    mime_guess::from_path(&artifact.name)
                        .first_raw()
                        .map(str::to_string)
                }),
                storage_backend: "external".to_string(),
                storage_key: None,
                storage_path: None,
                metadata: artifact.metadata,
                created_at: Utc::now(),
            };
            store
                .persist_locked("artifact", ctx.org_id, &artifact.id.to_string(), &artifact)
                .await?;
            data.insert_artifact(artifact);
        }
        run_ids.push(run.id);
    }
    let import = ImportRow {
        id: data.next_import_id,
        org_id: ctx.org_id,
        project_id: Some(project.id),
        source_type: format!("{source}_json"),
        status: "completed".to_string(),
        summary: summary.clone(),
        run_ids: run_ids.clone(),
        created_at: Utc::now(),
        completed_at: Some(Utc::now()),
    };
    data.next_import_id += 1;
    store
        .persist_locked("import", ctx.org_id, &import.id.to_string(), &import)
        .await?;
    data.imports.insert(import.id, import.clone());
    Ok(json!({ "dry_run": false, "summary": summary, "import": import }))
}

pub async fn reset_demo(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    let mut data = store.data.lock().await;
    let delete = ProjectDeleteRecord {
        org_id: ctx.org_id,
        project_name: "demo".to_string(),
    };
    store
        .persist_locked("project_delete", ctx.org_id, "demo", &delete)
        .await?;
    data.apply_project_delete(delete);
    let project = ensure_project_locked(store, &mut data, ctx.org_id, "demo").await?;
    let mut points = Vec::new();
    for index in 0..DEMO_RUN_COUNT {
        let seed = 7 + ((index as i64 * 37) % 100_000);
        let workload = if index % 10 < 6 { "llm" } else { "rl" };
        let run_id = Uuid::new_v4();
        let status = if index % 97 == 0 {
            "failed"
        } else if index % 89 == 0 {
            "running"
        } else {
            "finished"
        };
        let run = RunRow {
            id: run_id,
            org_id: ctx.org_id,
            project_id: project.id,
            project: "demo".to_string(),
            name: demo_run_name(workload, index, seed),
            status: status.to_string(),
            config: demo_config(workload, index, seed),
            tags: demo_tags(workload, index, seed),
            metadata: demo_metadata(workload, index, seed),
            created_at: Utc::now() - ChronoDuration::seconds((DEMO_RUN_COUNT - index) as i64),
            started_at: Utc::now() - ChronoDuration::minutes(20),
            finished_at: (status != "running").then(Utc::now),
        };
        store
            .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
            .await?;
        data.insert_run(run.clone());
        let mut run_artifacts = Vec::new();
        for mut artifact in demo_artifacts(workload, seed) {
            artifact.org_id = ctx.org_id;
            artifact.run_id = run_id;
            artifact.mime_type = artifact.mime_type.or_else(|| {
                mime_guess::from_path(&artifact.name)
                    .first_raw()
                    .map(str::to_string)
            });
            run_artifacts.push(artifact.clone());
            store
                .persist_locked("artifact", ctx.org_id, &artifact.id.to_string(), &artifact)
                .await?;
            data.insert_artifact(artifact);
        }
        if index < 40 || index % 50 == 0 {
            let table = demo_object(
                &mut data,
                ctx.org_id,
                run_id,
                "eval/samples",
                "table",
                json!({"kind":"table"}),
                json!({"columns":["prompt","prediction","target","score"],"row_count":5}),
            );
            store
                .persist_locked("attribute", ctx.org_id, &table.id.to_string(), &table)
                .await?;
            data.insert_attribute(table.clone());
            let rows = TableRowsRecord {
                attribute_id: table.id,
                rows: (0..5).map(|row| TableObjectRow {
                    row_index: row,
                    row: json!({"prompt": format!("episode {row}"), "prediction": format!("seed {seed}"), "target": "stable", "score": 0.7 + row as f64 * 0.03}),
                    created_at: Utc::now(),
                }).collect(),
            };
            store
                .persist_locked("table_rows", ctx.org_id, &table.id.to_string(), &rows)
                .await?;
            data.table_rows.insert(table.id, rows.rows);
            let hist = demo_object(
                &mut data,
                ctx.org_id,
                run_id,
                "eval/score_distribution",
                "histogram_series",
                json!({"bins":[0,0.5,1],"counts":[2,5]}),
                json!({"bins":3}),
            );
            store
                .persist_locked("attribute", ctx.org_id, &hist.id.to_string(), &hist)
                .await?;
            data.insert_attribute(hist);
            let mut media = demo_object(
                &mut data,
                ctx.org_id,
                run_id,
                "media/demo",
                if workload == "llm" { "audio" } else { "video" },
                json!({"kind": if workload == "llm" { "audio" } else { "video" }}),
                json!({"source":"demo"}),
            );
            media.artifact_id = run_artifacts
                .iter()
                .find(|artifact| {
                    if workload == "llm" {
                        artifact.name.ends_with(".mp3")
                    } else {
                        artifact.kind == "rollout"
                    }
                })
                .map(|artifact| artifact.id);
            store
                .persist_locked("attribute", ctx.org_id, &media.id.to_string(), &media)
                .await?;
            data.insert_attribute(media);
        }
        for step in DEMO_STEPS {
            for (key, value) in demo_metrics(workload, index, seed, step) {
                points.push(ChMetricPointRow {
                    org_id: ctx.org_id,
                    run_id,
                    key,
                    step: step as f64,
                    value,
                    logged_at: Utc::now(),
                    created_at: Utc::now(),
                });
            }
        }
    }
    drop(data);
    for chunk in points.chunks(10_000) {
        store.metric_store().insert_points(chunk).await?;
    }
    let mut query = HashMap::new();
    query.insert("project".to_string(), "demo".to_string());
    query.insert("limit".to_string(), "100".to_string());
    runs_summary(store, ctx, &query).await
}

fn demo_object(
    data: &mut StoreData,
    org_id: Uuid,
    run_id: Uuid,
    path: &str,
    kind: &str,
    value: Value,
    summary: Value,
) -> AttributeRow {
    let row = AttributeRow {
        id: data.next_attribute_id,
        org_id,
        run_id,
        path: path.to_string(),
        kind: kind.to_string(),
        step: Some(200.0),
        logged_at: Some(Utc::now()),
        value,
        summary,
        artifact_id: None,
        created_at: Utc::now(),
    };
    data.next_attribute_id += 1;
    row
}

async fn ensure_project_locked(
    store: &Store,
    data: &mut StoreData,
    org_id: Uuid,
    name: &str,
) -> AppResult<ProjectRow> {
    if let Some(id) = data
        .projects_by_org_name
        .get(&(org_id, name.to_string()))
        .copied()
    {
        return data
            .projects
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::not_found("project not found"));
    }
    let project = ProjectRow {
        id: Uuid::new_v4(),
        org_id,
        name: name.to_string(),
        description: None,
        created_at: Utc::now(),
    };
    store
        .persist_locked("project", org_id, &project.id.to_string(), &project)
        .await?;
    data.insert_project(project.clone());
    Ok(project)
}

async fn ensure_import_project_access(
    store: &Store,
    ctx: &RequestContext,
    project_name: &str,
) -> AppResult<()> {
    let Some(project_id) = ctx.auth.as_ref().and_then(|auth| auth.project_id) else {
        return Ok(());
    };
    let data = store.data.lock().await;
    let project = data
        .projects
        .get(&project_id)
        .filter(|project| project.org_id == ctx.org_id)
        .ok_or_else(|| AppError::forbidden("project-scoped API key project not found"))?;
    if project.name != project_name {
        return Err(AppError::forbidden(
            "project-scoped API keys cannot import into another project",
        ));
    }
    Ok(())
}

async fn summarize_runs(store: &Store, runs: Vec<RunRow>) -> AppResult<Vec<Value>> {
    let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let series = if let Some(first) = runs.first() {
        metric_series_for_runs(store.metric_store(), first.org_id, &run_ids).await?
    } else {
        Vec::new()
    };
    let counts = {
        let data = store.data.lock().await;
        artifact_counts_for_runs(&data, &run_ids)
    };
    Ok(runs
        .into_iter()
        .map(|run| summarize_run(run, &series, &counts))
        .collect())
}

async fn run_summary_value(store: &Store, run: RunRow) -> AppResult<Value> {
    let run_ids = vec![run.id];
    let series = metric_series_for_runs(store.metric_store(), run.org_id, &run_ids).await?;
    let counts = {
        let data = store.data.lock().await;
        artifact_counts_for_runs(&data, &run_ids)
    };
    Ok(summarize_run(run, &series, &counts))
}

fn summarize_run(
    run: RunRow,
    series: &[MetricSeriesRow],
    artifact_counts: &HashMap<Uuid, BTreeMap<String, i64>>,
) -> Value {
    let mut latest = Map::new();
    let mut aggregates = Map::new();
    let mut keys = Vec::new();
    for item in series.iter().filter(|item| item.run_id == run.id) {
        latest.insert(item.key.clone(), json!(item.latest));
        aggregates.insert(
            item.key.clone(),
            json!({
                "latest": item.latest,
                "min": item.min,
                "max": item.max,
                "mean": item.mean,
                "variance": item.variance,
                "count": item.count,
                "best_step": item.best_step
            }),
        );
        keys.push(item.key.clone());
    }
    keys.sort();
    let counts = artifact_counts.get(&run.id).cloned().unwrap_or_else(|| {
        BTreeMap::from([
            ("checkpoint".to_string(), 0),
            ("rollout".to_string(), 0),
            ("file".to_string(), 0),
        ])
    });
    let mut value = serde_json::to_value(run).expect("run serializes");
    if let Value::Object(map) = &mut value {
        map.insert("latest_metrics".to_string(), Value::Object(latest));
        map.insert("metric_aggregates".to_string(), Value::Object(aggregates));
        map.insert("metric_keys".to_string(), json!(keys));
        map.insert("artifact_counts".to_string(), json!(counts));
    }
    value
}

fn artifact_counts_for_runs(
    data: &StoreData,
    run_ids: &[Uuid],
) -> HashMap<Uuid, BTreeMap<String, i64>> {
    let selected = run_ids.iter().copied().collect::<BTreeSet<_>>();
    let mut counts = HashMap::new();
    for id in run_ids {
        counts.insert(
            *id,
            BTreeMap::from([
                ("checkpoint".to_string(), 0),
                ("rollout".to_string(), 0),
                ("file".to_string(), 0),
            ]),
        );
    }
    for artifact in data
        .artifacts
        .values()
        .filter(|artifact| selected.contains(&artifact.run_id))
    {
        let entry = counts.entry(artifact.run_id).or_insert_with(BTreeMap::new);
        *entry.entry(artifact.kind.clone()).or_insert(0) += 1;
    }
    counts
}

async fn metric_series_for_runs(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<Vec<MetricSeriesRow>> {
    let rows = metric_store
        .query_series_for_runs(org_id, run_ids, None)
        .await?;
    Ok(rows.into_iter().map(series_row_from_aggregate).collect())
}

async fn metric_series_for_runs_key(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
    key: &str,
) -> AppResult<Vec<MetricSeriesRow>> {
    let rows = metric_store
        .query_series_for_runs_key(org_id, run_ids, key)
        .await?;
    Ok(rows.into_iter().map(series_row_from_aggregate).collect())
}

async fn metric_series_for_runs_limited(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: i64,
) -> AppResult<Vec<MetricSeriesRow>> {
    let rows = metric_store
        .query_series_for_runs(org_id, run_ids, Some(limit))
        .await?;
    Ok(rows.into_iter().map(series_row_from_aggregate).collect())
}

#[derive(clickhouse::Row, Deserialize)]
struct ExportMetricPointRow {
    #[serde(with = "clickhouse::serde::uuid")]
    org_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    run_id: Uuid,
    key: String,
    step: f64,
    value: f64,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    logged_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    created_at: DateTime<Utc>,
}

async fn metric_point_values_for_runs(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<Vec<Value>> {
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = metric_store
        .client()
        .query(
            "SELECT org_id, run_id, key, step, value, logged_at, created_at \
             FROM metric_points \
             WHERE org_id = ? AND run_id IN ? \
             ORDER BY run_id, key, step, created_at \
             LIMIT ?",
        )
        .bind(org_id)
        .bind(run_ids)
        .bind(MAX_EXPORT_METRICS)
        .fetch_all::<ExportMetricPointRow>()
        .await
        .map_err(|err| AppError::internal(format!("clickhouse export metrics failed: {err}")))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            json!({
                "org_id": row.org_id,
                "run_id": row.run_id,
                "key": row.key,
                "step": row.step,
                "value": row.value,
                "logged_at": row.logged_at,
                "created_at": row.created_at
            })
        })
        .collect())
}

async fn metric_series_values_for_runs(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<Vec<Value>> {
    metric_series_for_runs(metric_store, org_id, run_ids)
        .await
        .map(|rows| {
            rows.into_iter()
                .map(|row| {
                    json!({
                        "org_id": org_id,
                        "run_id": row.run_id,
                        "key": row.key,
                        "count": row.count,
                        "min": row.min,
                        "max": row.max,
                        "mean": row.mean,
                        "variance": row.variance,
                        "latest": row.latest,
                        "latest_step": row.latest_step,
                        "best": row.best,
                        "best_step": row.best_step
                    })
                })
                .collect()
        })
}

fn series_row_from_aggregate(aggregate: SeriesReadRow) -> MetricSeriesRow {
    let count = aggregate.count as i64;
    let mean = (count > 0).then_some(aggregate.sum / count as f64);
    let variance = mean.map(|m| (aggregate.sum_sq / count as f64 - m * m).max(0.0));
    let some_if_any = |value: f64| if count > 0 { Some(value) } else { None };
    MetricSeriesRow {
        run_id: aggregate.run_id,
        key: aggregate.key,
        count,
        min: some_if_any(aggregate.min),
        max: some_if_any(aggregate.max),
        mean,
        variance,
        latest: some_if_any(aggregate.latest),
        latest_step: some_if_any(aggregate.latest_step),
        best: some_if_any(aggregate.max),
        best_step: some_if_any(aggregate.best_step),
    }
}

fn metric_point_value(row: crate::metric_store::PointReadRow) -> Value {
    json!({ "key": row.key, "step": row.step, "value": row.value, "created_at": row.created_at })
}

fn fetch_run_in_data(data: &StoreData, ctx: &RequestContext, run_id: Uuid) -> AppResult<RunRow> {
    let run = data
        .runs
        .get(&run_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("run not found"))?;
    ensure_run_access_in_data(ctx, &run)?;
    Ok(run)
}

fn ensure_run_access_in_data(ctx: &RequestContext, run: &RunRow) -> AppResult<()> {
    if run.org_id != ctx.org_id {
        return Err(AppError::forbidden(
            "run belongs to a different organization",
        ));
    }
    if ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .map(|id| id != run.project_id)
        .unwrap_or(false)
    {
        return Err(AppError::forbidden("run belongs to a different project"));
    }
    Ok(())
}

fn ensure_unrestricted_org_key(ctx: &RequestContext) -> AppResult<()> {
    if ctx.auth.as_ref().and_then(|auth| auth.project_id).is_some() {
        return Err(AppError::forbidden("route requires an org-scoped API key"));
    }
    Ok(())
}

fn require_admin_in_data(
    data: &StoreData,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<MembershipRow> {
    data.memberships
        .values()
        .find(|membership| {
            membership.org_id == org_id
                && membership.user_id == user_id
                && membership.status == "active"
                && matches!(membership.role.as_str(), "owner" | "admin")
        })
        .cloned()
        .ok_or_else(|| AppError::forbidden("organization admin role required"))
}

fn session_payload_from_data(
    data: &StoreData,
    session: UserSessionRow,
) -> AppResult<AuthSessionPayload> {
    let user = data
        .users
        .get(&session.user_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("user not found"))?;
    let organization = data
        .organizations
        .get(&session.org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let membership = data
        .memberships
        .values()
        .find(|membership| {
            membership.org_id == session.org_id && membership.user_id == session.user_id
        })
        .cloned()
        .ok_or_else(|| AppError::not_found("membership not found"))?;
    let memberships = data
        .memberships
        .values()
        .filter(|membership| membership.user_id == session.user_id)
        .cloned()
        .collect::<Vec<_>>();
    Ok(AuthSessionPayload {
        authenticated: true,
        session,
        user,
        account_type: organization.account_type.clone(),
        organization,
        membership,
        memberships,
    })
}

fn membership_row(org_id: Uuid, user_id: Uuid, role: &str, status: &str) -> MembershipRow {
    MembershipRow {
        id: Uuid::new_v4(),
        org_id,
        user_id,
        role: role.to_string(),
        status: status.to_string(),
        created_at: Utc::now(),
    }
}

fn new_session(user_id: Uuid, org_id: Uuid) -> (SessionRecord, String) {
    let token = generate_session_token();
    let row = UserSessionRow {
        id: Uuid::new_v4(),
        user_id,
        org_id,
        metadata: json!({}),
        created_at: Utc::now(),
        last_seen_at: Some(Utc::now()),
        expires_at: Utc::now() + ChronoDuration::days(SESSION_TTL_DAYS),
        revoked_at: None,
    };
    (
        SessionRecord {
            row,
            token_hash: hash_secret(&token),
        },
        token,
    )
}

fn validate_scopes<'a>(scopes: impl IntoIterator<Item = &'a str>) -> AppResult<Vec<String>> {
    let values = scopes.into_iter().map(str::to_string).collect::<Vec<_>>();
    for scope in &values {
        if !ALLOWED_SCOPES.contains(&scope.as_str()) {
            return Err(AppError::validation(format!(
                "unsupported API key scope: {scope}"
            )));
        }
    }
    Ok(values)
}

fn resolve_key_project(
    data: &StoreData,
    org_id: Uuid,
    project_id: Option<Uuid>,
    project_name: Option<&str>,
) -> AppResult<Option<Uuid>> {
    if let Some(id) = project_id {
        let project = data
            .projects
            .get(&id)
            .ok_or_else(|| AppError::not_found("project not found"))?;
        if project.org_id != org_id {
            return Err(AppError::not_found("project not found"));
        }
        if let Some(name) = project_name {
            let name = validate_name(Some(name), "project")?;
            if project.name != name {
                return Err(AppError::validation(
                    "project_id and project must refer to the same project",
                ));
            }
        }
        return Ok(Some(id));
    }
    if let Some(name) = project_name {
        let name = validate_name(Some(name), "project")?;
        return data
            .projects_by_org_name
            .get(&(org_id, name))
            .copied()
            .map(Some)
            .ok_or_else(|| AppError::not_found("project not found"));
    }
    Ok(None)
}

fn validate_metrics(value: Value) -> AppResult<BTreeMap<String, f64>> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::validation("metrics must be an object"))?;
    if object.len() > MAX_METRICS_PER_BATCH {
        return Err(AppError::validation(format!(
            "metrics must include at most {MAX_METRICS_PER_BATCH} keys"
        )));
    }
    let mut metrics = BTreeMap::new();
    for (key, value) in object {
        let key = validate_name(Some(key), "metric key")?;
        let value = value
            .as_f64()
            .ok_or_else(|| AppError::validation("metric values must be finite numbers"))?;
        metrics.insert(key, validate_metric_value(value)?);
    }
    if metrics.is_empty() {
        return Err(AppError::validation(
            "metrics must include at least one key",
        ));
    }
    Ok(metrics)
}

fn validate_metric_value(value: f64) -> AppResult<f64> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(AppError::validation("metric values must be finite numbers"))
    }
}

fn normalize_attribute_inputs(input: CreateAttributesRequest) -> AppResult<Vec<AttributeInput>> {
    if let Some(attributes) = input.attributes {
        return Ok(attributes);
    }
    Ok(vec![AttributeInput {
        path: input
            .path
            .ok_or_else(|| AppError::validation("path is required"))?,
        kind: input
            .kind
            .ok_or_else(|| AppError::validation("type is required"))?,
        step: input.step,
        timestamp: input.timestamp,
        value: input
            .value
            .ok_or_else(|| AppError::validation("value is required"))?,
        summary: input.summary,
        artifact_id: None,
    }])
}

fn attribute_from_input(
    data: &mut StoreData,
    org_id: Uuid,
    run_id: Uuid,
    input: AttributeInput,
) -> AppResult<AttributeRow> {
    let kind = validate_attribute_type(&input.kind)?;
    if let Some(artifact_id) = input.artifact_id {
        let artifact = data.artifacts.get(&artifact_id).ok_or_else(|| {
            AppError::validation("artifact_id must reference an artifact on the same run")
        })?;
        if artifact.org_id != org_id || artifact.run_id != run_id {
            return Err(AppError::validation(
                "artifact_id must reference an artifact on the same run",
            ));
        }
    }
    let row = AttributeRow {
        id: data.next_attribute_id,
        org_id,
        run_id,
        path: validate_name(Some(&input.path), "attribute path")?,
        kind,
        step: validate_optional_step(input.step.as_ref(), "step")?,
        logged_at: Some(validate_timestamp(input.timestamp.as_deref())?),
        value: input.value,
        summary: validate_json_object(input.summary, "summary")?,
        artifact_id: input.artifact_id,
        created_at: Utc::now(),
    };
    data.next_attribute_id += 1;
    Ok(row)
}

fn validate_attribute_type(kind: &str) -> AppResult<String> {
    let value = validate_name(Some(kind), "type")?;
    if matches!(
        value.as_str(),
        "config"
            | "float_series"
            | "string_series"
            | "file"
            | "file_series"
            | "histogram_series"
            | "tag"
    ) {
        Ok(value)
    } else {
        Err(AppError::validation("unsupported attribute type"))
    }
}

fn normalize_object_kind(kind: &str) -> AppResult<String> {
    let kind = validate_name(Some(kind), "kind")?;
    match kind.as_str() {
        "histogram" => Ok("histogram_series".to_string()),
        "table" | "image" | "video" | "audio" => Ok(kind),
        _ => Err(AppError::validation("unsupported object kind")),
    }
}

fn validate_json_size(value: &Value, field: &str, max: usize) -> AppResult<()> {
    let size = serde_json::to_vec(value)
        .map_err(|_| AppError::validation(format!("{field} must be valid JSON")))?
        .len();
    if size > max {
        Err(AppError::validation(format!("{field} is too large")))
    } else {
        Ok(())
    }
}

fn validate_table_rows(rows: &[Value]) -> AppResult<()> {
    if rows.len() > MAX_TABLE_ROWS_PER_CREATE {
        return Err(AppError::validation(
            "table rows exceed the per-object limit",
        ));
    }
    for row in rows {
        if !row.is_object() {
            return Err(AppError::validation("table rows must be objects"));
        }
        if row.as_object().map(|object| object.len()).unwrap_or(0) > MAX_TABLE_COLUMNS {
            return Err(AppError::validation("table row has too many columns"));
        }
        validate_json_size(row, "table row", MAX_TABLE_ROW_BYTES)?;
    }
    Ok(())
}

fn validate_histogram_value(value: &Value) -> AppResult<()> {
    let bins = value
        .get("bins")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("histogram value must include bins"))?;
    if bins.len() > MAX_HISTOGRAM_BINS {
        return Err(AppError::validation("histogram has too many bins"));
    }
    Ok(())
}

fn table_summary(mut summary: Value, rows: &[Value]) -> AppResult<Value> {
    let object = summary
        .as_object_mut()
        .ok_or_else(|| AppError::validation("summary must be an object"))?;
    object.entry("row_count").or_insert(json!(rows.len()));
    if !object.contains_key("columns") {
        let columns = rows
            .first()
            .and_then(Value::as_object)
            .map(|row| {
                row.keys()
                    .take(MAX_TABLE_COLUMNS)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        object.insert("columns".to_string(), json!(columns));
    }
    Ok(summary)
}

fn media_summary(mut summary: Value, artifact: &ArtifactRow) -> Value {
    let object = summary
        .as_object_mut()
        .expect("validate_json_object guarantees an object");
    object.insert("artifact_name".to_string(), json!(artifact.name));
    object.insert("artifact_uri".to_string(), json!(artifact.uri));
    object.insert("mime_type".to_string(), json!(artifact.mime_type));
    object.insert("size_bytes".to_string(), json!(artifact.size_bytes));
    summary
}

fn validate_artifact_type(kind: &str) -> AppResult<String> {
    let value = validate_name(Some(kind), "artifact type")?;
    if matches!(value.as_str(), "checkpoint" | "rollout" | "file") {
        Ok(value)
    } else {
        Err(AppError::validation(
            "artifact type must be one of: checkpoint, file, rollout",
        ))
    }
}

fn validate_size_bytes(value: &Value) -> AppResult<i64> {
    let size = value
        .as_i64()
        .ok_or_else(|| AppError::validation("size_bytes must be a nonnegative integer"))?;
    if size < 0 {
        Err(AppError::validation(
            "size_bytes must be a nonnegative integer",
        ))
    } else {
        Ok(size)
    }
}

fn attribute_value(row: &AttributeRow) -> Value {
    json!({
        "id": row.id,
        "org_id": row.org_id,
        "run_id": row.run_id,
        "path": row.path,
        "type": row.kind,
        "step": row.step,
        "logged_at": row.logged_at,
        "value": row.value,
        "summary": row.summary,
        "artifact_id": row.artifact_id,
        "created_at": row.created_at
    })
}

fn object_value(data: &StoreData, row: &AttributeRow) -> Value {
    let kind = if row.kind == "histogram_series" {
        "histogram"
    } else {
        row.kind.as_str()
    };
    let metadata = row
        .value
        .get("metadata")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let artifact = row
        .artifact_id
        .and_then(|id| data.artifacts.get(&id))
        .map(|artifact| {
            json!({
                "id": artifact.id,
                "name": artifact.name,
                "uri": artifact.uri,
                "mime_type": artifact.mime_type,
                "size_bytes": artifact.size_bytes
            })
        });
    json!({
        "id": row.id,
        "org_id": row.org_id,
        "run_id": row.run_id,
        "key": row.path,
        "kind": kind,
        "step": row.step,
        "value": row.value,
        "metadata": metadata,
        "summary": row.summary,
        "artifact_id": row.artifact_id,
        "artifact": artifact,
        "created_at": row.created_at
    })
}

fn json_time(value: &Value) -> String {
    value
        .get("created_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn json_step(value: &Value) -> f64 {
    value.get("step").and_then(Value::as_f64).unwrap_or(-1.0)
}

fn json_i64(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn query_step(query: &HashMap<String, String>, key: &str) -> AppResult<Option<f64>> {
    query
        .get(key)
        .map(|raw| validate_query_step(raw, key))
        .transpose()
}

fn validate_query_step(raw: &str, field: &str) -> AppResult<f64> {
    let value = raw
        .parse::<f64>()
        .map_err(|_| AppError::validation(format!("{field} must be a nonnegative number")))?;
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(AppError::validation(format!(
            "{field} must be a nonnegative number"
        )))
    }
}

fn datetime_from_micros(micros: i64) -> DateTime<Utc> {
    let secs = micros.div_euclid(1_000_000);
    let nanos = (micros.rem_euclid(1_000_000) as u32) * 1_000;
    DateTime::<Utc>::from_timestamp(secs, nanos).expect("timestamp micros are in range")
}

fn run_search_text(run: &RunRow) -> String {
    format!(
        "{} {} {} {}",
        run.name,
        run.tags.join(" "),
        run.config,
        run.metadata
    )
    .to_ascii_lowercase()
}

fn parse_run_ids(raw: Option<&String>) -> AppResult<Vec<Uuid>> {
    let raw = raw.ok_or_else(|| AppError::validation("run_ids must include at least one run"))?;
    let ids = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value).map_err(|_| AppError::validation("run id must be a valid UUID"))
        })
        .collect::<AppResult<Vec<_>>>()?;
    if ids.is_empty() {
        Err(AppError::validation(
            "run_ids must include at least one run",
        ))
    } else {
        Ok(ids)
    }
}

fn slugify(value: &str) -> String {
    let mut slug = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "workspace".to_string()
    } else {
        slug.chars().take(63).collect()
    }
}

fn unique_slug(data: &StoreData, base: &str) -> String {
    if !data.orgs_by_slug.contains_key(base) {
        return base.to_string();
    }
    for index in 2..10_000 {
        let candidate = format!("{base}-{index}");
        if !data.orgs_by_slug.contains_key(&candidate) {
            return candidate;
        }
    }
    format!("{}-{}", base, Uuid::new_v4().simple())
}

fn epoch() -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp(0, 0).expect("epoch")
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

#[derive(Default)]
struct CanonicalImport {
    project: String,
    runs: Vec<CanonicalRun>,
}

struct CanonicalRun {
    name: String,
    status: String,
    config: Value,
    tags: Vec<String>,
    metadata: Value,
    metrics: Vec<CanonicalMetric>,
    attributes: Vec<AttributeInput>,
    artifacts: Vec<CanonicalArtifact>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
struct CanonicalMetric {
    key: String,
    step: f64,
    value: f64,
    logged_at: DateTime<Utc>,
}

struct CanonicalArtifact {
    kind: String,
    name: String,
    uri: String,
    step: Option<f64>,
    size_bytes: Option<i64>,
    mime_type: Option<String>,
    metadata: Value,
}

fn normalize_import(source: &str, raw: Value) -> AppResult<CanonicalImport> {
    match source {
        "neptune" => normalize_neptune(raw),
        "wandb" => normalize_wandb(raw),
        "mlflow" => normalize_mlflow(raw),
        _ => Err(AppError::validation("unsupported import source")),
    }
}

fn normalize_neptune(raw: Value) -> AppResult<CanonicalImport> {
    let project = validate_name(raw.get("project").and_then(Value::as_str), "project")?;
    let runs = raw
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("runs must be an array"))?
        .iter()
        .map(|run| {
            let source_metadata =
                validate_json_object(run.get("metadata").cloned(), "neptune metadata")?;
            let external_run_id = optional_text(
                run.get("id")
                    .or_else(|| run.get("neptune_id"))
                    .or_else(|| source_metadata.get("neptune_id")),
                "external_run_id",
            )?;
            let name = validate_name(
                run.get("name")
                    .and_then(Value::as_str)
                    .or(external_run_id.as_deref()),
                "run name",
            )?;
            let metrics = run
                .get("metrics")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .map(metric_from_key_step_value)
                .collect::<AppResult<Vec<_>>>()?;
            let attributes = optional_array(run.get("attributes"), "run attributes")?
                .iter()
                .map(attribute_input_from_value)
                .collect::<AppResult<Vec<_>>>()?;
            let artifacts = optional_array(run.get("artifacts"), "run artifacts")?
                .iter()
                .map(|artifact| canonical_artifact_from_value("neptune", artifact))
                .collect::<AppResult<Vec<_>>>()?;
            let tags = optional_string_vec(run.get("tags"), "tags")?;
            Ok(CanonicalRun {
                name,
                status: run
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| matches!(*status, "running" | "finished" | "failed"))
                    .unwrap_or("finished")
                    .to_string(),
                config: run.get("config").cloned().unwrap_or_else(|| json!({})),
                tags: if tags.is_empty() {
                    vec!["imported".to_string(), "neptune".to_string()]
                } else {
                    tags
                },
                metadata: json!({
                    "source": "neptune",
                    "neptune": { "run_id": external_run_id, "metadata": source_metadata }
                }),
                metrics,
                attributes,
                artifacts,
                started_at: parse_timestamp_value(run.get("started_at"), "started_at")?,
                finished_at: parse_timestamp_value(run.get("finished_at"), "finished_at")?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(CanonicalImport { project, runs })
}

fn normalize_wandb(raw: Value) -> AppResult<CanonicalImport> {
    let project = validate_name(raw.get("project").and_then(Value::as_str), "project")?;
    let runs = raw
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("runs must be an array"))?
        .iter()
        .enumerate()
        .map(|(run_index, run)| {
            let run_id =
                optional_text(run.get("id").or_else(|| run.get("run_id")), "external_run_id")?;
            let name = validate_name(
                run.get("name")
                    .or_else(|| run.get("id"))
                    .and_then(Value::as_str),
                "run name",
            )?;
            let mut metrics = Vec::new();
            for (row_index, point) in run
                .get("history")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .enumerate()
            {
                let step = point
                    .get("_step")
                    .map(|value| validate_step(value, "_step"))
                    .transpose()?
                    .unwrap_or(row_index as f64);
                let timestamp = point
                    .get("_timestamp")
                    .map(|value| parse_timestamp_value(Some(value), "_timestamp"))
                    .transpose()?
                    .flatten()
                    .unwrap_or_else(Utc::now);
                for (key, value) in point.as_object().into_iter().flatten() {
                    if key.starts_with('_') {
                        continue;
                    }
                    if let Some(value) = value.as_f64() {
                        metrics.push(CanonicalMetric {
                            key: key.clone(),
                            step,
                            value,
                            logged_at: timestamp,
                        });
                    }
                }
            }
            let artifacts = optional_array(run.get("artifacts"), "wandb artifacts")?
                .iter()
                .map(|artifact| canonical_artifact_from_value("wandb", artifact))
                .collect::<AppResult<Vec<_>>>()?;
            let source_metadata =
                validate_json_object(run.get("metadata").cloned(), "wandb metadata")?;
            let summary = validate_json_object(run.get("summary").cloned(), "wandb summary")?;
            Ok(CanonicalRun {
                name: if name.is_empty() {
                    format!("wandb-run-{}", run_index + 1)
                } else {
                    name
                },
                status: map_external_run_status(
                    run.get("state")
                        .or_else(|| run.get("status"))
                        .and_then(Value::as_str),
                ),
                config: run.get("config").cloned().unwrap_or_else(|| json!({})),
                tags: optional_string_vec(run.get("tags"), "tags")?,
                metadata: json!({
                    "source": "wandb",
                    "wandb": {
                        "run_id": run_id,
                        "state": run.get("state").or_else(|| run.get("status")).cloned().unwrap_or(Value::Null),
                        "summary": summary,
                        "metadata": source_metadata
                    }
                }),
                metrics,
                attributes: Vec::new(),
                artifacts,
                started_at: parse_timestamp_value(run.get("started_at"), "started_at")?,
                finished_at: parse_timestamp_value(run.get("finished_at"), "finished_at")?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(CanonicalImport { project, runs })
}

fn normalize_mlflow(raw: Value) -> AppResult<CanonicalImport> {
    let project = validate_name(
        raw.get("project")
            .and_then(Value::as_str)
            .or(Some("mlflow-import")),
        "project",
    )?;
    let runs = raw
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("runs must be an array"))?
        .iter()
        .map(|run| {
            let info = run.get("info").unwrap_or(&Value::Null);
            let data = run.get("data").unwrap_or(&Value::Null);
            let params = key_value_object(data.get("params"), "mlflow param")?;
            let tags = key_value_object(data.get("tags"), "mlflow tag")?;
            let name = validate_name(
                info.get("run_name")
                    .or_else(|| tags.get("mlflow.runName"))
                    .or_else(|| info.get("run_id"))
                    .and_then(Value::as_str)
                    .or(Some("mlflow-run")),
                "run name",
            )?;
            let status = match info
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("FINISHED")
            {
                "FAILED" | "KILLED" => "failed",
                "RUNNING" => "running",
                _ => "finished",
            }
            .to_string();
            let latest_metrics = data
                .get("metrics")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .map(metric_from_key_step_value)
                .collect::<AppResult<Vec<_>>>()?;
            let history_metrics = run
                .get("metric_history")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .map(metric_from_key_step_value)
                .collect::<AppResult<Vec<_>>>()?;
            let history_keys = history_metrics
                .iter()
                .map(|metric| metric.key.clone())
                .collect::<BTreeSet<_>>();
            let metrics = if history_metrics.is_empty() {
                latest_metrics.clone()
            } else {
                history_metrics
                    .into_iter()
                    .chain(
                        latest_metrics
                            .iter()
                            .filter(|metric| !history_keys.contains(&metric.key))
                            .cloned(),
                    )
                    .collect()
            };
            let artifacts = optional_array(run.get("artifacts"), "mlflow artifacts")?
                .iter()
                .filter(|artifact| artifact.get("is_dir").and_then(Value::as_bool) != Some(true))
                .map(|artifact| canonical_artifact_from_value("mlflow", artifact))
                .collect::<AppResult<Vec<_>>>()?;
            let started_at = parse_timestamp_value(info.get("start_time"), "mlflow start_time")?;
            let finished_at = parse_timestamp_value(info.get("end_time"), "mlflow end_time")?;
            Ok(CanonicalRun {
                name,
                status,
                config: params.clone(),
                tags: vec!["imported".to_string(), "mlflow".to_string()],
                metadata: json!({
                    "source": "mlflow",
                    "mlflow": {
                        "run_id": info.get("run_id").or_else(|| info.get("run_uuid")).cloned().unwrap_or(Value::Null),
                        "run_uuid": info.get("run_uuid").or_else(|| info.get("run_id")).cloned().unwrap_or(Value::Null),
                        "experiment_id": info.get("experiment_id").cloned().unwrap_or(Value::Null),
                        "status": info.get("status").or_else(|| run.get("status")).cloned().unwrap_or(Value::Null),
                        "start_time": started_at.map(|value| value.to_rfc3339()),
                        "end_time": finished_at.map(|value| value.to_rfc3339()),
                        "artifact_uri": info.get("artifact_uri").cloned().unwrap_or(Value::Null),
                        "params": params,
                        "tags": tags,
                        "metric_history_complete": run.get("metric_history_complete").and_then(Value::as_bool) == Some(true)
                    }
                }),
                metrics,
                attributes: Vec::new(),
                artifacts,
                started_at,
                finished_at,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(CanonicalImport { project, runs })
}

fn metric_from_key_step_value(value: &Value) -> AppResult<CanonicalMetric> {
    let key = validate_name(value.get("key").and_then(Value::as_str), "metric key")?;
    let step = value.get("step").and_then(Value::as_f64).unwrap_or(0.0);
    let metric_value = value
        .get("value")
        .and_then(Value::as_f64)
        .ok_or_else(|| AppError::validation("metric value must be a number"))?;
    let logged_at =
        parse_timestamp_value(value.get("timestamp"), "metric timestamp")?.unwrap_or_else(Utc::now);
    Ok(CanonicalMetric {
        key,
        step: validate_metric_value(step)?,
        value: validate_metric_value(metric_value)?,
        logged_at,
    })
}

fn parse_timestamp_value(value: Option<&Value>, field: &str) -> AppResult<Option<DateTime<Utc>>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(validate_timestamp(Some(text))?)),
        Some(Value::Number(number)) => {
            let raw = number
                .as_f64()
                .ok_or_else(|| AppError::validation(format!("{field} must be finite")))?;
            if !raw.is_finite() {
                return Err(AppError::validation(format!("{field} must be finite")));
            }
            let millis = if raw.abs() >= 10_000_000_000.0 {
                raw.round() as i64
            } else {
                (raw * 1_000.0).round() as i64
            };
            Ok(Some(datetime_from_millis(millis)?))
        }
        _ => Err(AppError::validation(format!(
            "{field} must be epoch time or an ISO-compatible datetime"
        ))),
    }
}

fn datetime_from_millis(millis: i64) -> AppResult<DateTime<Utc>> {
    let secs = millis.div_euclid(1_000);
    let nanos = (millis.rem_euclid(1_000) as u32) * 1_000_000;
    DateTime::<Utc>::from_timestamp(secs, nanos)
        .ok_or_else(|| AppError::validation("timestamp must be within supported datetime range"))
}

fn optional_array<'a>(value: Option<&'a Value>, field: &str) -> AppResult<&'a [Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        _ => Err(AppError::validation(format!("{field} must be a list"))),
    }
}

fn object_ref<'a>(value: &'a Value, field: &str) -> AppResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| AppError::validation(format!("{field} must be an object")))
}

fn optional_text(value: Option<&Value>, field: &str) -> AppResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => validate_optional_name(Some(text), field),
        Some(other) => validate_optional_name(Some(&other.to_string()), field),
    }
}

fn optional_string_vec(value: Option<&Value>, field: &str) -> AppResult<Vec<String>> {
    optional_array(value, field)?
        .iter()
        .map(|item| validate_name(item.as_str(), field))
        .collect()
}

fn key_value_object(value: Option<&Value>, field: &str) -> AppResult<Value> {
    let mut values = Map::new();
    for candidate in optional_array(value, &format!("{field}s"))? {
        let entry = object_ref(candidate, field)?;
        let key = validate_name(
            entry.get("key").and_then(Value::as_str),
            &format!("{field} key"),
        )?;
        if values.contains_key(&key) {
            continue;
        }
        let value = entry.get("value").cloned().unwrap_or(Value::Null);
        values.insert(key, value);
    }
    Ok(Value::Object(values))
}

fn map_external_run_status(value: Option<&str>) -> String {
    match value.unwrap_or_default().to_ascii_lowercase().as_str() {
        "running" => "running",
        "failed" | "crashed" | "killed" => "failed",
        _ => "finished",
    }
    .to_string()
}

fn attribute_input_from_value(value: &Value) -> AppResult<AttributeInput> {
    let object = object_ref(value, "run attribute")?;
    let kind = validate_attribute_type(
        object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("attribute type is required"))?,
    )?;
    let path = validate_name(object.get("path").and_then(Value::as_str), "attribute path")?;
    let step = object.get("step").cloned();
    if let Some(step) = step.as_ref() {
        validate_optional_step(Some(step), "step")?;
    }
    let timestamp = object
        .get("timestamp")
        .and_then(Value::as_str)
        .map(|raw| validate_timestamp(Some(raw)).map(|timestamp| timestamp.to_rfc3339()))
        .transpose()?;
    let value = object
        .get("value")
        .cloned()
        .ok_or_else(|| AppError::validation("attribute value is required"))?;
    let summary = object.get("summary").cloned();
    validate_json_object(summary.clone(), "attribute summary")?;
    Ok(AttributeInput {
        path,
        kind,
        step,
        timestamp,
        value,
        summary,
        artifact_id: None,
    })
}

fn canonical_artifact_from_value(source: &str, value: &Value) -> AppResult<CanonicalArtifact> {
    let object = object_ref(value, &format!("{source} artifact"))?;
    let name = object
        .get("name")
        .or_else(|| object.get("path"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("artifact name must be a non-empty string"))?;
    let external_type = object
        .get("type")
        .map(|value| optional_text(Some(value), "artifact type"))
        .transpose()?
        .flatten();
    let kind = map_external_artifact_type(external_type.as_deref(), name);
    let uri = object
        .get("uri")
        .and_then(Value::as_str)
        .map(|value| validate_name(Some(value), "artifact uri"))
        .transpose()?
        .unwrap_or_else(|| format!("{source}://{name}"));
    let step = object
        .get("step")
        .map(|value| validate_optional_step(Some(value), "step"))
        .transpose()?
        .flatten();
    let size_bytes = object
        .get("size_bytes")
        .or_else(|| object.get("file_size"))
        .map(validate_size_bytes)
        .transpose()?;
    let mime_type = object
        .get("mime_type")
        .and_then(Value::as_str)
        .map(|value| validate_name(Some(value), "mime_type"))
        .transpose()?;
    let mut metadata = validate_json_object(object.get("metadata").cloned(), "artifact metadata")?;
    if let Some(map) = metadata.as_object_mut() {
        if let Some(external_type) = external_type {
            map.insert("external_type".to_string(), json!(external_type));
        }
        map.insert("source".to_string(), json!(source));
    }
    Ok(CanonicalArtifact {
        kind: kind.to_string(),
        name: validate_name(Some(name), "artifact name")?,
        uri,
        step,
        size_bytes,
        mime_type,
        metadata,
    })
}

fn map_external_artifact_type(external_type: Option<&str>, name: &str) -> &'static str {
    let text = format!("{} {}", external_type.unwrap_or_default(), name).to_ascii_lowercase();
    if text.contains("checkpoint")
        || text.contains("model")
        || text.ends_with(".pt")
        || text.ends_with(".pth")
        || text.ends_with(".ckpt")
        || text.ends_with(".safetensors")
        || text.ends_with(".onnx")
    {
        "checkpoint"
    } else if text.contains("rollout")
        || text.contains("video")
        || text.ends_with(".mp4")
        || text.ends_with(".mov")
        || text.ends_with(".webm")
    {
        "rollout"
    } else {
        "file"
    }
}

fn demo_run_name(workload: &str, index: usize, seed: i64) -> String {
    if workload == "llm" {
        format!("llm-{}-seed-{seed}", ["sft", "dpo", "rag-eval"][index % 3])
    } else {
        format!(
            "rl-{}-seed-{seed}",
            ["ppo-cartpole", "sac-hopper", "dqn-minigrid"][index % 3]
        )
    }
}

fn demo_config(workload: &str, index: usize, seed: i64) -> Value {
    json!({
        "workload": workload,
        "seed": seed,
        "learning_rate": if index % 2 == 0 { 0.0003 } else { 0.0001 },
        "hardware": { "gpu_model": if index % 4 == 0 { "NVIDIA H100" } else { "NVIDIA A100" }, "gpu_count": 1 + (index % 8) }
    })
}

fn demo_tags(workload: &str, index: usize, seed: i64) -> Vec<String> {
    vec![
        "demo".to_string(),
        workload.to_string(),
        if index % 3 == 0 {
            "baseline"
        } else {
            "candidate"
        }
        .to_string(),
        format!("seed-{seed}"),
        if index % 5 == 0 {
            "reward-stability"
        } else {
            "healthy"
        }
        .to_string(),
    ]
}

fn demo_metadata(workload: &str, index: usize, seed: i64) -> Value {
    json!({
        "source": "demo-reset",
        "notes": if workload == "rl" {
            format!("Synthetic RL run {index}: reward stability and rollout quality for seed {seed}.")
        } else {
            format!("Synthetic LLM run {index}: loss, eval quality, and throughput for seed {seed}.")
        },
        "demo": { "seed": seed, "run_index": index }
    })
}

fn demo_artifacts(workload: &str, seed: i64) -> Vec<ArtifactRow> {
    let mut rows = vec![
        demo_artifact(
            "checkpoint",
            format!("checkpoint-step-200-seed-{seed}.pt"),
            format!("demo://checkpoints/{seed}.pt"),
            Some(200.0),
            Some(48_000_000 + seed),
        ),
        demo_artifact(
            "file",
            format!("run-config-seed-{seed}.json"),
            format!("demo://configs/{seed}.json"),
            None,
            Some(4096 + seed),
        ),
    ];
    if workload == "rl" {
        rows.push(demo_artifact(
            "rollout",
            format!("eval-rollout-seed-{seed}.mp4"),
            format!("demo://rollouts/{seed}.mp4"),
            Some(200.0),
            Some(8_000_000 + seed),
        ));
    } else {
        rows.push(demo_artifact(
            "file",
            format!("eval-audio-seed-{seed}.mp3"),
            format!("demo://audio/{seed}.mp3"),
            Some(200.0),
            Some(2_000_000 + seed),
        ));
    }
    rows
}

fn demo_artifact(
    kind: &str,
    name: String,
    uri: String,
    step: Option<f64>,
    size_bytes: Option<i64>,
) -> ArtifactRow {
    ArtifactRow {
        id: Uuid::new_v4(),
        org_id: LOCAL_ORG_ID,
        run_id: Uuid::nil(),
        kind: kind.to_string(),
        name,
        uri,
        step,
        size_bytes,
        sha256: None,
        mime_type: None,
        storage_backend: "external".to_string(),
        storage_key: None,
        storage_path: None,
        metadata: json!({ "source": "demo" }),
        created_at: Utc::now(),
    }
}

fn demo_metrics(workload: &str, index: usize, seed: i64, step: i64) -> Vec<(String, f64)> {
    let progress = step as f64 / 200.0;
    let wave = ((seed as f64) * 0.017 + step as f64 / 19.0).sin();
    let reward = 25.0 + progress * (260.0 + (index % 23) as f64 * 4.0) + wave * 18.0;
    vec![
        ("eval/return_mean".to_string(), round4(reward)),
        (
            "eval/loss".to_string(),
            round4((2.2 - progress * 1.4 + wave.abs() * 0.05).max(0.1)),
        ),
        ("train/reward".to_string(), round4(reward * 0.94)),
        (
            "train/loss".to_string(),
            round4((1.9 - progress * 1.2 + wave.abs() * 0.08).max(0.05)),
        ),
        (
            "train/grad_norm".to_string(),
            round4((0.8 + wave.abs() * 0.22 + (1.0 - progress) * 0.15).max(0.05)),
        ),
        ("rollout/ep_rew_mean".to_string(), round4(reward * 0.98)),
        (
            "agent/action_std".to_string(),
            round4((0.9 - progress * 0.55 + wave.abs() * 0.04).max(0.05)),
        ),
        (
            "data/loader_wait_ms".to_string(),
            round4((42.0 - 24.0 * progress + wave.abs() * 10.0).max(2.0)),
        ),
        (
            "system/cpu_percent".to_string(),
            round4(34.0 + 38.0 * progress + wave * 6.0),
        ),
        (
            "gpu/0/utilization_percent".to_string(),
            round4((55.0 + 38.0 * progress + wave * 8.0).clamp(0.0, 100.0)),
        ),
        (format!("{workload}/quality"), round4(0.3 + progress * 0.5)),
    ]
}
