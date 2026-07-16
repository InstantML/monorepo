use super::*;
use crate::{
    config::{ByocClickHouseConfig, ClickHouseCloudConfig, ClickHouseProvisioner},
    metric_store::{
        self, connect_connection, migrate_existing_database, parse_clickhouse_url,
        validate_clickhouse_identifier, ClickHouseConnection, METRIC_SCHEMA_VERSION,
    },
    secret_store::{
        destroy_byoc_clickhouse_password_version, read_byoc_clickhouse_password,
        store_byoc_clickhouse_password,
    },
};
use std::net::IpAddr;
use url::Url;

pub(super) const TENANT_ROUTE_KIND: &str = "tenant_route";

fn default_route_version() -> i64 {
    1
}

/// The set of record kinds that belong to the control plane (as opposed to
/// tenant-owned run data). Used both to gate ClickHouse control-log writes and
/// to route writes/rebuild through Postgres. Single source of truth so the two
/// paths can never drift.
pub(super) fn is_control_kind(kind: &str) -> bool {
    matches!(
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
            | "embed_session"
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
const TENANT_ROUTE_READY: &str = "ready";
const TENANT_ROUTE_PROVISIONING: &str = "provisioning";
const TENANT_ROUTE_FAILED: &str = "failed";
const CUSTOMER_CLICKHOUSE_PROVISIONER: &str = "customer-clickhouse";
const CUSTOMER_CLICKHOUSE_WAREHOUSE_KIND: &str = "customer-owned";
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
    pub cell_id: Option<String>,
    #[serde(default = "default_route_version")]
    pub route_version: i64,
    #[serde(default)]
    pub placement_reason: Option<String>,
    #[serde(default)]
    pub assigned_at: Option<DateTime<Utc>>,
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
    #[serde(default)]
    pub schema_version: Option<u32>,
    pub service_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub error: Option<String>,
}

impl Store {
    pub(super) fn hosted_clickhouse_enabled(&self) -> bool {
        self.hosted_clickhouse.is_some()
    }

    pub async fn ensure_tenant_loaded(&self, org_id: Uuid) -> AppResult<()> {
        if !self.hosted_clickhouse_enabled() {
            return Ok(());
        }
        if self.tenant_loaded.lock().await.contains(&org_id) {
            return Ok(());
        }
        let (org, route) = {
            let data = self.data.lock().await;
            (
                data.organizations.get(&org_id).cloned(),
                data.tenant_routes.get(&org_id).cloned(),
            )
        };
        if let Some(org) = org.as_ref() {
            require_org_storage_ready(org)?;
        }
        let route = route.ok_or_else(|| tenant_unavailable("tenant route is not provisioned"))?;

        if route.status != TENANT_ROUTE_READY {
            return Err(tenant_unavailable(
                route
                    .error
                    .as_deref()
                    .unwrap_or("tenant route is not ready"),
            ));
        }

        let metric_store = self.metric_store_from_route(&route).await?;
        self.persist_upgraded_route_schema_version_if_needed(&route)
            .await?;
        let records = metric_store
            .load_operational_records_for_org(org_id)
            .await?;
        let stats = {
            let mut data = self.data.lock().await;
            data.apply_operational_records(records, ReplayScope::Tenant(org_id))?
        };
        self.tenant_metric_stores
            .lock()
            .await
            .insert(org_id, metric_store);
        self.cache_customer_route_endpoint_if_needed(org_id, &route)
            .await;
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
        self.ensure_cached_customer_route_endpoint_safe(org_id)
            .await?;
        if let Some(metric_store) = self.tenant_metric_stores.lock().await.get(&org_id).cloned() {
            return Ok(metric_store);
        }
        // Shared-cell orgs never get a per-org tenant metric store entry.
        if self.org_uses_shared_cell(org_id).await {
            return self
                .shared_cell_metric_store
                .clone()
                .ok_or_else(|| tenant_unavailable("shared cell is not configured"));
        }
        Err(tenant_unavailable("tenant route is not loaded"))
    }

    async fn ensure_cached_customer_route_endpoint_safe(&self, org_id: Uuid) -> AppResult<()> {
        let endpoint = self
            .customer_tenant_endpoints
            .lock()
            .await
            .get(&org_id)
            .cloned();
        if let Some(endpoint) = endpoint {
            ensure_customer_endpoint_safe(&endpoint, &self.byoc_clickhouse).await?;
        }
        Ok(())
    }

    async fn cache_customer_route_endpoint_if_needed(
        &self,
        org_id: Uuid,
        route: &TenantRouteRecord,
    ) {
        let mut endpoints = self.customer_tenant_endpoints.lock().await;
        if route.provisioner == CUSTOMER_CLICKHOUSE_PROVISIONER {
            endpoints.insert(org_id, route.endpoint.clone());
        } else {
            endpoints.remove(&org_id);
        }
    }

    /// Returns true when the org's routing tier is "shared" and a shared-cell
    /// MetricStore is configured. In local/non-hosted mode always returns false.
    pub(super) async fn org_uses_shared_cell(&self, org_id: Uuid) -> bool {
        let data = self.data.lock().await;
        data.organizations.get(&org_id).is_some_and(|org| {
            org_should_use_shared_cell(
                org,
                data.tenant_routes.get(&org_id),
                self.shared_cell_metric_store.is_some(),
            )
        })
    }

    pub(super) async fn warehouse_storage_bytes_for_org(
        &self,
        org_id: Uuid,
    ) -> AppResult<Option<i64>> {
        if self.org_uses_customer_clickhouse(org_id).await {
            return Ok(None);
        }
        if self.hosted_clickhouse_enabled() && self.org_uses_shared_cell(org_id).await {
            return Ok(None);
        }
        self.metric_store_for_org(org_id)
            .await?
            .count_database_storage_bytes()
            .await
            .map(Some)
    }

    pub(super) async fn org_uses_customer_clickhouse(&self, org_id: Uuid) -> bool {
        let data = self.data.lock().await;
        data.organizations.get(&org_id).is_some_and(|org| {
            org.storage_choice == STORAGE_CHOICE_CUSTOMER_CLICKHOUSE
                || data
                    .tenant_routes
                    .get(&org_id)
                    .is_some_and(|route| route.provisioner == CUSTOMER_CLICKHOUSE_PROVISIONER)
        })
    }

    pub(super) async fn ensure_tenant_route(
        &self,
        org: &OrganizationRow,
    ) -> AppResult<TenantRouteRecord> {
        if !self.hosted_clickhouse_enabled() {
            return Ok(local_route(org));
        }
        require_org_storage_ready(org)?;

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

        // Personal/free orgs route to the shared cell when one is configured.
        // Otherwise, fall through to the dedicated path so staging and preview
        // deploys do not strand new orgs on a missing shared cell. A ready
        // route checked above is sticky, so enabling a shared cell later does
        // not hide data already written to a dedicated fallback warehouse.
        if should_route_to_shared_cell(org, self.shared_cell_metric_store.is_some()) {
            return self.ensure_shared_cell_route(org).await;
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
                cell_id: None,
                route_version: 1,
                placement_reason: None,
                assigned_at: None,
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
                schema_version: None,
                service_id: None,
                created_at: now,
                updated_at: now,
                error: None,
            },
            profile,
        );
        self.persist_tenant_route(provisioning).await?;

        match self.provision_tenant_route(org).await {
            Ok(route) => {
                let route = self.persist_tenant_route(route).await?;
                let metric_store = self.metric_store_from_route(&route).await?;
                self.tenant_metric_stores
                    .lock()
                    .await
                    .insert(org.id, metric_store);
                self.cache_customer_route_endpoint_if_needed(org.id, &route)
                    .await;
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
                                cell_id: None,
                                route_version: 1,
                                placement_reason: None,
                                assigned_at: None,
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
                                schema_version: None,
                                service_id: None,
                                created_at: now,
                                updated_at: Utc::now(),
                                error: Some(error.message().to_string()),
                            },
                            profile,
                        )
                    });
                self.persist_tenant_route(failed).await?;
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
        // If we already have a ready route for this org, return it. A shared
        // org may have a dedicated fallback route from a staging/preview period
        // before a shared cell was configured.
        let existing = {
            let data = self.data.lock().await;
            data.tenant_routes.get(&org.id).cloned()
        };
        if let Some(route) = existing {
            if route.status == TENANT_ROUTE_READY {
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
            cell_id: None,
            route_version: 1,
            placement_reason: None,
            assigned_at: None,
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
            schema_version: Some(METRIC_SCHEMA_VERSION),
            service_id: None,
            created_at: now,
            updated_at: now,
            error: None,
        };
        let route = self.persist_tenant_route(route).await?;
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
                cell_id: None,
                route_version: 1,
                placement_reason: None,
                assigned_at: None,
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
                schema_version: Some(METRIC_SCHEMA_VERSION),
                service_id: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                error: None,
            },
            profile,
        ))
    }

    async fn persist_tenant_route(&self, route: TenantRouteRecord) -> AppResult<TenantRouteRecord> {
        if let Some(control_db) = &self.control_db {
            let placement = self.current_cell_placement();
            if placement.is_some() {
                self.refresh_current_data_cell_registration(control_db)
                    .await?;
            }
            let stored = control_db
                .upsert_tenant_route_with_placement(&route, placement.as_ref())
                .await?;
            self.data.lock().await.insert_tenant_route(stored.clone());
            return Ok(stored);
        }
        self.persist_locked(
            TENANT_ROUTE_KIND,
            route.org_id,
            &route.org_id.to_string(),
            &route,
        )
        .await?;
        self.data.lock().await.insert_tenant_route(route.clone());
        Ok(route)
    }

    fn current_cell_placement(&self) -> Option<TenantRoutePlacement> {
        self.cell_routing
            .placement_data_cell_id
            .as_ref()
            .map(|cell_id| TenantRoutePlacement {
                environment: self.cell_routing.environment.clone(),
                cell_id: cell_id.clone(),
                actor: "system".to_string(),
                reason: "current_data_cell".to_string(),
            })
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
        ready.schema_version = Some(METRIC_SCHEMA_VERSION);
        ready.updated_at = Utc::now();
        ready.error = None;
        let ready = self.persist_tenant_route(ready).await?;
        self.tenant_metric_stores
            .lock()
            .await
            .insert(route.org_id, metric_store);
        self.cache_customer_route_endpoint_if_needed(route.org_id, &ready)
            .await;
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
                cell_id: None,
                route_version: 1,
                placement_reason: None,
                assigned_at: None,
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
                schema_version: None,
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
        let endpoint = if route.provisioner == CUSTOMER_CLICKHOUSE_PROVISIONER {
            ensure_customer_route_endpoint_safe(route, &self.byoc_clickhouse).await?
        } else {
            route.endpoint.clone()
        };
        let password = self.tenant_password(route).await?;
        let connection = ClickHouseConnection {
            endpoint,
            username: route.username.clone(),
            password,
            database: route.database.clone(),
        };
        let metric_store = connect_connection(&connection)?;
        if route.provisioner == CUSTOMER_CLICKHOUSE_PROVISIONER {
            if route.schema_version.unwrap_or_default() < METRIC_SCHEMA_VERSION {
                migrate_existing_database(&metric_store).await?;
            }
        } else {
            metric_store::migrate(&metric_store).await?;
        }
        Ok(metric_store)
    }

    async fn persist_upgraded_route_schema_version_if_needed(
        &self,
        route: &TenantRouteRecord,
    ) -> AppResult<()> {
        if route.schema_version.unwrap_or_default() >= METRIC_SCHEMA_VERSION {
            return Ok(());
        }
        let mut upgraded = route.clone();
        upgraded.schema_version = Some(METRIC_SCHEMA_VERSION);
        upgraded.updated_at = Utc::now();
        self.persist_tenant_route(upgraded).await.map(|_| ())
    }

    async fn tenant_password(&self, route: &TenantRouteRecord) -> AppResult<String> {
        if route.provisioner == CUSTOMER_CLICKHOUSE_PROVISIONER {
            return read_byoc_clickhouse_password(
                &self.byoc_clickhouse.credential_store,
                route.password_secret_ref.as_deref(),
                route.password_ciphertext.as_deref(),
            )
            .await;
        }
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

    pub async fn customer_clickhouse_status(
        &self,
        org_id: Uuid,
        config: &ByocClickHouseConfig,
    ) -> AppResult<ClickHouseConnectionStatus> {
        let data = self.data.lock().await;
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        let route = data.tenant_routes.get(&org_id).cloned();
        Ok(connection_status_payload(
            &org,
            route.as_ref(),
            config,
            None,
        ))
    }

    pub async fn validate_customer_clickhouse(
        &self,
        input: ClickHouseConnectionValidateRequest,
        config: &ByocClickHouseConfig,
    ) -> AppResult<ClickHouseConnectionValidationResponse> {
        config.require_customer_setup_enabled()?;
        let org_id = input
            .org_id
            .ok_or_else(|| AppError::validation("org_id is required"))?;
        ensure_billing_write_allowed(self, org_id, "configure customer ClickHouse").await?;
        let connection = customer_connection_from_input(
            input.endpoint.as_deref(),
            input.database.as_deref(),
            input.username.as_deref(),
            input.password.as_deref(),
            config,
        )
        .await?;
        if input.allow_create_database.unwrap_or(false) {
            return Err(AppError::validation(
                "customer-owned ClickHouse databases must be pre-created in this slice",
            ));
        }
        self.validate_customer_org_for_setup(org_id, false).await?;
        let mut response = validate_customer_connection_ready(&connection, org_id).await?;
        response.required_egress_cidrs = config.egress_cidrs.clone();
        response.egress_set_version = config.egress_set_version.clone();
        Ok(response)
    }

    pub async fn create_customer_clickhouse_route(
        &self,
        input: ClickHouseConnectionCreateRequest,
        config: &ByocClickHouseConfig,
    ) -> AppResult<ClickHouseConnectionStatus> {
        config.require_customer_setup_enabled()?;
        let org_id = input
            .org_id
            .ok_or_else(|| AppError::validation("org_id is required"))?;
        ensure_billing_write_allowed(self, org_id, "configure customer ClickHouse").await?;
        let connection = customer_connection_from_input(
            input.endpoint.as_deref(),
            input.database.as_deref(),
            input.username.as_deref(),
            input.password.as_deref(),
            config,
        )
        .await?;
        self.validate_customer_org_for_setup(org_id, false).await?;
        validate_customer_connection_ready(&connection, org_id).await?;
        let metric_store = connect_connection(&connection)?;
        migrate_existing_database(&metric_store).await?;
        insert_validation_record(&metric_store, org_id).await?;
        let stored_secret =
            store_byoc_clickhouse_password(&config.credential_store, org_id, &connection.password)
                .await?;

        let now = Utc::now();
        let route = TenantRouteRecord {
            org_id,
            status: TENANT_ROUTE_READY.to_string(),
            provisioner: CUSTOMER_CLICKHOUSE_PROVISIONER.to_string(),
            cell_id: None,
            route_version: 1,
            placement_reason: None,
            assigned_at: None,
            plan_tier: None,
            warehouse_kind: Some(CUSTOMER_CLICKHOUSE_WAREHOUSE_KIND.to_string()),
            requested_min_replica_memory_gb: None,
            requested_max_replica_memory_gb: None,
            requested_num_replicas: None,
            applied_min_replica_memory_gb: None,
            applied_max_replica_memory_gb: None,
            applied_num_replicas: None,
            endpoint: connection.endpoint.clone(),
            database: connection.database.clone(),
            username: connection.username.clone(),
            password_secret_ref: Some(stored_secret.secret_ref),
            password_ciphertext: stored_secret.local_ciphertext,
            schema_version: Some(METRIC_SCHEMA_VERSION),
            service_id: None,
            created_at: now,
            updated_at: now,
            error: None,
        };

        let mut data = self.data.lock().await;
        let mut org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        ensure_empty_org_data(&data, org_id)?;
        org.storage_choice = STORAGE_CHOICE_CUSTOMER_CLICKHOUSE.to_string();
        org.storage_state = STORAGE_STATE_READY.to_string();
        org.tenant_routing_tier = CUSTOMER_CLICKHOUSE_PROVISIONER.to_string();
        self.persist_locked("organization", org.id, &org.id.to_string(), &org)
            .await?;
        data.insert_org(org.clone());
        drop(data);
        let route = self.persist_tenant_route(route).await?;
        self.tenant_metric_stores
            .lock()
            .await
            .insert(org_id, metric_store);
        self.cache_customer_route_endpoint_if_needed(org_id, &route)
            .await;
        self.tenant_loaded.lock().await.insert(org_id);
        Ok(connection_status_payload(&org, Some(&route), config, None))
    }

    pub(crate) fn require_customer_clickhouse_signup_ready(&self) -> AppResult<()> {
        self.byoc_clickhouse.require_customer_setup_enabled()
    }

    pub async fn rotate_customer_clickhouse_credentials(
        &self,
        input: ClickHouseConnectionRotateCredentialsRequest,
        config: &ByocClickHouseConfig,
    ) -> AppResult<ClickHouseConnectionStatus> {
        config.require_customer_setup_enabled()?;
        let org_id = input
            .org_id
            .ok_or_else(|| AppError::validation("org_id is required"))?;
        ensure_billing_write_allowed(self, org_id, "configure customer ClickHouse").await?;
        let (org, mut route) = {
            let data = self.data.lock().await;
            let org = data
                .organizations
                .get(&org_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("organization not found"))?;
            let route = data
                .tenant_routes
                .get(&org_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("customer ClickHouse route not found"))?;
            (org, route)
        };
        if route.provisioner != CUSTOMER_CLICKHOUSE_PROVISIONER {
            return Err(AppError::with_code(
                axum::http::StatusCode::CONFLICT,
                "tenant_route_locked",
                "organization is not using customer-owned ClickHouse",
            ));
        }
        require_org_storage_ready(&org)?;
        let username = input
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(route.username.as_str())
            .to_string();
        let password = input
            .password
            .as_deref()
            .ok_or_else(|| AppError::validation("password is required"))?;
        let connection = ClickHouseConnection {
            endpoint: ensure_customer_route_endpoint_safe(&route, config).await?,
            username,
            password: password.to_string(),
            database: route.database.clone(),
        };
        validate_customer_runtime_ready(&connection, org_id).await?;
        let metric_store = connect_connection(&connection)?;
        let stored_secret =
            store_byoc_clickhouse_password(&config.credential_store, org_id, &connection.password)
                .await?;
        let old_secret_ref = route.password_secret_ref.clone();
        route.username = connection.username;
        route.password_secret_ref = Some(stored_secret.secret_ref);
        route.password_ciphertext = stored_secret.local_ciphertext;
        route.updated_at = Utc::now();
        route.error = None;
        let route = self.persist_tenant_route(route).await?;
        self.tenant_metric_stores
            .lock()
            .await
            .insert(org_id, metric_store);
        self.cache_customer_route_endpoint_if_needed(org_id, &route)
            .await;
        self.tenant_loaded.lock().await.insert(org_id);
        if let Err(error) = destroy_byoc_clickhouse_password_version(
            &config.credential_store,
            old_secret_ref.as_deref(),
        )
        .await
        {
            tracing::warn!(
                workflow = "byoc_clickhouse",
                operation = "destroy_old_secret_version",
                outcome = "failure",
                org_id = %org_id,
                status = error.status().as_u16(),
                code = error.safe_code(),
                error_kind = error.safe_code(),
                retryable = error.retryable(),
                safe_summary = error.safe_summary(),
                "failed to destroy previous BYOC ClickHouse credential version after rotation"
            );
        }
        Ok(connection_status_payload(&org, Some(&route), config, None))
    }

    async fn validate_customer_org_for_setup(
        &self,
        org_id: Uuid,
        commit: bool,
    ) -> AppResult<OrganizationRow> {
        let mut data = self.data.lock().await;
        let mut org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        if org.plan_tier != "premium" {
            return Err(AppError::forbidden(
                "customer-owned ClickHouse is available for Premium workspaces",
            ));
        }
        if org.storage_choice != STORAGE_CHOICE_CUSTOMER_CLICKHOUSE
            && org.storage_state != STORAGE_STATE_UNCONFIGURED
        {
            return Err(AppError::with_code(
                axum::http::StatusCode::CONFLICT,
                "tenant_route_locked",
                "storage route is already configured",
            ));
        }
        ensure_empty_org_data(&data, org_id)?;
        if commit {
            org.storage_choice = STORAGE_CHOICE_CUSTOMER_CLICKHOUSE.to_string();
            org.storage_state = STORAGE_STATE_VALIDATING.to_string();
            self.persist_locked("organization", org.id, &org.id.to_string(), &org)
                .await?;
            data.insert_org(org.clone());
        }
        Ok(org)
    }
}

async fn customer_connection_from_input(
    endpoint: Option<&str>,
    database: Option<&str>,
    username: Option<&str>,
    password: Option<&str>,
    config: &ByocClickHouseConfig,
) -> AppResult<ClickHouseConnection> {
    let endpoint = normalize_customer_endpoint(endpoint, config).await?;
    let database = database
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation("database is required"))?;
    validate_clickhouse_identifier(database, "database")?;
    let username = username
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation("username is required"))?;
    let password = password.ok_or_else(|| AppError::validation("password is required"))?;
    Ok(ClickHouseConnection {
        endpoint,
        username: username.to_string(),
        password: password.to_string(),
        database: database.to_string(),
    })
}

async fn normalize_customer_endpoint(
    raw: Option<&str>,
    config: &ByocClickHouseConfig,
) -> AppResult<String> {
    let raw = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation("endpoint is required"))?;
    let parsed = Url::parse(raw)
        .map_err(|err| AppError::validation(format!("endpoint is not a valid URL: {err}")))?;
    if parsed.scheme() != "https" && !config.allow_private_endpoints {
        return Err(AppError::with_code(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_clickhouse_connection",
            "customer-owned ClickHouse endpoint must use https",
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(AppError::with_code(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_clickhouse_connection",
            "endpoint must be an origin like https://host:8443",
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::validation("endpoint must include a host"))?;
    let port = parsed.port().unwrap_or(if parsed.scheme() == "https" {
        8443
    } else {
        8123
    });
    if !config.allow_private_endpoints {
        reject_private_endpoint(host, port).await?;
    }
    Ok(format!("{}://{}:{}", parsed.scheme(), host, port))
}

async fn ensure_customer_route_endpoint_safe(
    route: &TenantRouteRecord,
    config: &ByocClickHouseConfig,
) -> AppResult<String> {
    ensure_customer_endpoint_safe(&route.endpoint, config).await
}

async fn ensure_customer_endpoint_safe(
    endpoint: &str,
    config: &ByocClickHouseConfig,
) -> AppResult<String> {
    let normalized = normalize_customer_endpoint(Some(endpoint), config).await?;
    if normalized != endpoint {
        return Err(AppError::with_code(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_clickhouse_connection",
            "stored customer-owned ClickHouse endpoint is not normalized",
        ));
    }
    Ok(normalized)
}

async fn reject_private_endpoint(host: &str, port: u16) -> AppResult<()> {
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| {
            AppError::warehouse_unavailable("customer ClickHouse host could not be resolved")
        })?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(AppError::warehouse_unavailable(
            "customer ClickHouse host resolved no addresses",
        ));
    }
    if addrs.iter().any(|addr| private_or_reserved_ip(addr.ip())) {
        return Err(AppError::with_code(
            axum::http::StatusCode::BAD_REQUEST,
            "unsafe_clickhouse_host",
            "customer ClickHouse endpoint resolves to a private or reserved address",
        ));
    }
    Ok(())
}

fn private_or_reserved_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 224
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return private_or_reserved_ip(IpAddr::V4(mapped));
            }
            let first = ip.segments()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80
                || first & 0xff00 == 0xff00
        }
    }
}

async fn validate_customer_connection_ready(
    connection: &ClickHouseConnection,
    org_id: Uuid,
) -> AppResult<ClickHouseConnectionValidationResponse> {
    let metric_store = connect_connection(connection)?;
    migrate_existing_database(&metric_store).await?;
    insert_validation_record(&metric_store, org_id).await?;
    let server_version = metric_store
        .client()
        .query("SELECT version()")
        .fetch_optional::<String>()
        .await
        .ok()
        .flatten();
    let current_user = metric_store
        .client()
        .query("SELECT currentUser()")
        .fetch_optional::<String>()
        .await
        .ok()
        .flatten();
    Ok(ClickHouseConnectionValidationResponse {
        status: "valid".to_string(),
        server_version,
        current_user,
        database: connection.database.clone(),
        required_egress_cidrs: Vec::new(),
        egress_description: "InstantML Rust API/data-plane outbound IPs".to_string(),
        egress_set_version: "unknown".to_string(),
        can_create_database: false,
        can_migrate_schema: true,
        can_insert_validation_record: true,
    })
}

async fn validate_customer_runtime_ready(
    connection: &ClickHouseConnection,
    org_id: Uuid,
) -> AppResult<()> {
    let metric_store = connect_connection(connection)?;
    insert_validation_record(&metric_store, org_id).await
}

async fn insert_validation_record(metric_store: &MetricStore, org_id: Uuid) -> AppResult<()> {
    metric_store
        .insert_operational_record(&OperationalRecordRow {
            kind: "byoc_validation".to_string(),
            org_id,
            entity_id: Uuid::new_v4().to_string(),
            payload: json!({
                "kind": "byoc_validation",
                "created_at": Utc::now()
            })
            .to_string(),
            created_at: Utc::now(),
        })
        .await
}

fn ensure_empty_org_data(data: &StoreData, org_id: Uuid) -> AppResult<()> {
    let has_product_data = data.projects.values().any(|row| row.org_id == org_id)
        || data.runs.values().any(|row| row.org_id == org_id)
        || data.artifacts.values().any(|row| row.org_id == org_id)
        || data.imports.values().any(|row| row.org_id == org_id)
        || data
            .tenant_routes
            .get(&org_id)
            .is_some_and(|route| route.status == TENANT_ROUTE_READY);
    if has_product_data {
        Err(AppError::with_code(
            axum::http::StatusCode::CONFLICT,
            "tenant_route_locked",
            "storage route cannot be changed after product data exists",
        ))
    } else {
        Ok(())
    }
}

fn connection_status_payload(
    org: &OrganizationRow,
    route: Option<&TenantRouteRecord>,
    config: &ByocClickHouseConfig,
    message: Option<String>,
) -> ClickHouseConnectionStatus {
    let endpoint = route.map(|route| route.endpoint.clone());
    let endpoint_host = endpoint
        .as_deref()
        .and_then(|value| Url::parse(value).ok())
        .and_then(|url| url.host_str().map(str::to_string));
    ClickHouseConnectionStatus {
        status: route
            .map(|route| route.status.clone())
            .unwrap_or_else(|| org.storage_state.clone()),
        storage_choice: org.storage_choice.clone(),
        storage_state: org.storage_state.clone(),
        provisioner: route.map(|route| route.provisioner.clone()),
        warehouse_kind: route.and_then(|route| route.warehouse_kind.clone()),
        endpoint,
        endpoint_host,
        database: route.map(|route| route.database.clone()),
        username: route.map(|route| route.username.clone()),
        required_egress_cidrs: config.egress_cidrs.clone(),
        egress_description: "InstantML Rust API/data-plane outbound IPs".to_string(),
        egress_set_version: config.egress_set_version.clone(),
        last_validated_at: route.map(|route| route.updated_at),
        validation_error_code: route.and_then(|route| route.error.clone()),
        message,
    }
}

fn tenant_database_name(org_id: Uuid) -> String {
    format!("instantml_org_{}", org_id.simple())
}

fn tenant_unavailable(message: impl Into<String>) -> AppError {
    AppError::warehouse_unavailable(message)
}

fn should_route_to_shared_cell(org: &OrganizationRow, shared_cell_configured: bool) -> bool {
    org.tenant_routing_tier == "shared" && shared_cell_configured
}

fn org_should_use_shared_cell(
    org: &OrganizationRow,
    existing_route: Option<&TenantRouteRecord>,
    shared_cell_configured: bool,
) -> bool {
    if let Some(route) = existing_route {
        if route.status == TENANT_ROUTE_READY {
            return route.provisioner == SHARED_CELL_PROVISIONER;
        }
    }
    should_route_to_shared_cell(org, shared_cell_configured)
}

fn local_route(org: &OrganizationRow) -> TenantRouteRecord {
    with_profile(
        TenantRouteRecord {
            org_id: org.id,
            status: TENANT_ROUTE_READY.to_string(),
            provisioner: "local".to_string(),
            cell_id: None,
            route_version: 1,
            placement_reason: None,
            assigned_at: None,
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
            schema_version: None,
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
    use crate::config::{ByocCredentialStoreConfig, HostedClickHouseConfig};
    use std::{
        collections::{BTreeSet, HashMap},
        sync::Arc,
    };
    use tokio::sync::Mutex;

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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        assert_eq!(org.tenant_routing_tier, "shared");
        assert!(is_personal_account_type(&org.account_type));
        assert!(should_route_to_shared_cell(&org, true));
        assert!(!should_route_to_shared_cell(&org, false));
    }

    #[test]
    fn shared_tier_org_keeps_ready_dedicated_fallback_route() {
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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        let route = local_route(&org);

        assert!(!org_should_use_shared_cell(&org, Some(&route), true));
        assert!(org_should_use_shared_cell(&org, None, true));
    }

    #[tokio::test]
    async fn warehouse_storage_bytes_do_not_count_shared_or_customer_databases_as_org_exact() {
        let shared_org_id = Uuid::from_u128(0x51_00);
        let customer_org_id = Uuid::from_u128(0xC0_00);
        let mut data = StoreData::default();
        data.insert_org(test_org(
            shared_org_id,
            "shared-org",
            "personal",
            "shared",
            STORAGE_CHOICE_HOSTED,
        ));
        data.insert_tenant_route(test_route(
            shared_org_id,
            SHARED_CELL_PROVISIONER,
            "instantml_shared",
        ));
        data.insert_org(test_org(
            customer_org_id,
            "customer-org",
            "customer",
            CUSTOMER_CLICKHOUSE_PROVISIONER,
            STORAGE_CHOICE_CUSTOMER_CLICKHOUSE,
        ));
        data.insert_tenant_route(test_route(
            customer_org_id,
            CUSTOMER_CLICKHOUSE_PROVISIONER,
            "customer_db",
        ));
        let store = test_hosted_store(data, true);

        assert_eq!(
            store
                .warehouse_storage_bytes_for_org(shared_org_id)
                .await
                .unwrap(),
            None,
            "a shared-cell database may contain many orgs, so database-wide bytes are not org-exact"
        );
        assert_eq!(
            store
                .warehouse_storage_bytes_for_org(customer_org_id)
                .await
                .unwrap(),
            None,
            "customer-owned ClickHouse storage should not count warehouse bytes against InstantML-hosted storage"
        );
    }

    #[tokio::test]
    async fn cached_customer_routes_recheck_endpoint_safety() {
        let customer_org_id = Uuid::from_u128(0xC0_01);
        let mut data = StoreData::default();
        data.insert_org(test_org(
            customer_org_id,
            "customer-org",
            "customer",
            CUSTOMER_CLICKHOUSE_PROVISIONER,
            STORAGE_CHOICE_CUSTOMER_CLICKHOUSE,
        ));
        let mut route = test_route(
            customer_org_id,
            CUSTOMER_CLICKHOUSE_PROVISIONER,
            "customer_db",
        );
        route.endpoint = "https://127.0.0.1:8443".to_string();
        data.insert_tenant_route(route.clone());
        let mut store = test_hosted_store(data, false);
        store.byoc_clickhouse.allow_private_endpoints = false;
        store.byoc_clickhouse.egress_cidrs = vec!["203.0.113.10/32".to_string()];
        store.byoc_clickhouse.egress_set_version = "prod-us-central1-test".to_string();
        store
            .customer_tenant_endpoints
            .lock()
            .await
            .insert(customer_org_id, route.endpoint);

        let error = store
            .ensure_cached_customer_route_endpoint_safe(customer_org_id)
            .await
            .unwrap_err();
        assert_eq!(error.code(), Some("unsafe_clickhouse_host"));
    }

    #[test]
    fn private_or_reserved_ip_rejects_ipv4_mapped_ipv6_targets() {
        for raw in [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
        ] {
            let ip = raw.parse::<IpAddr>().unwrap();
            assert!(private_or_reserved_ip(ip), "{raw}");
        }
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
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        assert_eq!(org.tenant_routing_tier, "dedicated");
        assert!(!is_personal_account_type(&org.account_type));
        assert!(!should_route_to_shared_cell(&org, true));
    }

    fn test_hosted_store(data: StoreData, shared_cell_enabled: bool) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_test_primary",
                "TEST_CLICKHOUSE_URL",
            )
            .unwrap(),
            control_db: None,
            hosted_clickhouse: Some(HostedClickHouseConfig {
                tenant_base_url: "http://default:@127.0.0.1:8123/instantml_tenant_base_test"
                    .to_string(),
                provisioner: ClickHouseProvisioner::Database,
                allow_stored_tenant_passwords: false,
                cloud: None,
                shared_cell_url: shared_cell_enabled
                    .then(|| "http://default:@127.0.0.1:8123/instantml_shared_test".to_string()),
            }),
            byoc_clickhouse: ByocClickHouseConfig {
                egress_cidrs: Vec::new(),
                egress_set_version: "test".to_string(),
                allow_private_endpoints: true,
                credential_store: ByocCredentialStoreConfig::LocalUserData,
            },
            cell_routing: CellRoutingConfig {
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
            shared_cell_metric_store: shared_cell_enabled.then(|| {
                crate::metric_store::connect_url(
                    "http://default:@127.0.0.1:8123/instantml_shared_test",
                    "TEST_SHARED_CLICKHOUSE_URL",
                )
                .unwrap()
            }),
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

    fn test_org(
        org_id: Uuid,
        slug: &str,
        account_type: &str,
        tenant_routing_tier: &str,
        storage_choice: &str,
    ) -> OrganizationRow {
        OrganizationRow {
            id: org_id,
            slug: slug.to_string(),
            name: slug.to_string(),
            plan_tier: "premium".to_string(),
            account_type: account_type.to_string(),
            seat_limit: 10,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: tenant_routing_tier.to_string(),
            storage_choice: storage_choice.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        }
    }

    fn test_route(org_id: Uuid, provisioner: &str, database: &str) -> TenantRouteRecord {
        let now = Utc::now();
        TenantRouteRecord {
            org_id,
            status: TENANT_ROUTE_READY.to_string(),
            provisioner: provisioner.to_string(),
            cell_id: None,
            route_version: 1,
            placement_reason: None,
            assigned_at: None,
            plan_tier: Some("premium".to_string()),
            warehouse_kind: Some("test".to_string()),
            requested_min_replica_memory_gb: None,
            requested_max_replica_memory_gb: None,
            requested_num_replicas: None,
            applied_min_replica_memory_gb: None,
            applied_max_replica_memory_gb: None,
            applied_num_replicas: None,
            endpoint: "http://127.0.0.1:8123".to_string(),
            database: database.to_string(),
            username: "default".to_string(),
            password_secret_ref: Some(TENANT_BASE_PASSWORD_REF.to_string()),
            password_ciphertext: None,
            schema_version: Some(METRIC_SCHEMA_VERSION),
            service_id: None,
            created_at: now,
            updated_at: now,
            error: None,
        }
    }

    #[tokio::test]
    async fn customer_clickhouse_setup_respects_billing_gate() {
        let user_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        let mut org = test_org(
            org_id,
            "checkout-pending-byoc",
            "business",
            "customer-clickhouse",
            STORAGE_CHOICE_CUSTOMER_CLICKHOUSE,
        );
        org.created_by_user_id = Some(user_id);
        org.storage_state = STORAGE_STATE_UNCONFIGURED.to_string();
        let mut data = StoreData::default();
        data.insert_org(org.clone());
        data.insert_billing_account(BillingAccountProjection {
            schema_version: 1,
            org_id,
            access_state: BILLING_CHECKOUT_PENDING.to_string(),
            plan_tier: "premium".to_string(),
            effective_plan_tier: "free".to_string(),
            requested_plan_tier: Some("premium".to_string()),
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
        let store = test_hosted_store(data, false);

        let error = store
            .validate_customer_clickhouse(
                ClickHouseConnectionValidateRequest {
                    org_id: Some(org_id),
                    endpoint: Some("http://127.0.0.1:8123".to_string()),
                    database: Some("instantml_byoc_test".to_string()),
                    username: Some("default".to_string()),
                    password: Some("password".to_string()),
                    storage_choice: Some(STORAGE_CHOICE_CUSTOMER_CLICKHOUSE.to_string()),
                    allow_create_database: Some(false),
                },
                &store.byoc_clickhouse,
            )
            .await
            .unwrap_err();

        assert_eq!(error.status(), axum::http::StatusCode::PAYMENT_REQUIRED);
        assert!(!store.data.lock().await.tenant_routes.contains_key(&org_id));
    }
}
