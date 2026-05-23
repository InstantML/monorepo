use std::{env, fs, net::SocketAddr, path::PathBuf, time::Duration};

use crate::errors::{AppError, AppResult};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthMode {
    Local,
    ApiKey,
}

impl AuthMode {
    pub fn requires_api_key(&self) -> bool {
        matches!(self, Self::ApiKey)
    }
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub clickhouse_url: String,
    pub bind_addr: SocketAddr,
    pub service_plane: ServicePlaneRole,
    pub max_body_bytes: usize,
    pub max_upload_body_bytes: usize,
    pub artifact_root: PathBuf,
    pub bootstrap_token: String,
    pub auth_mode: AuthMode,
    pub dev_auth_enabled: bool,
    pub managed_clerk_enabled: bool,
    pub clerk_secret_key: Option<String>,
    pub clerk_api_base: String,
    pub clerk_jwt_issuer: Option<String>,
    pub clerk_session_max_token_age: Duration,
    pub signup_allowed_emails: Vec<String>,
    pub signup_allowed_domains: Vec<String>,
    pub artifact_backend: ArtifactBackend,
    pub r2_artifacts: Option<R2ArtifactConfig>,
    pub artifact_uploads_enabled: bool,
    pub allowed_frontend_origins: Vec<String>,
    pub request_timeout: Duration,
    pub slow_request_threshold: Duration,
    pub log_format: LogFormat,
    pub hosted_clickhouse: Option<HostedClickHouseConfig>,
    pub byoc_clickhouse: ByocClickHouseConfig,
    pub billing: BillingConfig,
    pub email: EmailConfig,
    /// Base URL of the frontend, used to construct device-code verification URIs.
    /// Defaults to the first allowed_frontend_origins entry if set, else "http://localhost:3000".
    pub frontend_base_url: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EmailProvider {
    Disabled,
    Log,
    Resend,
}

impl EmailProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Log => "log",
            Self::Resend => "resend",
        }
    }
}

#[derive(Clone, Debug)]
pub struct EmailConfig {
    pub provider: EmailProvider,
    pub from: String,
    pub reply_to: Option<String>,
    pub frontend_base_url: String,
    pub resend_api_key: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BillingConfig {
    pub enabled: bool,
    pub stripe_secret_key: Option<String>,
    pub stripe_publishable_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub stripe_api_version: String,
    pub pro_price_id: Option<String>,
    pub premium_price_id: Option<String>,
    pub extra_seat_price_id: Option<String>,
    pub storage_overage_price_id: Option<String>,
    pub pro_api_request_overage_price_id: Option<String>,
    pub premium_api_request_overage_price_id: Option<String>,
    pub storage_meter_id: Option<String>,
    pub api_request_meter_id: Option<String>,
    pub storage_meter_event_name: String,
    pub api_request_meter_event_name: String,
    pub success_url: String,
    pub cancel_url: String,
    pub portal_return_url: String,
    pub grace_days: i64,
    pub extra_seat_monthly_usd: i64,
    pub storage_overage_cents_per_gib_month: i64,
}

impl BillingConfig {
    pub fn disabled(frontend_base_url: Option<&str>) -> Self {
        let frontend = frontend_base_url
            .unwrap_or("http://localhost:3000")
            .trim_end_matches('/');
        Self {
            enabled: false,
            stripe_secret_key: None,
            stripe_publishable_key: None,
            stripe_webhook_secret: None,
            stripe_api_version: "2026-04-22.dahlia".to_string(),
            pro_price_id: None,
            premium_price_id: None,
            extra_seat_price_id: None,
            storage_overage_price_id: None,
            pro_api_request_overage_price_id: None,
            premium_api_request_overage_price_id: None,
            storage_meter_id: None,
            api_request_meter_id: None,
            storage_meter_event_name: "instantml_storage_overage_gib_month".to_string(),
            api_request_meter_event_name: "instantml_api_request_overage".to_string(),
            success_url: format!("{frontend}/billing/return?session_id={{CHECKOUT_SESSION_ID}}"),
            cancel_url: format!("{frontend}/settings"),
            portal_return_url: format!("{frontend}/dashboard/settings"),
            grace_days: 7,
            extra_seat_monthly_usd: 99,
            storage_overage_cents_per_gib_month: 3,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactBackend {
    Local,
    R2,
}

#[derive(Clone, Debug)]
pub struct R2ArtifactConfig {
    pub account_id: String,
    pub api_token: String,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub bucket_prefix: String,
    pub endpoint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServicePlaneRole {
    Combined,
    Control,
    Data,
}

impl ServicePlaneRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Combined => "combined",
            Self::Control => "control",
            Self::Data => "data",
        }
    }

    pub fn includes_control(self) -> bool {
        matches!(self, Self::Combined | Self::Control)
    }

    pub fn includes_data(self) -> bool {
        matches!(self, Self::Combined | Self::Data)
    }

    /// Whether this plane should run a background task that periodically refreshes
    /// the in-memory control projection (tenant routes, org membership, api keys, …)
    /// from the control-plane ClickHouse table.
    ///
    /// Only the data plane needs this: it is the consumer of control mutations
    /// produced by the control plane. The control plane (and combined-mode
    /// process, which serves as its own control plane) already updates its
    /// in-memory projection synchronously when it persists a control record, so
    /// it does not need to poll.
    pub fn runs_background_control_refresh(self) -> bool {
        matches!(self, Self::Data)
    }

    fn requires_hosted_clickhouse(self) -> bool {
        matches!(self, Self::Control | Self::Data)
    }
}

#[derive(Clone, Debug)]
pub struct HostedClickHouseConfig {
    pub user_data_url: String,
    pub tenant_base_url: String,
    pub provisioner: ClickHouseProvisioner,
    pub allow_stored_tenant_passwords: bool,
    pub cloud: Option<ClickHouseCloudConfig>,
    /// Connection URL for the shared ClickHouse cell.
    /// When `Some`, personal/free signups route here instead of provisioning
    /// a new Cloud service. Format: `http://user:pass@host:port/database`.
    pub shared_cell_url: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClickHouseProvisioner {
    Database,
    CloudService,
}

#[derive(Clone, Debug)]
pub struct ClickHouseCloudConfig {
    pub endpoint: String,
    pub key_id: String,
    pub key_secret: String,
    pub organization_id: Option<String>,
    pub provider: String,
    pub region: String,
    pub ip_access_list: Vec<String>,
    pub min_replica_memory_gb: u32,
    pub max_replica_memory_gb: u32,
    pub num_replicas: u32,
    pub allow_plan_sizing: bool,
    pub wait_timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct ByocClickHouseConfig {
    pub egress_cidrs: Vec<String>,
    pub egress_set_version: String,
    pub allow_private_endpoints: bool,
    pub credential_store: ByocCredentialStoreConfig,
}

impl ByocClickHouseConfig {
    pub fn require_customer_setup_enabled(&self) -> AppResult<()> {
        if !self.allow_private_endpoints && self.egress_cidrs.is_empty() {
            return Err(AppError::with_code(
                http::StatusCode::SERVICE_UNAVAILABLE,
                "byoc_egress_unconfigured",
                "customer-owned ClickHouse is not available until InstantML data-plane egress CIDRs are configured",
            ));
        }
        if matches!(self.credential_store, ByocCredentialStoreConfig::Disabled) {
            return Err(AppError::with_code(
                http::StatusCode::SERVICE_UNAVAILABLE,
                "byoc_secret_store_unconfigured",
                "customer-owned ClickHouse is not available until BYOC credential storage is configured",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ByocCredentialStoreConfig {
    Disabled,
    LocalUserData,
    GcpSecretManager(GcpSecretManagerConfig),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GcpSecretManagerConfig {
    pub project_id: String,
    pub secret_prefix: String,
    pub api_base: String,
    pub access_token: Option<String>,
}

impl AppConfig {
    pub fn from_env() -> AppResult<Self> {
        load_dotenv();
        let mut clickhouse_url =
            env_string("CLICKHOUSE_URL", "http://default:@127.0.0.1:8123/instantml");
        let hosted_clickhouse = hosted_clickhouse_config(&clickhouse_url)?;
        let service_plane = service_plane_role()?;
        if service_plane.requires_hosted_clickhouse() && hosted_clickhouse.is_none() {
            return Err(AppError::config(
                "INSTANTML_SERVICE_PLANE=control or data requires INSTANTML_HOSTED_CLICKHOUSE_ENABLED=true",
            ));
        }
        if env::var("CLICKHOUSE_URL").is_err() {
            if let Some(hosted) = &hosted_clickhouse {
                clickhouse_url = hosted.tenant_base_url.clone();
            }
        }
        let bind_addr = env_string("INSTANTML_BIND_ADDR", "127.0.0.1:8001")
            .parse()
            .map_err(|_| {
                AppError::config("INSTANTML_BIND_ADDR must be a socket address like 127.0.0.1:8001")
            })?;
        let auth_mode = match env_string("INSTANTML_AUTH_MODE", "local")
            .to_ascii_lowercase()
            .as_str()
        {
            "local" | "none" | "off" => AuthMode::Local,
            "api-key" | "api_key" | "hosted" => AuthMode::ApiKey,
            _ => {
                return Err(AppError::config(
                    "INSTANTML_AUTH_MODE must be local or api-key",
                ))
            }
        };
        let log_format = match env_string("INSTANTML_LOG_FORMAT", "pretty")
            .to_ascii_lowercase()
            .as_str()
        {
            "pretty" => LogFormat::Pretty,
            "json" => LogFormat::Json,
            _ => {
                return Err(AppError::config(
                    "INSTANTML_LOG_FORMAT must be pretty or json",
                ))
            }
        };
        let clerk_secret_key = env::var("CLERK_SECRET_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let managed_clerk_requested = env_bool_optional("INSTANTML_MANAGED_CLERK_ENABLED")?
            .unwrap_or_else(|| clerk_secret_key.is_some() && matches!(auth_mode, AuthMode::ApiKey));
        if managed_clerk_requested && clerk_secret_key.is_none() {
            return Err(AppError::config(
                "CLERK_SECRET_KEY is required when managed Clerk auth is enabled",
            ));
        }
        let (artifact_backend, r2_artifacts) = artifact_backend_config()?;
        let artifact_uploads_enabled = env_bool_optional("INSTANTML_ARTIFACT_UPLOADS_ENABLED")?
            .unwrap_or_else(|| match artifact_backend {
                ArtifactBackend::Local => hosted_clickhouse.is_none(),
                ArtifactBackend::R2 => true,
            });
        let allowed_frontend_origins = env_origin_list("INSTANTML_ALLOWED_FRONTEND_ORIGINS");
        let frontend_base_url = env::var("INSTANTML_FRONTEND_BASE_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let email = email_config(
            matches!(auth_mode, AuthMode::Local),
            frontend_base_url.as_deref(),
            &allowed_frontend_origins,
        )?;
        let billing = billing_config(frontend_base_url.as_deref())?;
        Ok(Self {
            clickhouse_url,
            bind_addr,
            service_plane,
            max_body_bytes: env_usize("INSTANTML_MAX_BODY_BYTES", 1_000_000)?,
            max_upload_body_bytes: env_usize("INSTANTML_MAX_UPLOAD_BODY_BYTES", 50_000_000)?,
            artifact_root: PathBuf::from(env_string(
                "INSTANTML_ARTIFACT_ROOT",
                ".instantml/rust-artifacts",
            )),
            bootstrap_token: env::var("INSTANTML_BOOTSTRAP_TOKEN").unwrap_or_default(),
            dev_auth_enabled: matches!(auth_mode, AuthMode::Local)
                && env_bool_optional("INSTANTML_DEV_AUTH_ENABLED")?
                    .unwrap_or_else(|| bind_addr.ip().is_loopback()),
            managed_clerk_enabled: managed_clerk_requested,
            clerk_secret_key,
            clerk_api_base: env_string("CLERK_API_BASE", "https://api.clerk.com"),
            clerk_jwt_issuer: env::var("CLERK_JWT_ISSUER")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            clerk_session_max_token_age: Duration::from_secs(env_u64(
                "INSTANTML_CLERK_SESSION_MAX_AGE_SECONDS",
                600,
            )?),
            signup_allowed_emails: env_string_list("INSTANTML_SIGNUP_ALLOWED_EMAILS")
                .unwrap_or_default()
                .into_iter()
                .map(|email| email.to_ascii_lowercase())
                .collect(),
            signup_allowed_domains: env_string_list("INSTANTML_SIGNUP_ALLOWED_DOMAINS")
                .unwrap_or_default()
                .into_iter()
                .map(|domain| domain.trim_start_matches('@').to_ascii_lowercase())
                .filter(|domain| !domain.is_empty())
                .collect(),
            artifact_backend,
            r2_artifacts,
            artifact_uploads_enabled,
            allowed_frontend_origins,
            frontend_base_url,
            auth_mode,
            request_timeout: Duration::from_secs(env_u64("INSTANTML_REQUEST_TIMEOUT_SECONDS", 30)?),
            slow_request_threshold: Duration::from_millis(env_u64(
                "INSTANTML_SLOW_REQUEST_MS",
                1000,
            )?),
            log_format,
            hosted_clickhouse,
            byoc_clickhouse: byoc_clickhouse_config()?,
            billing,
            email,
        })
    }
}

fn service_plane_role() -> AppResult<ServicePlaneRole> {
    let raw = env::var("INSTANTML_SERVICE_PLANE")
        .or_else(|_| env::var("INSTANTML_SERVICE_PLANE_ROLE"))
        .unwrap_or_else(|_| "combined".to_string());
    parse_service_plane_role(&raw)
}

fn parse_service_plane_role(raw: &str) -> AppResult<ServicePlaneRole> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "combined" | "all" | "single" | "single-process" | "single_process" => {
            Ok(ServicePlaneRole::Combined)
        }
        "control" | "control-plane" | "control_plane" => Ok(ServicePlaneRole::Control),
        "data" | "data-plane" | "data_plane" => Ok(ServicePlaneRole::Data),
        _ => Err(AppError::config(
            "INSTANTML_SERVICE_PLANE must be combined, control, or data",
        )),
    }
}

fn load_dotenv() {
    let Ok(contents) = fs::read_to_string(".env") else {
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || env::var_os(key).is_some() {
            continue;
        }
        env::set_var(key, unquote_env_value(value.trim()));
    }
}

fn unquote_env_value(raw: &str) -> String {
    let quoted = (raw.starts_with('"') && raw.ends_with('"'))
        || (raw.starts_with('\'') && raw.ends_with('\''));
    if quoted && raw.len() >= 2 {
        raw[1..raw.len() - 1].to_string()
    } else {
        raw.to_string()
    }
}

fn hosted_clickhouse_config(
    default_clickhouse_url: &str,
) -> AppResult<Option<HostedClickHouseConfig>> {
    if !env_bool_optional("INSTANTML_HOSTED_CLICKHOUSE_ENABLED")?.unwrap_or(false) {
        return Ok(None);
    }
    let provisioner = match env_string("INSTANTML_CLICKHOUSE_PROVISIONER", "database")
        .to_ascii_lowercase()
        .as_str()
    {
        "database" | "tenant-database" | "tenant_database" => ClickHouseProvisioner::Database,
        "cloud-service" | "cloud_service" | "service" => ClickHouseProvisioner::CloudService,
        _ => {
            return Err(AppError::config(
                "INSTANTML_CLICKHOUSE_PROVISIONER must be database or cloud-service",
            ))
        }
    };
    let user_data_url = clickhouse_url_from_env(
        "CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT",
        "CLICKHOUSE_INSTANTML_USER_DATA_USERNAME",
        "CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD",
        default_clickhouse_url,
    );
    let tenant_base_url = env::var("INSTANTML_TENANT_CLICKHOUSE_URL").unwrap_or_else(|_| {
        clickhouse_url_from_env(
            "CLICKHOUSE_INSTANTML_TENANT_ENDPOINT",
            "CLICKHOUSE_INSTANTML_TENANT_USERNAME",
            "CLICKHOUSE_INSTANTML_TENANT_PASSWORD",
            &user_data_url,
        )
    });
    let allow_stored_tenant_passwords =
        env_bool_optional("INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS")?.unwrap_or(false);
    let cloud = if matches!(provisioner, ClickHouseProvisioner::CloudService) {
        Some(ClickHouseCloudConfig {
            endpoint: env_string("CLICKHOUSE_CLOUD_ENDPOINT", "https://api.clickhouse.cloud"),
            key_id: required_env("CLICKHOUSE_INSTANTML_GENERAL_KEY_ID")?,
            key_secret: required_env("CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET")?,
            organization_id: env::var("INSTANTML_CLICKHOUSE_CLOUD_ORG_ID")
                .or_else(|_| env::var("CLICKHOUSE_CLOUD_ORGANIZATION_ID"))
                .ok()
                .filter(|value| !value.trim().is_empty()),
            provider: env_string("INSTANTML_CLICKHOUSE_CLOUD_PROVIDER", "gcp"),
            region: env_string("INSTANTML_CLICKHOUSE_CLOUD_REGION", "us-central1"),
            ip_access_list: env_string_list("INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST")
                .filter(|values| !values.is_empty())
                .ok_or_else(|| {
                    AppError::config(
                        "INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST is required for cloud-service provisioning",
                    )
                })?,
            min_replica_memory_gb: env_u64("INSTANTML_CLICKHOUSE_CLOUD_MIN_REPLICA_MEMORY_GB", 12)?
                as u32,
            max_replica_memory_gb: env_u64("INSTANTML_CLICKHOUSE_CLOUD_MAX_REPLICA_MEMORY_GB", 12)?
                as u32,
            num_replicas: env_u64("INSTANTML_CLICKHOUSE_CLOUD_NUM_REPLICAS", 1)? as u32,
            allow_plan_sizing: env_bool_optional("INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING")?
                .unwrap_or(false),
            wait_timeout: Duration::from_secs(env_u64(
                "INSTANTML_CLICKHOUSE_CLOUD_WAIT_SECONDS",
                600,
            )?),
        })
    } else {
        None
    };
    // Shared cell URL for personal/free signups. When absent, those signups
    // fall through to the existing dedicated provisioning path.
    let shared_cell_url = env::var("INSTANTML_SHARED_CELL_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(Some(HostedClickHouseConfig {
        user_data_url,
        tenant_base_url,
        provisioner,
        allow_stored_tenant_passwords,
        cloud,
        shared_cell_url,
    }))
}

fn byoc_clickhouse_config() -> AppResult<ByocClickHouseConfig> {
    let egress_cidrs = env_string_list("INSTANTML_BYOC_EGRESS_CIDRS")
        .or_else(|| env_string_list("INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST"))
        .unwrap_or_default();
    let egress_set_version = env_string(
        "INSTANTML_BYOC_EGRESS_SET_VERSION",
        if egress_cidrs.is_empty() {
            "local-dev"
        } else {
            "configured"
        },
    );
    let allow_private_endpoints = env_bool_optional("INSTANTML_BYOC_ALLOW_PRIVATE_ENDPOINTS")
        .ok()
        .flatten()
        .unwrap_or(false);
    let credential_store = byoc_credential_store_config()?;
    Ok(ByocClickHouseConfig {
        egress_cidrs,
        egress_set_version,
        allow_private_endpoints,
        credential_store,
    })
}

fn byoc_credential_store_config() -> AppResult<ByocCredentialStoreConfig> {
    let backend = env::var("INSTANTML_BYOC_SECRET_BACKEND")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    match backend.as_deref() {
        Some("gcp-secret-manager" | "gcp_secret_manager" | "gcp" | "secret-manager") => {
            let project_id = env_first(&[
                "INSTANTML_BYOC_SECRET_PROJECT_ID",
                "GOOGLE_CLOUD_PROJECT",
                "GCP_PROJECT",
                "GCLOUD_PROJECT",
            ])
            .ok_or_else(|| {
                AppError::config(
                    "INSTANTML_BYOC_SECRET_PROJECT_ID is required for GCP BYOC secret storage",
                )
            })?;
            Ok(ByocCredentialStoreConfig::GcpSecretManager(
                GcpSecretManagerConfig {
                    project_id,
                    secret_prefix: env_string(
                        "INSTANTML_BYOC_SECRET_PREFIX",
                        "instantml-byoc-clickhouse",
                    ),
                    api_base: env_string(
                        "INSTANTML_BYOC_SECRET_MANAGER_API_BASE",
                        "https://secretmanager.googleapis.com/v1",
                    )
                    .trim_end_matches('/')
                    .to_string(),
                    access_token: env_first(&["INSTANTML_BYOC_SECRET_MANAGER_ACCESS_TOKEN"]),
                },
            ))
        }
        Some("local-user-data" | "local_user_data" | "local") => {
            Ok(ByocCredentialStoreConfig::LocalUserData)
        }
        Some("disabled" | "off" | "none") | None => {
            if env_bool_optional("INSTANTML_BYOC_ALLOW_USER_DATA_STORED_PASSWORDS")?
                .or_else(|| {
                    env_bool_optional("INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS")
                        .ok()
                        .flatten()
                })
                .unwrap_or(false)
            {
                Ok(ByocCredentialStoreConfig::LocalUserData)
            } else {
                Ok(ByocCredentialStoreConfig::Disabled)
            }
        }
        Some(_) => Err(AppError::config(
            "INSTANTML_BYOC_SECRET_BACKEND must be gcp-secret-manager, local-user-data, or disabled",
        )),
    }
}

fn billing_config(frontend_base_url: Option<&str>) -> AppResult<BillingConfig> {
    let mut config = BillingConfig::disabled(frontend_base_url);
    config.stripe_secret_key = env_first(&["STRIPE_SECRET_KEY", "INSTANTML_STRIPE_SECRET_KEY"]);
    config.stripe_publishable_key = env_first(&[
        "STRIPE_PUBLISHABLE_KEY",
        "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    ]);
    config.stripe_webhook_secret =
        env_first(&["STRIPE_WEBHOOK_SECRET", "INSTANTML_STRIPE_WEBHOOK_SECRET"]);
    config.stripe_api_version = env_string("STRIPE_API_VERSION", &config.stripe_api_version);
    config.pro_price_id = env_first(&["STRIPE_PRO_PRICE_ID", "INSTANTML_STRIPE_PRO_PRICE_ID"]);
    config.premium_price_id = env_first(&[
        "STRIPE_PREMIUM_PRICE_ID",
        "INSTANTML_STRIPE_PREMIUM_PRICE_ID",
    ]);
    config.extra_seat_price_id = env_first(&[
        "STRIPE_EXTRA_SEAT_PRICE_ID",
        "INSTANTML_STRIPE_EXTRA_SEAT_PRICE_ID",
    ]);
    config.storage_overage_price_id = env_first(&[
        "STRIPE_STORAGE_OVERAGE_PRICE_ID",
        "INSTANTML_STRIPE_STORAGE_OVERAGE_PRICE_ID",
    ]);
    config.pro_api_request_overage_price_id = env_first(&[
        "STRIPE_PRO_API_REQUEST_OVERAGE_PRICE_ID",
        "INSTANTML_STRIPE_PRO_API_REQUEST_OVERAGE_PRICE_ID",
    ]);
    config.premium_api_request_overage_price_id = env_first(&[
        "STRIPE_PREMIUM_API_REQUEST_OVERAGE_PRICE_ID",
        "INSTANTML_STRIPE_PREMIUM_API_REQUEST_OVERAGE_PRICE_ID",
    ]);
    config.storage_meter_id = env_first(&[
        "STRIPE_STORAGE_METER_ID",
        "INSTANTML_STRIPE_STORAGE_METER_ID",
    ]);
    config.api_request_meter_id = env_first(&[
        "STRIPE_API_REQUEST_METER_ID",
        "INSTANTML_STRIPE_API_REQUEST_METER_ID",
    ]);
    config.storage_meter_event_name = env_string(
        "INSTANTML_STRIPE_STORAGE_METER_EVENT_NAME",
        &config.storage_meter_event_name,
    );
    config.api_request_meter_event_name = env_string(
        "INSTANTML_STRIPE_API_REQUEST_METER_EVENT_NAME",
        &config.api_request_meter_event_name,
    );
    config.success_url = env_string("INSTANTML_BILLING_SUCCESS_URL", &config.success_url);
    config.cancel_url = env_string("INSTANTML_BILLING_CANCEL_URL", &config.cancel_url);
    config.portal_return_url = env_string(
        "INSTANTML_BILLING_PORTAL_RETURN_URL",
        &config.portal_return_url,
    );
    config.grace_days = env_u64("INSTANTML_BILLING_GRACE_DAYS", config.grace_days as u64)? as i64;
    config.extra_seat_monthly_usd = env_u64(
        "INSTANTML_EXTRA_SEAT_MONTHLY_USD",
        config.extra_seat_monthly_usd as u64,
    )? as i64;
    config.storage_overage_cents_per_gib_month = env_u64(
        "INSTANTML_STORAGE_OVERAGE_CENTS_PER_GIB_MONTH",
        config.storage_overage_cents_per_gib_month as u64,
    )? as i64;
    config.enabled = env_bool_optional("INSTANTML_BILLING_ENABLED")?
        .unwrap_or_else(|| config.stripe_secret_key.is_some());
    if config.enabled && config.stripe_secret_key.is_none() {
        return Err(AppError::config(
            "STRIPE_SECRET_KEY is required when billing is enabled",
        ));
    }
    Ok(config)
}

fn email_config(
    local_mode: bool,
    frontend_base_url: Option<&str>,
    allowed_frontend_origins: &[String],
) -> AppResult<EmailConfig> {
    let resend_api_key = env_first(&["RESEND_API_KEY", "INSTANTML_RESEND_API_KEY"]);
    let provider = env::var("INSTANTML_EMAIL_PROVIDER")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if resend_api_key.is_some() {
                "resend".to_string()
            } else if local_mode {
                "log".to_string()
            } else {
                "disabled".to_string()
            }
        });
    let provider = match provider.as_str() {
        "disabled" | "off" | "none" => EmailProvider::Disabled,
        "log" | "console" => EmailProvider::Log,
        "resend" => EmailProvider::Resend,
        _ => {
            return Err(AppError::config(
                "INSTANTML_EMAIL_PROVIDER must be disabled, log, or resend",
            ))
        }
    };
    if matches!(provider, EmailProvider::Resend) && resend_api_key.is_none() {
        return Err(AppError::config(
            "RESEND_API_KEY is required when INSTANTML_EMAIL_PROVIDER=resend",
        ));
    }
    let email_from = env_first(&["INSTANTML_EMAIL_FROM"]);
    if matches!(provider, EmailProvider::Resend) && email_from.is_none() {
        return Err(AppError::config(
            "INSTANTML_EMAIL_FROM is required when organization invite email uses Resend",
        ));
    }
    let fallback_origin = if matches!(provider, EmailProvider::Resend) {
        allowed_frontend_origins
            .iter()
            .find(|origin| !is_loopback_origin(origin))
            .map(String::as_str)
    } else {
        allowed_frontend_origins.first().map(String::as_str)
    };
    let frontend = frontend_base_url
        .or(fallback_origin)
        .unwrap_or("http://localhost:3000")
        .trim_end_matches('/')
        .to_string();
    if matches!(provider, EmailProvider::Resend) && is_loopback_origin(&frontend) {
        return Err(AppError::config(
            "INSTANTML_FRONTEND_BASE_URL must be a non-localhost URL when organization invite email uses Resend",
        ));
    }
    Ok(EmailConfig {
        provider,
        from: email_from.unwrap_or_else(|| "InstantML <invites@instantml.ai>".to_string()),
        reply_to: env_first(&["INSTANTML_EMAIL_REPLY_TO", "INSTANTML_SUPPORT_EMAIL"]),
        frontend_base_url: frontend,
        resend_api_key,
    })
}

fn is_loopback_origin(raw: &str) -> bool {
    raw.parse::<url::Url>()
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1"))
}

fn artifact_backend_config() -> AppResult<(ArtifactBackend, Option<R2ArtifactConfig>)> {
    let backend = match env_string("INSTANTML_ARTIFACT_BACKEND", "local")
        .to_ascii_lowercase()
        .as_str()
    {
        "local" | "filesystem" | "fs" => ArtifactBackend::Local,
        "r2" | "cloudflare-r2" | "cloudflare_r2" => ArtifactBackend::R2,
        _ => {
            return Err(AppError::config(
                "INSTANTML_ARTIFACT_BACKEND must be local or r2",
            ))
        }
    };
    if !matches!(backend, ArtifactBackend::R2) {
        return Ok((backend, None));
    }
    let account_id = required_env_any(&["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID"])?;
    let api_token = required_env_any(&[
        "CLOUDFLARE_R2_API_KEY",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_R2_TOKEN",
    ])?;
    let endpoint = env::var("CLOUDFLARE_R2_ENDPOINT")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("https://{account_id}.r2.cloudflarestorage.com"));
    let access_key_id = env_first(&[
        "CLOUDFLARE_R2_ACCESS_KEY_ID",
        "CLOUDFLARE_R2_TOKEN_ID",
        "CLOUDFLARE_API_TOKEN_ID",
    ]);
    let secret_access_key = env_first(&[
        "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
        "CLOUDFLARE_R2_ACCESS_KEY_SECRET",
    ]);
    Ok((
        backend,
        Some(R2ArtifactConfig {
            account_id,
            api_token,
            access_key_id,
            secret_access_key,
            bucket_prefix: env_string("CLOUDFLARE_R2_BUCKET_PREFIX", "instantml-org"),
            endpoint,
        }),
    ))
}

fn clickhouse_url_from_env(
    endpoint_key: &str,
    username_key: &str,
    password_key: &str,
    fallback: &str,
) -> String {
    let Ok(endpoint) = env::var(endpoint_key) else {
        return fallback.to_string();
    };
    let username = env::var(username_key).unwrap_or_else(|_| "default".to_string());
    let password = env::var(password_key).unwrap_or_default();
    if endpoint.contains('@') {
        return endpoint;
    }
    let Ok(mut parsed) = url::Url::parse(&endpoint) else {
        return endpoint;
    };
    let _ = parsed.set_username(&username);
    let _ = parsed.set_password(Some(&password));
    if parsed.path().is_empty() || parsed.path() == "/" {
        parsed.set_path("default");
    }
    parsed.to_string()
}

fn env_string(key: &str, fallback: &str) -> String {
    env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn env_string_list(key: &str) -> Option<Vec<String>> {
    let raw = env::var(key).ok()?;
    Some(split_env_string_list(&raw))
}

fn split_env_string_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn required_env(key: &str) -> AppResult<String> {
    env::var(key).map_err(|_| AppError::config(format!("{key} is required")))
}

fn required_env_any(keys: &[&str]) -> AppResult<String> {
    env_first(keys).ok_or_else(|| AppError::config(format!("{} is required", keys.join(" or "))))
}

fn env_first(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_usize(key: &str, fallback: usize) -> AppResult<usize> {
    match env::var(key) {
        Ok(raw) => raw
            .parse()
            .map_err(|_| AppError::config(format!("{key} must be a positive integer"))),
        Err(_) => Ok(fallback),
    }
}

fn env_u64(key: &str, fallback: u64) -> AppResult<u64> {
    match env::var(key) {
        Ok(raw) => raw
            .parse()
            .map_err(|_| AppError::config(format!("{key} must be a positive integer"))),
        Err(_) => Ok(fallback),
    }
}

fn env_bool_optional(key: &str) -> AppResult<Option<bool>> {
    match env::var(key) {
        Ok(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(Some(true)),
            "0" | "false" | "no" | "off" => Ok(Some(false)),
            _ => Err(AppError::config(format!("{key} must be true or false"))),
        },
        Err(_) => Ok(None),
    }
}

fn env_origin_list(key: &str) -> Vec<String> {
    env::var(key)
        .unwrap_or_default()
        .split(',')
        .filter_map(|origin| {
            let origin = origin.trim().trim_end_matches('/');
            (!origin.is_empty()).then(|| origin.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_clickhouse_is_disabled_by_default() {
        std::env::remove_var("INSTANTML_HOSTED_CLICKHOUSE_ENABLED");
        assert!(
            hosted_clickhouse_config("http://default:@127.0.0.1:8123/instantml")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn slow_request_ms_uses_positive_integer_parser() {
        std::env::set_var("INSTANTML_SLOW_REQUEST_MS", "2500");
        assert_eq!(env_u64("INSTANTML_SLOW_REQUEST_MS", 1000).unwrap(), 2500);

        std::env::set_var("INSTANTML_SLOW_REQUEST_MS", "not-a-number");
        assert!(env_u64("INSTANTML_SLOW_REQUEST_MS", 1000).is_err());
        std::env::remove_var("INSTANTML_SLOW_REQUEST_MS");
    }

    #[test]
    fn unquote_env_value_removes_matching_quotes() {
        assert_eq!(unquote_env_value("\"secret\""), "secret");
        assert_eq!(unquote_env_value("'secret'"), "secret");
        assert_eq!(unquote_env_value("secret"), "secret");
    }

    #[test]
    fn split_env_string_list_omits_empty_values() {
        assert_eq!(
            split_env_string_list(" 10.0.0.1/32, ,0.0.0.0/0 "),
            vec!["10.0.0.1/32".to_string(), "0.0.0.0/0".to_string()]
        );
        assert!(split_env_string_list(" , ").is_empty());
    }

    #[test]
    fn service_plane_role_accepts_stable_aliases() {
        assert_eq!(
            parse_service_plane_role("combined").unwrap(),
            ServicePlaneRole::Combined
        );
        assert_eq!(
            parse_service_plane_role("control-plane").unwrap(),
            ServicePlaneRole::Control
        );
        assert_eq!(
            parse_service_plane_role("data_plane").unwrap(),
            ServicePlaneRole::Data
        );
        assert!(parse_service_plane_role("proxy").is_err());
    }
}
