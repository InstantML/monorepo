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
        validate_account_type, validate_email, validate_json_object, validate_limit,
        validate_membership_role, validate_name, validate_offset, validate_optional_name,
        validate_optional_step, validate_plan_tier, validate_slug, validate_status, validate_step,
        validate_tags, validate_timestamp, ArtifactRow, AttributeInput, AttributeRow, AuthContext,
        AuthSessionPayload, ConsoleLogInput, CreateApiKeyRequest, CreateArtifactRequest,
        CreateAttributesRequest, CreateConsoleLogsRequest, CreateObjectRequest,
        CreateOrganizationRequest, CreateProjectRequest, CreateRunRequest, CreateUserRequest,
        CreatedAuthSession, DevGoogleAuthRequest, LogMetricsRequest, MembershipRow,
        MetricSeriesRow, OrganizationRow, ProjectRow, ProvisioningStatusPayload, PublicApiKeyRow,
        RequestContext, ReserveSeatRequest, RunRow, ServiceAccountRow, UpdateRunRequest,
        UploadArtifactRequest, UserRow, UserSessionRow, DEFAULT_CONSOLE_LOG_LIMIT,
        DEFAULT_METRIC_LIMIT, DEFAULT_RUN_LIMIT, MAX_CONSOLE_LOG_LIMIT,
        MAX_CONSOLE_LOG_LINES_PER_BATCH, MAX_CONSOLE_LOG_MESSAGE_BYTES, MAX_METRICS_PER_BATCH,
        MAX_METRIC_LIMIT, MAX_METRIC_SERIES_RUN_IDS, MAX_RUN_LIMIT, MAX_TEXT_BYTES,
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
        let records = if let Some(control_store) = &self.control_store {
            control_store
                .load_records()
                .await?
                .into_iter()
                .map(|record| OperationalRecordRow {
                    kind: record.kind,
                    org_id: record.org_id,
                    entity_id: record.entity_id,
                    payload: record.payload,
                    created_at: record.created_at,
                })
                .collect::<Vec<_>>()
        } else {
            self.metric_store.load_operational_records().await?
        };
        let latest_record_micros = records
            .iter()
            .map(|record| record.created_at.timestamp_micros())
            .max()
            .unwrap_or(0);
        let mut data = StoreData::default();
        for record in records {
            data.apply_record(&record.kind, record.org_id, &record.payload)?;
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
    if !crate::metric_store::ready(store.metric_store()).await {
        return false;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
