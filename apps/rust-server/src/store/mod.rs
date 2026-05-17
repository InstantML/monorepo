use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};

mod access;
mod auth;
mod console_logs;
mod demo;
mod export;
mod imports;
mod objects;
mod runs;
mod summaries;
mod tenants;
mod usage;
mod validation;

use access::*;
pub use auth::*;
pub use console_logs::*;
pub use demo::*;
pub use export::*;
pub use imports::*;
pub use objects::*;
pub use runs::*;
use summaries::*;
pub use tenants::TenantRouteRecord;
pub use usage::*;
use validation::*;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    artifact_store::LocalArtifactStore,
    auth::{generate_api_key, generate_session_token, hash_idempotency, hash_secret},
    config::{AppConfig, HostedClickHouseConfig},
    control_store::{ControlRecordRow, ControlStore},
    domain::{
        plan_tier, validate_account_type, validate_email, validate_json_object, validate_limit,
        validate_membership_role, validate_name, validate_offset, validate_optional_name,
        validate_optional_step, validate_plan_tier, validate_slug, validate_status, validate_step,
        validate_tags, validate_timestamp, ArtifactRow, AttributeInput, AttributeRow, AuthContext,
        AuthSessionPayload, ClerkAuthRequest, ConsoleLogInput, CreateApiKeyRequest,
        CreateArtifactRequest, CreateAttributesRequest, CreateConsoleLogsRequest,
        CreateObjectRequest, CreateOrganizationRequest, CreateProjectRequest, CreateRunRequest,
        CreateUserRequest, CreatedAuthSession, DevGoogleAuthRequest, LogMetricsRequest,
        MembershipRow, MetricSeriesRow, OnboardingApiKey, OrganizationRow, ProjectRow,
        ProvisioningStatusPayload, PublicApiKeyRow, RequestContext, ReserveSeatRequest, RunRow,
        SeatRow, SeatUserRow, ServiceAccountRow, UpdateRunRequest, UploadArtifactRequest, UserRow,
        UserSessionRow, DEFAULT_CONSOLE_LOG_LIMIT, DEFAULT_METRIC_LIMIT, DEFAULT_RUN_LIMIT,
        MAX_CONSOLE_LOG_LIMIT, MAX_CONSOLE_LOG_LINES_PER_BATCH, MAX_CONSOLE_LOG_MESSAGE_BYTES,
        MAX_METRICS_PER_BATCH, MAX_METRIC_LIMIT, MAX_METRIC_SERIES_RUN_IDS, MAX_RUN_LIMIT,
        MAX_TEXT_BYTES, PLAN_FREE, PLAN_PREMIUM, PLAN_PRO,
    },
    errors::{AppError, AppResult},
    metric_store::{
        ConsoleLogInsertRow, ConsoleLogReadRow, MetricPointRow as ChMetricPointRow, MetricStore,
        OperationalRecordRow, SeriesReadRow, SeriesSortMode,
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
const DEMO_API_KEY_SCOPES: &[&str] = &["export:read"];
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
    control_store: Option<ControlStore>,
    hosted_clickhouse: Option<HostedClickHouseConfig>,
    tenant_metric_stores: Arc<Mutex<HashMap<Uuid, MetricStore>>>,
    tenant_loaded: Arc<Mutex<BTreeSet<Uuid>>>,
    inflight_idempotency: Arc<Mutex<BTreeSet<(Uuid, String)>>>,
    data: Arc<Mutex<StoreData>>,
    record_clock_micros: Arc<Mutex<i64>>,
}

impl Store {
    pub async fn connect(
        metric_store: MetricStore,
        control_store: Option<ControlStore>,
        hosted_clickhouse: Option<HostedClickHouseConfig>,
    ) -> AppResult<Self> {
        let store = Self {
            metric_store,
            control_store,
            hosted_clickhouse,
            tenant_metric_stores: Arc::new(Mutex::new(HashMap::new())),
            tenant_loaded: Arc::new(Mutex::new(BTreeSet::new())),
            inflight_idempotency: Arc::new(Mutex::new(BTreeSet::new())),
            data: Arc::new(Mutex::new(StoreData::default())),
            record_clock_micros: Arc::new(Mutex::new(0)),
        };
        store.rebuild().await?;
        if !store.hosted_clickhouse_enabled() {
            store.ensure_local_org().await?;
        }
        Ok(store)
    }

    pub fn metric_store(&self) -> &MetricStore {
        &self.metric_store
    }

    async fn rebuild(&self) -> AppResult<()> {
        let (data, latest_record_micros) = if let Some(control_store) = &self.control_store {
            let records = control_store.load_records().await?;
            let mut data = StoreData::default();
            let stats = data.apply_control_records(records)?;
            (data, stats.latest_record_micros)
        } else {
            let records = self.metric_store.load_operational_records().await?;
            let mut data = StoreData::default();
            let stats = data.apply_operational_records(records, ReplayScope::All)?;
            (data, stats.latest_record_micros)
        };
        *self.data.lock().await = data;
        *self.record_clock_micros.lock().await = latest_record_micros;
        Ok(())
    }

    pub async fn refresh_control_records(&self) -> AppResult<()> {
        let Some(control_store) = &self.control_store else {
            return Ok(());
        };
        let records = control_store.load_records().await?;
        if records.is_empty() {
            return Ok(());
        }
        let (stats, changed_tenant_routes) = {
            let mut data = self.data.lock().await;
            let previous_routes = data.tenant_routes.clone();
            let stats = data.apply_control_records(records)?;
            let changed_routes = changed_tenant_routes(&previous_routes, &data.tenant_routes);
            (stats, changed_routes)
        };
        if !changed_tenant_routes.is_empty() {
            let mut loaded = self.tenant_loaded.lock().await;
            let mut stores = self.tenant_metric_stores.lock().await;
            for org_id in &changed_tenant_routes {
                loaded.remove(org_id);
                stores.remove(org_id);
            }
        }
        let mut clock = self.record_clock_micros.lock().await;
        *clock = (*clock).max(stats.latest_record_micros);
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
            seat_limit: plan_tier("free").included_seats,
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
        if self.is_control_record_kind(kind) {
            if let Some(control_store) = &self.control_store {
                let scope = control_record_scope(kind);
                let control = ControlRecordRow {
                    event_id: Uuid::new_v4(),
                    scope: scope.to_string(),
                    kind: row.kind,
                    org_id: if scope == "global" {
                        Uuid::nil()
                    } else {
                        org_id
                    },
                    entity_id: row.entity_id,
                    payload: row.payload,
                    created_at: row.created_at,
                };
                return control_store.insert_record(&control).await;
            }
        }
        let metric_store = self.metric_store_for_persist(org_id).await?;
        metric_store.insert_operational_record(&row).await
    }

    async fn next_record_created_at(&self) -> DateTime<Utc> {
        let mut clock = self.record_clock_micros.lock().await;
        let next = Utc::now().timestamp_micros().max(*clock + 1);
        *clock = next;
        datetime_from_micros(next)
    }

    pub(super) async fn reserve_idempotency_key(&self, org_id: Uuid, key: &str) -> AppResult<()> {
        let mut inflight = self.inflight_idempotency.lock().await;
        if !inflight.insert((org_id, key.to_string())) {
            return Err(AppError::conflict(
                "idempotency key is already being processed",
            ));
        }
        Ok(())
    }

    pub(super) async fn release_idempotency_key(&self, org_id: Uuid, key: &str) {
        self.inflight_idempotency
            .lock()
            .await
            .remove(&(org_id, key.to_string()));
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
    runs_by_org_created: BTreeMap<(Uuid, DateTime<Utc>, Uuid), Uuid>,
    runs_by_org_project_created: BTreeMap<(Uuid, String, DateTime<Utc>, Uuid), Uuid>,
    run_search_texts: HashMap<Uuid, String>,
    attributes: BTreeMap<(Uuid, i64), AttributeRow>,
    attributes_by_run: HashMap<Uuid, Vec<i64>>,
    artifacts: BTreeMap<Uuid, ArtifactRow>,
    artifacts_by_run: HashMap<Uuid, Vec<Uuid>>,
    table_rows: HashMap<(Uuid, i64), Vec<TableObjectRow>>,
    imports: BTreeMap<(Uuid, i64), ImportRow>,
    idempotency: HashMap<(Uuid, String), IdempotencyRecord>,
    usage_daily: Vec<Value>,
    tenant_routes: BTreeMap<Uuid, TenantRouteRecord>,
    next_attribute_id_by_org: HashMap<Uuid, i64>,
    next_import_id_by_org: HashMap<Uuid, i64>,
}

impl StoreData {
    fn apply_operational_records(
        &mut self,
        mut records: Vec<OperationalRecordRow>,
        scope: ReplayScope,
    ) -> AppResult<ReplayStats> {
        records.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.kind.cmp(&right.kind))
                .then_with(|| left.org_id.cmp(&right.org_id))
                .then_with(|| left.entity_id.cmp(&right.entity_id))
                .then_with(|| left.payload.cmp(&right.payload))
        });
        let mut stats = ReplayStats::default();
        for record in records {
            if let ReplayScope::Tenant(expected_org_id) = scope {
                validate_tenant_record_for_replay(expected_org_id, &record)?;
            }
            stats.latest_record_micros = stats
                .latest_record_micros
                .max(record.created_at.timestamp_micros());
            self.apply_record(&record.kind, record.org_id, &record.payload)?;
        }
        self.recompute_counters();
        Ok(stats)
    }

    fn apply_control_records(
        &mut self,
        mut records: Vec<ControlRecordRow>,
    ) -> AppResult<ReplayStats> {
        records.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        let mut stats = ReplayStats::default();
        for record in records {
            stats.latest_record_micros = stats
                .latest_record_micros
                .max(record.created_at.timestamp_micros());
            self.apply_record(&record.kind, record.org_id, &record.payload)?;
        }
        self.recompute_counters();
        Ok(stats)
    }

    fn apply_record(&mut self, kind: &str, org_id: Uuid, payload: &str) -> AppResult<()> {
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
                self.table_rows
                    .insert((org_id, item.attribute_id), item.rows);
            }
            "import" => {
                let item: ImportRow = parse_payload(payload)?;
                self.imports.insert((item.org_id, item.id), item);
            }
            "idempotency" => {
                let item: IdempotencyRecord = parse_payload(payload)?;
                self.idempotency
                    .insert((item.org_id, item.key.clone()), item);
            }
            "usage_daily" => self.usage_daily.push(parse_payload(payload)?),
            "tenant_route" => self.insert_tenant_route(parse_payload(payload)?),
            _ => {}
        }
        Ok(())
    }

    fn recompute_counters(&mut self) {
        self.next_attribute_id_by_org.clear();
        for attribute in self.attributes.values() {
            let next = self
                .next_attribute_id_by_org
                .entry(attribute.org_id)
                .or_insert(1);
            *next = (*next).max(attribute.id + 1);
        }
        self.next_import_id_by_org.clear();
        for import in self.imports.values() {
            let next = self.next_import_id_by_org.entry(import.org_id).or_insert(1);
            *next = (*next).max(import.id + 1);
        }
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
        if let Some(existing) = self.runs.get(&run.id) {
            self.runs_by_org_created
                .remove(&(existing.org_id, existing.created_at, existing.id));
            self.runs_by_org_project_created.remove(&(
                existing.org_id,
                existing.project.clone(),
                existing.created_at,
                existing.id,
            ));
        }
        self.runs_by_org_created
            .insert((run.org_id, run.created_at, run.id), run.id);
        self.runs_by_org_project_created.insert(
            (run.org_id, run.project.clone(), run.created_at, run.id),
            run.id,
        );
        self.run_search_texts.insert(run.id, run_search_text(&run));
        self.runs.insert(run.id, run);
    }

    fn insert_attribute(&mut self, attribute: AttributeRow) {
        let next = self
            .next_attribute_id_by_org
            .entry(attribute.org_id)
            .or_insert(1);
        *next = (*next).max(attribute.id + 1);
        self.attributes_by_run
            .entry(attribute.run_id)
            .or_default()
            .retain(|id| *id != attribute.id);
        self.attributes_by_run
            .entry(attribute.run_id)
            .or_default()
            .push(attribute.id);
        self.attributes
            .insert((attribute.org_id, attribute.id), attribute);
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
            self.remove_run(run_id);
            if let Some(attribute_ids) = self.attributes_by_run.remove(&run_id) {
                for id in attribute_ids {
                    self.attributes.remove(&(delete.org_id, id));
                    self.table_rows.remove(&(delete.org_id, id));
                }
            }
            if let Some(artifact_ids) = self.artifacts_by_run.remove(&run_id) {
                for id in artifact_ids {
                    self.artifacts.remove(&id);
                }
            }
        }
    }

    fn insert_tenant_route(&mut self, route: TenantRouteRecord) {
        self.tenant_routes.insert(route.org_id, route);
    }

    fn remove_run(&mut self, run_id: Uuid) {
        if let Some(run) = self.runs.remove(&run_id) {
            self.runs_by_org_created
                .remove(&(run.org_id, run.created_at, run.id));
            self.runs_by_org_project_created.remove(&(
                run.org_id,
                run.project.clone(),
                run.created_at,
                run.id,
            ));
            self.run_search_texts.remove(&run.id);
        }
    }

    fn allocate_attribute_id(&mut self, org_id: Uuid) -> i64 {
        let next = self.next_attribute_id_by_org.entry(org_id).or_insert(1);
        let id = *next;
        *next += 1;
        id
    }

    fn allocate_import_id(&mut self, org_id: Uuid) -> i64 {
        let next = self.next_import_id_by_org.entry(org_id).or_insert(1);
        let id = *next;
        *next += 1;
        id
    }
}

#[derive(Clone, Copy)]
enum ReplayScope {
    All,
    Tenant(Uuid),
}

#[derive(Default)]
struct ReplayStats {
    latest_record_micros: i64,
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

fn validate_tenant_record_for_replay(
    expected_org_id: Uuid,
    record: &OperationalRecordRow,
) -> AppResult<()> {
    if record.org_id != expected_org_id {
        return Err(AppError::internal(
            "tenant operational record belonged to a different org",
        ));
    }
    let payload = serde_json::from_str::<Value>(&record.payload)
        .map_err(|_| AppError::internal("tenant operational record payload is invalid"))?;
    if let Some(payload_org_id) = payload_org_id(&payload)? {
        if payload_org_id != expected_org_id {
            return Err(AppError::internal(
                "tenant operational record payload belonged to a different org",
            ));
        }
    }
    validate_tenant_record_entity(record, &payload)
}

fn payload_org_id(payload: &Value) -> AppResult<Option<Uuid>> {
    payload
        .get("org_id")
        .or_else(|| payload.get("row").and_then(|row| row.get("org_id")))
        .and_then(Value::as_str)
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| AppError::internal("tenant operational record org_id is invalid"))
}

fn validate_tenant_record_entity(record: &OperationalRecordRow, payload: &Value) -> AppResult<()> {
    match record.kind.as_str() {
        "project" | "run" | "artifact" => validate_payload_string_id(record, payload, "id"),
        "attribute" | "import" => validate_payload_i64_id(record, payload, "id"),
        "idempotency" => validate_payload_string_id(record, payload, "key"),
        "project_delete" => validate_payload_string_id(record, payload, "project_name"),
        "table_rows" => validate_payload_i64_id(record, payload, "attribute_id"),
        "usage_daily" => validate_usage_daily_orgs(record.org_id, payload),
        _ => Ok(()),
    }
}

fn validate_payload_string_id(
    record: &OperationalRecordRow,
    payload: &Value,
    field: &str,
) -> AppResult<()> {
    let payload_id = payload
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("tenant operational record entity id is missing"))?;
    if payload_id != record.entity_id {
        return Err(AppError::internal(
            "tenant operational record entity id mismatch",
        ));
    }
    Ok(())
}

fn validate_payload_i64_id(
    record: &OperationalRecordRow,
    payload: &Value,
    field: &str,
) -> AppResult<()> {
    let payload_id = payload
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::internal("tenant operational record entity id is missing"))?;
    if payload_id.to_string() != record.entity_id {
        return Err(AppError::internal(
            "tenant operational record entity id mismatch",
        ));
    }
    Ok(())
}

fn validate_usage_daily_orgs(expected_org_id: Uuid, payload: &Value) -> AppResult<()> {
    let Some(organizations) = payload.get("organizations").and_then(Value::as_array) else {
        return Ok(());
    };
    for organization in organizations {
        let Some(raw_org_id) = organization.get("org_id").and_then(Value::as_str) else {
            continue;
        };
        let org_id = Uuid::parse_str(raw_org_id)
            .map_err(|_| AppError::internal("tenant usage snapshot org_id is invalid"))?;
        if org_id != expected_org_id {
            return Err(AppError::internal(
                "tenant usage snapshot belonged to a different org",
            ));
        }
    }
    Ok(())
}

pub async fn ready(store: &Store) -> bool {
    if !crate::metric_store::ready(store.metric_store()).await {
        return false;
    }
    control_ready(store).await
}

pub async fn control_ready(store: &Store) -> bool {
    match &store.control_store {
        Some(control_store) => control_store.ready().await,
        None => true,
    }
}

fn control_record_scope(kind: &str) -> &'static str {
    match kind {
        "user" | "identity" => "global",
        _ => "org",
    }
}

fn changed_tenant_routes(
    previous: &BTreeMap<Uuid, TenantRouteRecord>,
    current: &BTreeMap<Uuid, TenantRouteRecord>,
) -> BTreeSet<Uuid> {
    previous
        .keys()
        .chain(current.keys())
        .filter(|org_id| previous.get(org_id) != current.get(org_id))
        .copied()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replay_row<T: Serialize>(
        kind: &str,
        org_id: Uuid,
        entity_id: impl Into<String>,
        payload: &T,
        created_at_micros: i64,
    ) -> OperationalRecordRow {
        OperationalRecordRow {
            kind: kind.to_string(),
            org_id,
            entity_id: entity_id.into(),
            payload: serde_json::to_string(payload).unwrap(),
            created_at: datetime_from_micros(created_at_micros),
        }
    }

    fn control_replay_row<T: Serialize>(
        kind: &str,
        org_id: Uuid,
        entity_id: impl Into<String>,
        event_id: Uuid,
        payload: &T,
        created_at_micros: i64,
    ) -> ControlRecordRow {
        ControlRecordRow {
            event_id,
            scope: "org".to_string(),
            kind: kind.to_string(),
            org_id,
            entity_id: entity_id.into(),
            payload: serde_json::to_string(payload).unwrap(),
            created_at: datetime_from_micros(created_at_micros),
        }
    }

    fn replay_project(org_id: Uuid, project_id: Uuid, name: &str) -> ProjectRow {
        ProjectRow {
            id: project_id,
            org_id,
            name: name.to_string(),
            description: None,
            created_at: epoch(),
        }
    }

    fn replay_run(org_id: Uuid, run_id: Uuid, status: &str) -> RunRow {
        RunRow {
            id: run_id,
            org_id,
            project_id: Uuid::from_u128(200),
            project: "project".to_string(),
            name: "train".to_string(),
            status: status.to_string(),
            config: json!({}),
            tags: vec![],
            metadata: json!({}),
            created_at: epoch(),
            started_at: epoch(),
            finished_at: None,
        }
    }

    #[test]
    fn control_record_scope_keeps_user_identity_global() {
        assert_eq!(control_record_scope("user"), "global");
        assert_eq!(control_record_scope("identity"), "global");
        assert_eq!(control_record_scope("organization"), "org");
        assert_eq!(control_record_scope("api_key"), "org");
    }

    #[test]
    fn tenant_local_integer_ids_are_keyed_by_org() {
        let org_a = Uuid::from_u128(1);
        let org_b = Uuid::from_u128(2);
        let run_a = Uuid::from_u128(10);
        let run_b = Uuid::from_u128(20);
        let mut data = StoreData::default();

        data.insert_attribute(AttributeRow {
            id: 1,
            org_id: org_a,
            run_id: run_a,
            path: "score".to_string(),
            kind: "float_series".to_string(),
            step: Some(1.0),
            logged_at: Some(epoch()),
            value: json!(0.8),
            summary: json!({}),
            artifact_id: None,
            created_at: epoch(),
        });
        data.insert_attribute(AttributeRow {
            id: 1,
            org_id: org_b,
            run_id: run_b,
            path: "score".to_string(),
            kind: "float_series".to_string(),
            step: Some(1.0),
            logged_at: Some(epoch()),
            value: json!(0.9),
            summary: json!({}),
            artifact_id: None,
            created_at: epoch(),
        });

        assert_eq!(data.attributes.len(), 2);
        assert_eq!(data.attributes[&(org_a, 1)].run_id, run_a);
        assert_eq!(data.attributes[&(org_b, 1)].run_id, run_b);
        assert_eq!(data.allocate_attribute_id(org_a), 2);
        assert_eq!(data.allocate_attribute_id(org_b), 2);
    }

    #[test]
    fn operational_replay_sorts_records_and_keeps_latest_projection() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(10);
        let older = replay_run(org_id, run_id, "running");
        let newer = replay_run(org_id, run_id, "finished");
        let mut data = StoreData::default();

        let stats = data
            .apply_operational_records(
                vec![
                    replay_row("run", org_id, run_id.to_string(), &newer, 20),
                    replay_row("run", org_id, run_id.to_string(), &older, 10),
                ],
                ReplayScope::All,
            )
            .unwrap();

        assert_eq!(stats.latest_record_micros, 20);
        assert_eq!(data.runs.len(), 1);
        assert_eq!(data.runs[&run_id].status, "finished");
        assert_eq!(
            data.runs_by_org_created
                .get(&(org_id, epoch(), run_id))
                .copied(),
            Some(run_id)
        );
    }

    #[test]
    fn operational_replay_is_deterministic_for_equal_timestamps() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(10);
        let first = replay_row(
            "run",
            org_id,
            run_id.to_string(),
            &replay_run(org_id, run_id, "alpha"),
            10,
        );
        let second = replay_row(
            "run",
            org_id,
            run_id.to_string(),
            &replay_run(org_id, run_id, "zulu"),
            10,
        );
        let mut left = StoreData::default();
        let mut right = StoreData::default();

        left.apply_operational_records(vec![first.clone(), second.clone()], ReplayScope::All)
            .unwrap();
        right
            .apply_operational_records(vec![second, first], ReplayScope::All)
            .unwrap();

        assert_eq!(left.runs[&run_id].status, right.runs[&run_id].status);
    }

    #[test]
    fn control_replay_uses_event_id_as_equal_timestamp_tiebreaker() {
        let org_id = Uuid::from_u128(1);
        let older = OrganizationRow {
            id: org_id,
            slug: "org".to_string(),
            name: "Older".to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 1,
            created_by_user_id: None,
            created_at: epoch(),
        };
        let newer = OrganizationRow {
            name: "Newer".to_string(),
            ..older.clone()
        };
        let older_event_id = Uuid::from_u128(1);
        let newer_event_id = Uuid::from_u128(2);
        let mut data = StoreData::default();

        let stats = data
            .apply_control_records(vec![
                control_replay_row(
                    "organization",
                    org_id,
                    org_id.to_string(),
                    newer_event_id,
                    &newer,
                    10,
                ),
                control_replay_row(
                    "organization",
                    org_id,
                    org_id.to_string(),
                    older_event_id,
                    &older,
                    10,
                ),
            ])
            .unwrap();

        assert_eq!(data.organizations[&org_id].name, "Newer");
        assert_eq!(stats.latest_record_micros, 10);
    }

    #[test]
    fn changed_tenant_routes_returns_only_final_route_differences() {
        fn test_route(org_id: Uuid, endpoint: &str) -> TenantRouteRecord {
            TenantRouteRecord {
                org_id,
                status: "ready".to_string(),
                provisioner: "database".to_string(),
                plan_tier: Some("free".to_string()),
                warehouse_kind: Some("shared".to_string()),
                requested_min_replica_memory_gb: Some(8),
                requested_max_replica_memory_gb: Some(8),
                requested_num_replicas: Some(1),
                applied_min_replica_memory_gb: Some(8),
                applied_max_replica_memory_gb: Some(8),
                applied_num_replicas: Some(1),
                endpoint: endpoint.to_string(),
                database: "default".to_string(),
                username: "default".to_string(),
                password_secret_ref: Some("config:tenant_base_url_password".to_string()),
                password_ciphertext: None,
                service_id: None,
                created_at: epoch(),
                updated_at: epoch(),
                error: None,
            }
        }

        let stable_org_id = Uuid::from_u128(1);
        let changed_org_id = Uuid::from_u128(2);
        let new_org_id = Uuid::from_u128(3);
        let stable = test_route(stable_org_id, "https://stable.example.com:8443");
        let changed_before = test_route(changed_org_id, "https://old.example.com:8443");
        let changed_after = test_route(changed_org_id, "https://new.example.com:8443");
        let new_route = test_route(new_org_id, "https://new.example.com:8443");
        let previous = BTreeMap::from([
            (stable_org_id, stable.clone()),
            (changed_org_id, changed_before),
        ]);
        let current = BTreeMap::from([
            (stable_org_id, stable),
            (changed_org_id, changed_after),
            (new_org_id, new_route),
        ]);

        assert_eq!(
            changed_tenant_routes(&previous, &current),
            BTreeSet::from([changed_org_id, new_org_id])
        );
    }

    #[test]
    fn tenant_replay_rejects_record_from_another_org() {
        let expected = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let project_id = Uuid::from_u128(20);
        let project = replay_project(other, project_id, "other");
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row(
                    "project",
                    other,
                    project_id.to_string(),
                    &project,
                    10,
                )],
                ReplayScope::Tenant(expected),
            )
            .is_err());
    }

    #[test]
    fn tenant_replay_rejects_payload_from_another_org() {
        let expected = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let project_id = Uuid::from_u128(20);
        let project = replay_project(other, project_id, "misrouted");
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row(
                    "project",
                    expected,
                    project_id.to_string(),
                    &project,
                    10,
                )],
                ReplayScope::Tenant(expected),
            )
            .is_err());
    }

    #[test]
    fn tenant_replay_rejects_table_rows_entity_mismatch() {
        let org_id = Uuid::from_u128(1);
        let rows = TableRowsRecord {
            attribute_id: 7,
            rows: Vec::new(),
        };
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row("table_rows", org_id, "8", &rows, 10)],
                ReplayScope::Tenant(org_id),
            )
            .is_err());
    }

    #[test]
    fn tenant_replay_rejects_usage_snapshot_for_another_org() {
        let expected = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let snapshot = json!({
            "organizations": [{
                "org_id": other.to_string(),
                "usage": {}
            }]
        });
        let mut data = StoreData::default();

        assert!(data
            .apply_operational_records(
                vec![replay_row("usage_daily", expected, "daily", &snapshot, 10)],
                ReplayScope::Tenant(expected),
            )
            .is_err());
    }
}
