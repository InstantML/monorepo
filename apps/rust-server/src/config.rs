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
    pub artifact_uploads_enabled: bool,
    pub allowed_frontend_origins: Vec<String>,
    pub request_timeout: Duration,
    pub log_format: LogFormat,
    pub hosted_clickhouse: Option<HostedClickHouseConfig>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Clone, Debug)]
pub struct HostedClickHouseConfig {
    pub user_data_url: String,
    pub tenant_base_url: String,
    pub provisioner: ClickHouseProvisioner,
    pub allow_stored_tenant_passwords: bool,
    pub cloud: Option<ClickHouseCloudConfig>,
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
    pub wait_timeout: Duration,
}

impl AppConfig {
    pub fn from_env() -> AppResult<Self> {
        load_dotenv();
        let mut clickhouse_url =
            env_string("CLICKHOUSE_URL", "http://default:@127.0.0.1:8123/instantml");
        let hosted_clickhouse = hosted_clickhouse_config(&clickhouse_url)?;
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
        Ok(Self {
            clickhouse_url,
            bind_addr,
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
            artifact_uploads_enabled: env_bool_optional("INSTANTML_ARTIFACT_UPLOADS_ENABLED")?
                .unwrap_or_else(|| hosted_clickhouse.is_none()),
            allowed_frontend_origins: env_origin_list("INSTANTML_ALLOWED_FRONTEND_ORIGINS"),
            auth_mode,
            request_timeout: Duration::from_secs(env_u64("INSTANTML_REQUEST_TIMEOUT_SECONDS", 30)?),
            log_format,
            hosted_clickhouse,
        })
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
                .unwrap_or_else(|| vec!["0.0.0.0/0".to_string()]),
            min_replica_memory_gb: env_u64("INSTANTML_CLICKHOUSE_CLOUD_MIN_REPLICA_MEMORY_GB", 12)?
                as u32,
            max_replica_memory_gb: env_u64("INSTANTML_CLICKHOUSE_CLOUD_MAX_REPLICA_MEMORY_GB", 12)?
                as u32,
            num_replicas: env_u64("INSTANTML_CLICKHOUSE_CLOUD_NUM_REPLICAS", 1)? as u32,
            wait_timeout: Duration::from_secs(env_u64(
                "INSTANTML_CLICKHOUSE_CLOUD_WAIT_SECONDS",
                600,
            )?),
        })
    } else {
        None
    };
    Ok(Some(HostedClickHouseConfig {
        user_data_url,
        tenant_base_url,
        provisioner,
        allow_stored_tenant_passwords,
        cloud,
    }))
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
}
