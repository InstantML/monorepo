use axum::http::StatusCode;

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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TenantRouteRecord {
    pub org_id: Uuid,
    pub status: String,
    pub provisioner: String,
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
                    | "session"
                    | "service_account"
                    | "api_key"
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
        let latest_record_micros = records
            .iter()
            .map(|record| record.created_at.timestamp_micros())
            .max()
            .unwrap_or(0);
        {
            let mut data = self.data.lock().await;
            for record in records {
                validate_tenant_record_org(org_id, &record)?;
                data.apply_record(&record.kind, record.org_id, &record.payload)?;
            }
            data.recompute_counters();
        }
        self.tenant_metric_stores
            .lock()
            .await
            .insert(org_id, metric_store);
        self.tenant_loaded.lock().await.insert(org_id);
        let mut clock = self.record_clock_micros.lock().await;
        *clock = (*clock).max(latest_record_micros);
        Ok(())
    }

    pub(super) async fn metric_store_for_org(&self, org_id: Uuid) -> AppResult<MetricStore> {
        self.ensure_tenant_loaded(org_id).await?;
        self.metric_store_for_persist(org_id).await
    }

    pub(super) async fn metric_store_for_persist(&self, org_id: Uuid) -> AppResult<MetricStore> {
        if !self.hosted_clickhouse_enabled() {
            return Ok(self.metric_store.clone());
        }
        self.tenant_metric_stores
            .lock()
            .await
            .get(&org_id)
            .cloned()
            .ok_or_else(|| tenant_unavailable("tenant route is not loaded"))
    }

    pub(super) async fn ensure_tenant_route(
        &self,
        org: &OrganizationRow,
    ) -> AppResult<TenantRouteRecord> {
        if !self.hosted_clickhouse_enabled() {
            return Ok(local_route(org.id));
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
        let provisioning = TenantRouteRecord {
            org_id: org.id,
            status: TENANT_ROUTE_PROVISIONING.to_string(),
            provisioner: self.provisioner_name(),
            endpoint: String::new(),
            database: String::new(),
            username: String::new(),
            password_secret_ref: None,
            password_ciphertext: None,
            service_id: None,
            created_at: now,
            updated_at: now,
            error: None,
        };
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
                    .unwrap_or_else(|| TenantRouteRecord {
                        org_id: org.id,
                        status: TENANT_ROUTE_FAILED.to_string(),
                        provisioner: self.provisioner_name(),
                        endpoint: String::new(),
                        database: String::new(),
                        username: String::new(),
                        password_secret_ref: None,
                        password_ciphertext: None,
                        service_id: None,
                        created_at: now,
                        updated_at: Utc::now(),
                        error: Some(error.message().to_string()),
                    });
                self.persist_locked(TENANT_ROUTE_KIND, org.id, &org.id.to_string(), &failed)
                    .await?;
                self.data.lock().await.insert_tenant_route(failed);
                Err(error)
            }
        }
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
        Ok(TenantRouteRecord {
            org_id: org.id,
            status: TENANT_ROUTE_READY.to_string(),
            provisioner: "database".to_string(),
            endpoint: connection.endpoint,
            database: connection.database,
            username: connection.username,
            password_secret_ref: Some(TENANT_BASE_PASSWORD_REF.to_string()),
            password_ciphertext: None,
            service_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            error: None,
        })
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
        let draft = TenantRouteRecord {
            org_id: org.id,
            status: TENANT_ROUTE_PROVISIONING.to_string(),
            provisioner: "cloud-service".to_string(),
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
        };
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
    AppError::new(StatusCode::SERVICE_UNAVAILABLE, message)
}

fn validate_tenant_record_org(
    expected_org_id: Uuid,
    record: &crate::metric_store::OperationalRecordRow,
) -> AppResult<()> {
    if record.org_id != expected_org_id {
        return Err(AppError::internal(
            "tenant operational record belonged to a different org",
        ));
    }
    let payload = serde_json::from_str::<Value>(&record.payload)
        .map_err(|_| AppError::internal("tenant operational record payload is invalid"))?;
    let payload_org_id = payload
        .get("org_id")
        .or_else(|| payload.get("row").and_then(|row| row.get("org_id")))
        .and_then(Value::as_str)
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| AppError::internal("tenant operational record org_id is invalid"))?;
    if payload_org_id
        .map(|org_id| org_id != expected_org_id)
        .unwrap_or(false)
    {
        return Err(AppError::internal(
            "tenant operational record payload belonged to a different org",
        ));
    }
    Ok(())
}

fn local_route(org_id: Uuid) -> TenantRouteRecord {
    TenantRouteRecord {
        org_id,
        status: TENANT_ROUTE_READY.to_string(),
        provisioner: "local".to_string(),
        endpoint: String::new(),
        database: String::new(),
        username: String::new(),
        password_secret_ref: None,
        password_ciphertext: None,
        service_id: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        error: None,
    }
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
            .unwrap_or("unknown");
        return Err(AppError::config(format!(
            "ClickHouse Cloud service '{service_name}' already exists for org {} as {service_id}, but tenant credentials were not persisted; reset and store credentials before retrying",
            org.id
        )));
    }
    let body = json!({
        "name": service_name,
        "provider": cloud.provider,
        "region": cloud.region,
        "ipAccessList": cloud_ip_access_list(cloud),
        "minReplicaMemoryGb": cloud.min_replica_memory_gb,
        "maxReplicaMemoryGb": cloud.max_replica_memory_gb,
        "numReplicas": cloud.num_replicas
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
    let stem = org
        .slug
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let stem = if stem.is_empty() { "Org" } else { &stem };
    let suffix = org.id.simple().to_string();
    format!("InstantML {stem} {}", &suffix[..8])
        .chars()
        .take(50)
        .collect()
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
            ip_access_list: vec!["0.0.0.0/0".to_string()],
            min_replica_memory_gb: 8,
            max_replica_memory_gb: 8,
            num_replicas: 1,
            wait_timeout: std::time::Duration::from_secs(1),
        };

        assert_eq!(
            cloud_ip_access_list(&cloud),
            vec![json!({"source": "0.0.0.0/0", "description": "InstantML API"})]
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
        };
        let name = cloud_service_name(&org);
        assert!(name.len() <= 50);
        assert!(name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == ' '));
    }
}
