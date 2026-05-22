use super::*;
use crate::{
    config::{ClickHouseCloudConfig, ClickHouseProvisioner},
    metric_store::{self, connect_connection, parse_clickhouse_url, ClickHouseConnection},
};

const TENANT_ROUTE_KIND: &str = "tenant_route";
const TENANT_ROUTE_READY: &str = "ready";
const TENANT_ROUTE_PROVISIONING: &str = "provisioning";
const TENANT_ROUTE_FAILED: &str = "failed";
const TENANT_BASE_PASSWORD_REF: &str = "config:tenant_base_url_password";

/// Sentinel UUID that identifies a shared-cell tenant route in design
/// documentation and tooling. Production code routes each org to the shared
/// cell using the org's own `org_id` in the `tenant_route` record; this
/// constant is exposed for tests and future migration tooling.
#[allow(dead_code)]
pub const SHARED_CELL_ORG_ID: Uuid = Uuid::from_u128(0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff);
const SHARED_CELL_PROVISIONER: &str = "shared-cell";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TenantRouteRecord {
    pub org_id: Uuid,
    pub status: String,
    pub provisioner: String,
    #[serde(default)]
    pub plan_tier: Option<String>,
    #[serde(default)]
    pub warehouse_kind: Option<String>,
    #[serde(default)]
    pub requested_min_replica_memory_gb: Option<u32>,
    #[serde(default)]
    pub requested_max_replica_memory_gb: Option<u32>,
    #[serde(default)]
    pub requested_num_replicas: Option<u32>,
    #[serde(default)]
    pub applied_min_replica_memory_gb: Option<u32>,
    #[serde(default)]
    pub applied_max_replica_memory_gb: Option<u32>,
    #[serde(default)]
    pub applied_num_replicas: Option<u32>,
    pub endpoint: String,
    pub database: String,
    pub username: String,
    pub password_secret_ref: Option<String>,
    pub password_ciphertext: Option<String>,
    pub service_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub error: Option<String>,
}

impl Store {
    pub(super) fn hosted_clickhouse_enabled(&self) -> bool {
        self.hosted_clickhouse.is_some()
    }

    pub(super) fn is_control_record_kind(&self, kind: &str) -> bool {
        self.hosted_clickhouse_enabled()
            && matches!(
                kind,
                "user"
                    | "identity"
                    | "organization"
                    | "membership"
                    | "org_invitation"
                    | "email_delivery"
                    | "session"
                    | "service_account"
                    | "api_key"
                    | "dashboard_preference"
                    | "workspace_view"
                    | "billing_account"
                    | "billing_checkout_intent"
                    | "billing_change_intent"
                    | "billing_subscription"
                    | "billing_event"
                    | "billing_usage_report"
                    | TENANT_ROUTE_KIND
            )
    }

    pub async fn ensure_tenant_loaded(&self, org_id: Uuid) -> AppResult<()> {
        if !self.hosted_clickhouse_enabled() {
            return Ok(());
        }
        if self.tenant_loaded.lock().await.contains(&org_id) {
            return Ok(());
        }
        let route = {
            let data = self.data.lock().await;
            data.tenant_routes.get(&org_id).cloned()
        }
        .ok_or_else(|| tenant_unavailable("tenant route is not provisioned"))?;

        if route.status != TENANT_ROUTE_READY {
            return Err(tenant_unavailable(
                route
                    .error
                    .as_deref()
                    .unwrap_or("tenant route is not ready"),
            ));
        }

        let metric_store = self.metric_store_from_route(&route).await?;
        let records = metric_store.load_operational_records().await?;
        let stats = {
            let mut data = self.data.lock().await;
            data.apply_operational_records(records, ReplayScope::Tenant(org_id))?
        };
        self.tenant_metric_stores
            .lock()
            .await
            .insert(org_id, metric_store);
        self.tenant_loaded.lock().await.insert(org_id);
        let mut clock = self.record_clock_micros.lock().await;
        *clock = (*clock).max(stats.latest_record_micros);
        Ok(())
    }

    pub(super) async fn metric_store_for_org(&self, org_id: Uuid) -> AppResult<MetricStore> {
        // If the org routes to the shared cell, return the shared-cell store directly.
        if self.org_uses_shared_cell(org_id).await {
            return self
                .shared_cell_metric_store
                .clone()
                .ok_or_else(|| tenant_unavailable("shared cell is not configured"));
        }
        self.ensure_tenant_loaded(org_id).await?;
        self.metric_store_for_persist(org_id).await
    }

    pub(super) async fn metric_store_for_persist(&self, org_id: Uuid) -> AppResult<MetricStore> {
        if !self.hosted_clickhouse_enabled() {
            return Ok(self.metric_store.clone());
        }
        // Shared-cell orgs never get a per-org tenant metric store entry.
        if self.org_uses_shared_cell(org_id).await {
            return self
                .shared_cell_metric_store
                .clone()
                .ok_or_else(|| tenant_unavailable("shared cell is not configured"));
        }
        self.tenant_metric_stores
            .lock()
            .await
            .get(&org_id)
            .cloned()
            .ok_or_else(|| tenant_unavailable("tenant route is not loaded"))
    }

    /// Returns true when the org's routing tier is "shared" and a shared-cell
    /// MetricStore is configured. In local/non-hosted mode always returns false.
    pub(super) async fn org_uses_shared_cell(&self, org_id: Uuid) -> bool {
        if self.shared_cell_metric_store.is_none() {
            return false;
        }
        let data = self.data.lock().await;
        data.organizations
            .get(&org_id)
            .map(|org| org.tenant_routing_tier == "shared")
            .unwrap_or(false)
    }

    pub(super) async fn warehouse_storage_bytes_for_org(
        &self,
        org_id: Uuid,
    ) -> AppResult<Option<i64>> {
        if self.hosted_clickhouse_enabled() && self.org_uses_shared_cell(org_id).await {
            return Ok(None);
        }
        self.metric_store_for_org(org_id)
            .await?
            .count_database_storage_bytes()
            .await
            .map(Some)
    }

    pub(super) async fn ensure_tenant_route(
        &self,
        org: &OrganizationRow,
    ) -> AppResult<TenantRouteRecord> {
        if !self.hosted_clickhouse_enabled() {
            return Ok(local_route(org));
        }

        // Personal/free orgs route to the shared cell — no Cloud provisioning.
        if org.tenant_routing_tier == "shared" {
            return self.ensure_shared_cell_route(org).await;
        }

        let existing_route = {
            let data = self.data.lock().await;
            data.tenant_routes.get(&org.id).cloned()
        };
        if let Some(route) = existing_route {
            if route.status == TENANT_ROUTE_READY {
                return Ok(route);
            }
            if let Some(resumed) = self.try_resume_tenant_route(&route).await? {
                return Ok(resumed);
            }
            if !self.can_retry_route(&route) {
                return Err(tenant_unavailable(
                    route
                        .error
                        .as_deref()
                        .unwrap_or("tenant route is not ready"),
                ));
            }
        }

        let now = Utc::now();
        let profile = tenant_route_profile(
            org,
            self.hosted_clickhouse
                .as_ref()
                .and_then(|hosted| hosted.cloud.as_ref()),
        );
        let provisioning = with_profile(
            TenantRouteRecord {
                org_id: org.id,
                status: TENANT_ROUTE_PROVISIONING.to_string(),
                provisioner: self.provisioner_name(),
                plan_tier: None,
                warehouse_kind: None,
                requested_min_replica_memory_gb: None,
                requested_max_replica_memory_gb: None,
                requested_num_replicas: None,
                applied_min_replica_memory_gb: None,
                applied_max_replica_memory_gb: None,
                applied_num_replicas: None,
                endpoint: String::new(),
                database: String::new(),
                username: String::new(),
                password_secret_ref: None,
                password_ciphertext: None,
                service_id: None,
                created_at: now,
                updated_at: now,
                error: None,
            },
            profile,
        );
        self.persist_locked(
            TENANT_ROUTE_KIND,
            org.id,
            &org.id.to_string(),
            &provisioning,
        )
        .await?;
        self.data
            .lock()
            .await
            .insert_tenant_route(provisioning.clone());

        match self.provision_tenant_route(org).await {
            Ok(route) => {
                self.persist_locked(TENANT_ROUTE_KIND, org.id, &org.id.to_string(), &route)
                    .await?;
                self.data.lock().await.insert_tenant_route(route.clone());
                let metric_store = self.metric_store_from_route(&route).await?;
                self.tenant_metric_stores
                    .lock()
                    .await
                    .insert(org.id, metric_store);
                self.tenant_loaded.lock().await.insert(org.id);
                Ok(route)
            }
            Err(error) => {
                let failed = self
                    .data
                    .lock()
                    .await
                    .tenant_routes
                    .get(&org.id)
                    .cloned()
                    .filter(|route| route.status == TENANT_ROUTE_FAILED)
                    .unwrap_or_else(|| {
                        with_profile(
                            TenantRouteRecord {
                                org_id: org.id,
                                status: TENANT_ROUTE_FAILED.to_string(),
                                provisioner: self.provisioner_name(),
                                plan_tier: None,
                                warehouse_kind: None,
                                requested_min_replica_memory_gb: None,
                                requested_max_replica_memory_gb: None,
                                requested_num_replicas: None,
                                applied_min_replica_memory_gb: None,
                                applied_max_replica_memory_gb: None,
                                applied_num_replicas: None,
                                endpoint: String::new(),
                                database: String::new(),
                                username: String::new(),
                                password_secret_ref: None,
                                password_ciphertext: None,
                                service_id: None,
                                created_at: now,
                                updated_at: Utc::now(),
                                error: Some(error.message().to_string()),
                            },
                            profile,
                        )
                    });
                self.persist_locked(TENANT_ROUTE_KIND, org.id, &org.id.to_string(), &failed)
                    .await?;
                self.data.lock().await.insert_tenant_route(failed);
                Err(error)
            }
        }
    }

    /// Ensure a tenant route exists for a personal/shared-cell org.
    /// Returns a ready route pointing at the shared cell without making any
    /// ClickHouse Cloud API call. The shared-cell MetricStore is already
    /// initialized at Store::connect time.
    async fn ensure_shared_cell_route(
        &self,
        org: &OrganizationRow,
    ) -> AppResult<TenantRouteRecord> {
        // If we already have a ready shared-cell route for this org, return it.
        let existing = {
            let data = self.data.lock().await;
            data.tenant_routes.get(&org.id).cloned()
        };
        if let Some(route) = existing {
            if route.status == TENANT_ROUTE_READY && route.provisioner == SHARED_CELL_PROVISIONER {
                return Ok(route);
            }
        }

        let hosted = self
            .hosted_clickhouse
            .as_ref()
            .ok_or_else(|| AppError::internal("hosted ClickHouse config missing"))?;
        let shared_url = hosted
            .shared_cell_url
            .as_deref()
            .ok_or_else(|| tenant_unavailable("INSTANTML_SHARED_CELL_URL is not configured"))?;
        let parsed = parse_clickhouse_url(shared_url, "INSTANTML_SHARED_CELL_URL")?;
        let database = std::env::var("INSTANTML_SHARED_CELL_DATABASE")
            .unwrap_or_else(|_| "instantml_shared".to_string());
        let now = Utc::now();
        let route = TenantRouteRecord {
            org_id: org.id,
            status: TENANT_ROUTE_READY.to_string(),
            provisioner: SHARED_CELL_PROVISIONER.to_string(),
            plan_tier: Some("free".to_string()),
            warehouse_kind: Some("shared".to_string()),
            requested_min_replica_memory_gb: Some(8),
            requested_max_replica_memory_gb: Some(8),
            requested_num_replicas: Some(1),
            applied_min_replica_memory_gb: Some(8),
            applied_max_replica_memory_gb: Some(8),
            applied_num_replicas: Some(1),
            endpoint: parsed.endpoint,
            database,
            username: parsed.username,
            password_secret_ref: None,
            password_ciphertext: Some(parsed.password),
            service_id: None,
            created_at: now,
            updated_at: now,
            error: None,
        };
        self.persist_locked(TENANT_ROUTE_KIND, org.id, &org.id.to_string(), &route)
            .await?;
        self.data.lock().await.insert_tenant_route(route.clone());
        Ok(route)
    }

    async fn provision_tenant_route(&self, org: &OrganizationRow) -> AppResult<TenantRouteRecord> {
        let hosted = self
            .hosted_clickhouse
            .as_ref()
            .ok_or_else(|| AppError::internal("hosted ClickHouse config missing"))?;
        match hosted.provisioner {
            ClickHouseProvisioner::Database => self.provision_database_tenant(org).await,
            ClickHouseProvisioner::CloudService => self.provision_cloud_service_tenant(org).await,
        }
    }

    async fn provision_database_tenant(
        &self,
        org: &OrganizationRow,
    ) -> AppResult<TenantRouteRecord> {
        let hosted = self
            .hosted_clickhouse
            .as_ref()
            .ok_or_else(|| AppError::internal("hosted ClickHouse config missing"))?;
        let base =
            parse_clickhouse_url(&hosted.tenant_base_url, "INSTANTML_TENANT_CLICKHOUSE_URL")?;
        let connection = ClickHouseConnection {
            endpoint: base.endpoint.clone(),
            username: base.username.clone(),
            password: base.password.clone(),
            database: tenant_database_name(org.id),
        };
        let metric_store = connect_connection(&connection)?;
        metric_store::migrate(&metric_store).await?;
        let profile = tenant_route_profile(org, None);
        Ok(with_profile(
            TenantRouteRecord {
                org_id: org.id,
                status: TENANT_ROUTE_READY.to_string(),
                provisioner: "database".to_string(),
                plan_tier: None,
                warehouse_kind: None,
                requested_min_replica_memory_gb: None,
                requested_max_replica_memory_gb: None,
                requested_num_replicas: None,
                applied_min_replica_memory_gb: None,
                applied_max_replica_memory_gb: None,
                applied_num_replicas: None,
                endpoint: connection.endpoint,
                database: connection.database,
                username: connection.username,
                password_secret_ref: Some(TENANT_BASE_PASSWORD_REF.to_string()),
                password_ciphertext: None,
                service_id: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                error: None,
            },
            profile,
        ))
    }

    async fn persist_tenant_route(&self, route: TenantRouteRecord) -> AppResult<()> {
        self.persist_locked(
            TENANT_ROUTE_KIND,
            route.org_id,
            &route.org_id.to_string(),
            &route,
        )
        .await?;
        self.data.lock().await.insert_tenant_route(route);
        Ok(())
    }

    async fn try_resume_tenant_route(
        &self,
        route: &TenantRouteRecord,
    ) -> AppResult<Option<TenantRouteRecord>> {
        if route.provisioner != "cloud-service" || route.service_id.is_none() {
            return Ok(None);
        }
        if route.endpoint.is_empty() || route.username.is_empty() || route.database.is_empty() {
            return Err(tenant_unavailable(
                "tenant route has a ClickHouse Cloud service id but is missing connection details",
            ));
        }
        let metric_store = self.metric_store_from_route(route).await.map_err(|error| {
            tenant_unavailable(format!("tenant route resume failed: {}", error.message()))
        })?;
        let mut ready = route.clone();
        ready.status = TENANT_ROUTE_READY.to_string();
        ready.updated_at = Utc::now();
        ready.error = None;
        self.persist_tenant_route(ready.clone()).await?;
        self.tenant_metric_stores
            .lock()
            .await
            .insert(route.org_id, metric_store);
        self.tenant_loaded.lock().await.insert(route.org_id);
        Ok(Some(ready))
    }

    async fn provision_cloud_service_tenant(
        &self,
        org: &OrganizationRow,
    ) -> AppResult<TenantRouteRecord> {
        let hosted = self
            .hosted_clickhouse
            .as_ref()
            .ok_or_else(|| AppError::internal("hosted ClickHouse config missing"))?;
        if !hosted.allow_stored_tenant_passwords {
            return Err(AppError::config(
                "cloud-service provisioning requires INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS=true until a secret manager is wired",
            ));
        }
        let cloud = hosted
            .cloud
            .as_ref()
            .ok_or_else(|| AppError::config("cloud-service provisioner is missing cloud config"))?;
        let created = create_cloud_service(cloud, org).await?;
        let now = Utc::now();
        let profile = tenant_route_profile(org, Some(cloud));
        let draft = with_profile(
            TenantRouteRecord {
                org_id: org.id,
                status: TENANT_ROUTE_PROVISIONING.to_string(),
                provisioner: "cloud-service".to_string(),
                plan_tier: None,
                warehouse_kind: None,
                requested_min_replica_memory_gb: None,
                requested_max_replica_memory_gb: None,
                requested_num_replicas: None,
                applied_min_replica_memory_gb: None,
                applied_max_replica_memory_gb: None,
                applied_num_replicas: None,
                endpoint: created.endpoint.clone(),
                database: "default".to_string(),
                username: created.username.clone(),
                password_secret_ref: created
                    .service_id
                    .as_ref()
                    .map(|id| format!("clickhouse-cloud:service:{id}")),
                password_ciphertext: Some(created.password.clone()),
                service_id: created.service_id.clone(),
                created_at: now,
                updated_at: now,
                error: None,
            },
            profile,
        );
        self.persist_tenant_route(draft.clone()).await?;
        let connection = ClickHouseConnection {
            endpoint: created.endpoint.clone(),
            username: created.username.clone(),
            password: created.password.clone(),
            database: "default".to_string(),
        };
        let metric_store = connect_connection(&connection)?;
        if let Err(error) = metric_store::migrate(&metric_store).await {
            let mut failed = draft;
            failed.status = TENANT_ROUTE_FAILED.to_string();
            failed.updated_at = Utc::now();
            failed.error = Some(error.message().to_string());
            self.persist_tenant_route(failed).await?;
            return Err(error);
        }
        let mut ready = draft;
        ready.status = TENANT_ROUTE_READY.to_string();
        ready.updated_at = Utc::now();
        ready.error = None;
        Ok(ready)
    }

    async fn metric_store_from_route(&self, route: &TenantRouteRecord) -> AppResult<MetricStore> {
        let password = self.tenant_password(route)?;
        let connection = ClickHouseConnection {
            endpoint: route.endpoint.clone(),
            username: route.username.clone(),
            password,
            database: route.database.clone(),
        };
        let metric_store = connect_connection(&connection)?;
        metric_store::migrate(&metric_store).await?;
        Ok(metric_store)
    }

    fn tenant_password(&self, route: &TenantRouteRecord) -> AppResult<String> {
        if let Some(password) = &route.password_ciphertext {
            return Ok(password.clone());
        }
        if route.password_secret_ref.as_deref() == Some(TENANT_BASE_PASSWORD_REF) {
            let hosted = self
                .hosted_clickhouse
                .as_ref()
                .ok_or_else(|| AppError::internal("hosted ClickHouse config missing"))?;
            return Ok(parse_clickhouse_url(
                &hosted.tenant_base_url,
                "INSTANTML_TENANT_CLICKHOUSE_URL",
            )?
            .password);
        }
        Err(tenant_unavailable(
            "tenant password secret reference cannot be resolved",
        ))
    }

    fn provisioner_name(&self) -> String {
        self.hosted_clickhouse
            .as_ref()
            .map(|hosted| match hosted.provisioner {
                ClickHouseProvisioner::Database => "database",
                ClickHouseProvisioner::CloudService => "cloud-service",
            })
            .unwrap_or("local")
            .to_string()
    }

    fn can_retry_route(&self, route: &TenantRouteRecord) -> bool {
        let retryable_status = matches!(
            route.status.as_str(),
            TENANT_ROUTE_PROVISIONING | TENANT_ROUTE_FAILED
        );
        match self
            .hosted_clickhouse
            .as_ref()
            .map(|hosted| &hosted.provisioner)
        {
            Some(ClickHouseProvisioner::Database) => retryable_status,
            Some(ClickHouseProvisioner::CloudService) => {
                retryable_status && route.service_id.is_none()
            }
            None => false,
        }
    }
}

fn tenant_database_name(org_id: Uuid) -> String {
    format!("instantml_org_{}", org_id.simple())
}

fn tenant_unavailable(message: impl Into<String>) -> AppError {
    AppError::warehouse_unavailable(message)
}

fn local_route(org: &OrganizationRow) -> TenantRouteRecord {
    with_profile(
        TenantRouteRecord {
            org_id: org.id,
            status: TENANT_ROUTE_READY.to_string(),
            provisioner: "local".to_string(),
            plan_tier: None,
            warehouse_kind: None,
            requested_min_replica_memory_gb: None,
            requested_max_replica_memory_gb: None,
            requested_num_replicas: None,
            applied_min_replica_memory_gb: None,
            applied_max_replica_memory_gb: None,
            applied_num_replicas: None,
            endpoint: String::new(),
            database: String::new(),
            username: String::new(),
            password_secret_ref: None,
            password_ciphertext: None,
            service_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            error: None,
        },
        tenant_route_profile(org, None),
    )
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct TenantWarehouseProfile {
    plan_tier: &'static str,
    warehouse_kind: &'static str,
    requested_min_replica_memory_gb: u32,
    requested_max_replica_memory_gb: u32,
    requested_num_replicas: u32,
    applied_min_replica_memory_gb: u32,
    applied_max_replica_memory_gb: u32,
    applied_num_replicas: u32,
}

fn tenant_route_profile(
    org: &OrganizationRow,
    cloud: Option<&ClickHouseCloudConfig>,
) -> TenantWarehouseProfile {
    let plan = plan_tier(&org.plan_tier);
    let (applied_min, applied_max, applied_replicas) = match cloud {
        Some(cloud) if !cloud.allow_plan_sizing => (
            cloud.min_replica_memory_gb,
            cloud.max_replica_memory_gb,
            cloud.num_replicas,
        ),
        _ => (
            plan.min_replica_memory_gb,
            plan.max_replica_memory_gb,
            plan.num_replicas,
        ),
    };
    TenantWarehouseProfile {
        plan_tier: plan.id,
        warehouse_kind: plan.warehouse_kind,
        requested_min_replica_memory_gb: plan.min_replica_memory_gb,
        requested_max_replica_memory_gb: plan.max_replica_memory_gb,
        requested_num_replicas: plan.num_replicas,
        applied_min_replica_memory_gb: applied_min,
        applied_max_replica_memory_gb: applied_max,
        applied_num_replicas: applied_replicas,
    }
}

fn with_profile(
    mut route: TenantRouteRecord,
    profile: TenantWarehouseProfile,
) -> TenantRouteRecord {
    route.plan_tier = Some(profile.plan_tier.to_string());
    route.warehouse_kind = Some(profile.warehouse_kind.to_string());
    route.requested_min_replica_memory_gb = Some(profile.requested_min_replica_memory_gb);
    route.requested_max_replica_memory_gb = Some(profile.requested_max_replica_memory_gb);
    route.requested_num_replicas = Some(profile.requested_num_replicas);
    route.applied_min_replica_memory_gb = Some(profile.applied_min_replica_memory_gb);
    route.applied_max_replica_memory_gb = Some(profile.applied_max_replica_memory_gb);
    route.applied_num_replicas = Some(profile.applied_num_replicas);
    route
}

struct CloudTenant {
    endpoint: String,
    username: String,
    password: String,
    service_id: Option<String>,
}

async fn create_cloud_service(
    cloud: &ClickHouseCloudConfig,
    org: &OrganizationRow,
) -> AppResult<CloudTenant> {
    let client = reqwest::Client::new();
    let organization_id = resolve_cloud_organization_id(&client, cloud).await?;
    let service_name = cloud_service_name(org);
    if let Some(existing) =
        find_cloud_service_by_name(&client, cloud, &organization_id, &service_name).await?
    {
        let service_id = existing
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::internal("ClickHouse Cloud service response omitted id"))?;
        let (fallback_endpoint, fallback_username) =
            endpoint_from_service(&existing).unwrap_or_else(|| (String::new(), String::new()));
        let (endpoint, username) = wait_for_cloud_service(
            &client,
            cloud,
            &organization_id,
            service_id,
            &fallback_endpoint,
            &fallback_username,
        )
        .await?;
        if endpoint.is_empty() || username.is_empty() {
            return Err(AppError::internal(
                "ClickHouse Cloud response omitted HTTPS endpoint",
            ));
        }
        let password =
            reset_cloud_service_password(&client, cloud, &organization_id, service_id).await?;
        return Ok(CloudTenant {
            endpoint,
            username,
            password,
            service_id: Some(service_id.to_string()),
        });
    }
    let profile = tenant_route_profile(org, Some(cloud));
    let body = json!({
        "name": service_name,
        "provider": cloud.provider,
        "region": cloud.region,
        "ipAccessList": cloud_ip_access_list(cloud),
        "minReplicaMemoryGb": profile.applied_min_replica_memory_gb,
        "maxReplicaMemoryGb": profile.applied_max_replica_memory_gb,
        "numReplicas": profile.applied_num_replicas
    });
    let value = cloud_request(
        client
            .post(cloud_url(
                cloud,
                &format!("/organizations/{organization_id}/services"),
            ))
            .basic_auth(&cloud.key_id, Some(&cloud.key_secret))
            .json(&body),
    )
    .await?;
    let result = value.get("result").unwrap_or(&value);
    let service = result.get("service").unwrap_or(result);
    let password = result
        .get("password")
        .or_else(|| value.get("password"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("ClickHouse Cloud create response omitted password"))?
        .to_string();
    let service_id = service
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let (endpoint, username) = endpoint_from_service(service)
        .ok_or_else(|| AppError::internal("ClickHouse Cloud response omitted HTTPS endpoint"))?;
    if let Some(service_id) = &service_id {
        let waited = wait_for_cloud_service(
            &client,
            cloud,
            &organization_id,
            service_id,
            &endpoint,
            &username,
        )
        .await?;
        return Ok(CloudTenant {
            endpoint: waited.0,
            username: waited.1,
            password,
            service_id: Some(service_id.clone()),
        });
    }
    Ok(CloudTenant {
        endpoint,
        username,
        password,
        service_id,
    })
}

async fn reset_cloud_service_password(
    client: &reqwest::Client,
    cloud: &ClickHouseCloudConfig,
    organization_id: &str,
    service_id: &str,
) -> AppResult<String> {
    let value = cloud_request(
        client
            .patch(cloud_url(
                cloud,
                &format!("/organizations/{organization_id}/services/{service_id}/password"),
            ))
            .basic_auth(&cloud.key_id, Some(&cloud.key_secret))
            .json(&json!({})),
    )
    .await?;
    let result = value.get("result").unwrap_or(&value);
    result
        .get("password")
        .or_else(|| value.get("password"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("ClickHouse Cloud password reset omitted password"))
        .map(str::to_string)
}

async fn find_cloud_service_by_name(
    client: &reqwest::Client,
    cloud: &ClickHouseCloudConfig,
    organization_id: &str,
    service_name: &str,
) -> AppResult<Option<Value>> {
    let value = cloud_request(
        client
            .get(cloud_url(
                cloud,
                &format!("/organizations/{organization_id}/services"),
            ))
            .basic_auth(&cloud.key_id, Some(&cloud.key_secret)),
    )
    .await?;
    Ok(cloud_services_from_response(&value)
        .into_iter()
        .find(|service| service.get("name").and_then(Value::as_str) == Some(service_name)))
}

fn cloud_services_from_response(value: &Value) -> Vec<Value> {
    let result = value.get("result").unwrap_or(value);
    if let Some(services) = result.as_array() {
        return services.clone();
    }
    for key in ["services", "data", "items"] {
        if let Some(services) = result.get(key).and_then(Value::as_array) {
            return services.clone();
        }
    }
    Vec::new()
}

async fn wait_for_cloud_service(
    client: &reqwest::Client,
    cloud: &ClickHouseCloudConfig,
    organization_id: &str,
    service_id: &str,
    fallback_endpoint: &str,
    fallback_username: &str,
) -> AppResult<(String, String)> {
    let deadline = std::time::Instant::now() + cloud.wait_timeout;
    while std::time::Instant::now() < deadline {
        let value = cloud_request(
            client
                .get(cloud_url(
                    cloud,
                    &format!("/organizations/{organization_id}/services/{service_id}"),
                ))
                .basic_auth(&cloud.key_id, Some(&cloud.key_secret)),
        )
        .await?;
        let service = value.get("result").unwrap_or(&value);
        if let Some((endpoint, username)) = endpoint_from_service(service) {
            let state = service.get("state").and_then(Value::as_str).unwrap_or("");
            if matches!(state, "running" | "idle" | "partially_running") {
                return Ok((endpoint, username));
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    Ok((fallback_endpoint.to_string(), fallback_username.to_string()))
}

async fn resolve_cloud_organization_id(
    client: &reqwest::Client,
    cloud: &ClickHouseCloudConfig,
) -> AppResult<String> {
    if let Some(id) = cloud.organization_id.as_deref() {
        return Ok(id.to_string());
    }
    let value = cloud_request(
        client
            .get(cloud_url(cloud, "/organizations"))
            .basic_auth(&cloud.key_id, Some(&cloud.key_secret)),
    )
    .await?;
    organization_id_from_response(&value).ok_or_else(|| {
        AppError::config(
            "ClickHouse Cloud organization id was not configured and discovery returned no organizations",
        )
    })
}

fn organization_id_from_response(value: &Value) -> Option<String> {
    let result = value.get("result").unwrap_or(value);
    if let Some(id) = result.get("id").and_then(Value::as_str) {
        return Some(id.to_string());
    }
    if let Some(id) = result
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
    {
        return Some(id.to_string());
    }
    for key in ["organizations", "data", "items"] {
        if let Some(id) = result
            .get(key)
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("id"))
            .and_then(Value::as_str)
        {
            return Some(id.to_string());
        }
    }
    None
}

async fn cloud_request(builder: reqwest::RequestBuilder) -> AppResult<Value> {
    let response = builder
        .send()
        .await
        .map_err(|err| AppError::internal(format!("ClickHouse Cloud request failed: {err}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| AppError::internal(format!("ClickHouse Cloud response failed: {err}")))?;
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .or_else(|| value.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or(text);
        return Err(AppError::internal(format!(
            "ClickHouse Cloud request failed with {status}: {message}"
        )));
    }
    serde_json::from_str(&text)
        .map_err(|err| AppError::internal(format!("ClickHouse Cloud JSON failed: {err}")))
}

fn cloud_url(cloud: &ClickHouseCloudConfig, path: &str) -> String {
    let mut base = cloud.endpoint.trim_end_matches('/').to_string();
    if !base.ends_with("/v1") {
        base.push_str("/v1");
    }
    format!("{base}{path}")
}

fn endpoint_from_service(service: &Value) -> Option<(String, String)> {
    let endpoint = service
        .get("endpoints")?
        .as_array()?
        .iter()
        .find(|endpoint| {
            endpoint
                .get("protocol")
                .and_then(Value::as_str)
                .is_some_and(|protocol| protocol == "https")
        })?;
    let host = endpoint.get("host")?.as_str()?;
    let port = endpoint.get("port").and_then(Value::as_u64).unwrap_or(8443);
    let username = endpoint
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_string();
    Some((format!("https://{host}:{port}"), username))
}

fn cloud_ip_access_list(cloud: &ClickHouseCloudConfig) -> Vec<Value> {
    cloud
        .ip_access_list
        .iter()
        .map(|source| {
            json!({
                "source": source,
                "description": "InstantML API"
            })
        })
        .collect()
}

fn cloud_service_name(org: &OrganizationRow) -> String {
    const WAREHOUSE_LABEL: &str = " - Warehouse ";
    const MAX_SERVICE_NAME: usize = 50;
    let id_suffix = org
        .id
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>();
    let suffix = format!("{WAREHOUSE_LABEL}{id_suffix}");
    let mut stem = org
        .name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == ' ' {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if stem.is_empty() {
        stem = "InstantML".to_string();
    }
    let max_stem = MAX_SERVICE_NAME.saturating_sub(suffix.len());
    stem = stem
        .chars()
        .take(max_stem)
        .collect::<String>()
        .trim()
        .to_string();
    format!("{stem}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenant_database_name_is_clickhouse_identifier_safe() {
        let id = Uuid::parse_str("3e790b99-1150-41f3-9399-c08969f725c2").unwrap();
        assert_eq!(
            tenant_database_name(id),
            "instantml_org_3e790b99115041f39399c08969f725c2"
        );
    }

    #[test]
    fn endpoint_from_service_prefers_https_endpoint() {
        let service = json!({
            "endpoints": [
                {"protocol": "mysql", "host": "mysql.example.com", "port": 9004},
                {"protocol": "https", "host": "ch.example.com", "port": 8443, "username": "default"}
            ]
        });
        assert_eq!(
            endpoint_from_service(&service),
            Some((
                "https://ch.example.com:8443".to_string(),
                "default".to_string()
            ))
        );
    }

    #[test]
    fn organization_id_from_response_accepts_common_shapes() {
        assert_eq!(
            organization_id_from_response(&json!({"result": [{"id": "org-a"}]})),
            Some("org-a".to_string())
        );
        assert_eq!(
            organization_id_from_response(&json!({"result": {"organizations": [{"id": "org-b"}]}})),
            Some("org-b".to_string())
        );
        assert_eq!(
            organization_id_from_response(&json!({"organizations": [{"id": "org-c"}]})),
            Some("org-c".to_string())
        );
    }

    #[test]
    fn cloud_services_from_response_accepts_common_shapes() {
        assert_eq!(
            cloud_services_from_response(&json!({"result": [{"name": "service-a"}]})),
            vec![json!({"name": "service-a"})]
        );
        assert_eq!(
            cloud_services_from_response(&json!({"result": {"services": [{"name": "service-b"}]}})),
            vec![json!({"name": "service-b"})]
        );
        assert_eq!(
            cloud_services_from_response(&json!({"items": [{"name": "service-c"}]})),
            vec![json!({"name": "service-c"})]
        );
    }

    #[test]
    fn cloud_ip_access_list_builds_api_shape() {
        let cloud = ClickHouseCloudConfig {
            endpoint: "https://api.clickhouse.cloud".to_string(),
            key_id: "key".to_string(),
            key_secret: "secret".to_string(),
            organization_id: Some("org".to_string()),
            provider: "gcp".to_string(),
            region: "us-central1".to_string(),
            ip_access_list: vec!["136.115.243.188/32".to_string()],
            min_replica_memory_gb: 12,
            max_replica_memory_gb: 12,
            num_replicas: 1,
            allow_plan_sizing: false,
            wait_timeout: std::time::Duration::from_secs(1),
        };

        assert_eq!(
            cloud_ip_access_list(&cloud),
            vec![json!({"source": "136.115.243.188/32", "description": "InstantML API"})]
        );
    }

    #[test]
    fn cloud_service_name_is_bounded() {
        let org = OrganizationRow {
            id: Uuid::parse_str("3e790b99-1150-41f3-9399-c08969f725c2").unwrap(),
            slug: "very-long-organization-name-with-extra-symbols".to_string(),
            name: "Very Long".to_string(),
            plan_tier: "free".to_string(),
            account_type: "customer".to_string(),
            seat_limit: 1,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "shared".to_string(),
        };
        let name = cloud_service_name(&org);
        assert!(name.len() <= 50);
        assert!(name.ends_with(" - Warehouse 3e790b99"));
        assert!(name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == ' ' || ch == '-'));
    }

    #[test]
    fn cloud_service_name_uses_org_name_warehouse_suffix_with_stable_id() {
        let org = OrganizationRow {
            id: Uuid::parse_str("3e790b99-1150-41f3-9399-c08969f725c2").unwrap(),
            slug: "acme-research".to_string(),
            name: "Acme Research".to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 25,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
        };
        assert_eq!(
            cloud_service_name(&org),
            "Acme Research - Warehouse 3e790b99"
        );
    }

    #[test]
    fn cloud_service_name_avoids_collisions_after_truncation() {
        let first = OrganizationRow {
            id: Uuid::parse_str("3e790b99-1150-41f3-9399-c08969f725c2").unwrap(),
            slug: "long-one".to_string(),
            name: "Acme Research Laboratory With A Very Long Shared Prefix".to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 25,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
        };
        let second = OrganizationRow {
            id: Uuid::parse_str("bbd330da-8ff1-4643-b916-e0fbcbeb1a8f").unwrap(),
            slug: "long-two".to_string(),
            name: first.name.clone(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 25,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
        };
        assert_ne!(cloud_service_name(&first), cloud_service_name(&second));
    }

    #[test]
    fn tenant_route_profile_records_requested_and_operator_applied_capacity() {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "premium-lab".to_string(),
            name: "Premium Lab".to_string(),
            plan_tier: "premium".to_string(),
            account_type: "business".to_string(),
            seat_limit: 10,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
        };
        let cloud = ClickHouseCloudConfig {
            endpoint: "https://api.clickhouse.cloud".to_string(),
            key_id: "key".to_string(),
            key_secret: "secret".to_string(),
            organization_id: Some("org".to_string()),
            provider: "gcp".to_string(),
            region: "us-central1".to_string(),
            ip_access_list: vec!["0.0.0.0/0".to_string()],
            min_replica_memory_gb: 12,
            max_replica_memory_gb: 12,
            num_replicas: 1,
            allow_plan_sizing: false,
            wait_timeout: std::time::Duration::from_secs(1),
        };

        let capped = tenant_route_profile(&org, Some(&cloud));
        assert_eq!(capped.plan_tier, "premium");
        assert_eq!(capped.warehouse_kind, "dedicated");
        assert_eq!(capped.requested_min_replica_memory_gb, 16);
        assert_eq!(capped.requested_num_replicas, 2);
        assert_eq!(capped.applied_min_replica_memory_gb, 12);
        assert_eq!(capped.applied_num_replicas, 1);

        let mut allowed_cloud = cloud;
        allowed_cloud.allow_plan_sizing = true;
        let applied = tenant_route_profile(&org, Some(&allowed_cloud));
        assert_eq!(applied.applied_min_replica_memory_gb, 16);
        assert_eq!(applied.applied_num_replicas, 2);
    }

    #[test]
    fn shared_cell_org_id_sentinel_is_distinct_from_any_v4_uuid() {
        // The sentinel UUID must not collide with a randomly generated org_id.
        // It is the all-ones UUID (max value) so it is easy to reason about.
        let sentinel = SHARED_CELL_ORG_ID;
        assert_eq!(sentinel.to_string(), "ffffffff-ffff-ffff-ffff-ffffffffffff");
        // Real orgs use UUID v4 which will never be all-ones.
        let random_org = Uuid::new_v4();
        assert_ne!(random_org, sentinel);
    }

    #[test]
    fn shared_cell_provisioner_name_is_stable() {
        // The provisioner name stored in operational records must be stable so
        // that existing shared-cell routes survive a server restart.
        assert_eq!(SHARED_CELL_PROVISIONER, "shared-cell");
    }

    #[test]
    fn shared_cell_org_routes_to_shared_tier() {
        // An org with tenant_routing_tier="shared" must be identified as
        // personal, not dedicated.
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "free-user-lab".to_string(),
            name: "Free User Lab".to_string(),
            plan_tier: "free".to_string(),
            account_type: "personal".to_string(),
            seat_limit: 2,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "shared".to_string(),
        };
        assert_eq!(org.tenant_routing_tier, "shared");
        assert!(is_personal_account_type(&org.account_type));
    }

    #[test]
    fn business_org_routes_to_dedicated_tier() {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "enterprise-corp".to_string(),
            name: "Enterprise Corp".to_string(),
            plan_tier: "pro".to_string(),
            account_type: "business".to_string(),
            seat_limit: 3,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
        };
        assert_eq!(org.tenant_routing_tier, "dedicated");
        assert!(!is_personal_account_type(&org.account_type));
    }
}
