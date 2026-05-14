use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

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
    pub managed_google_enabled: bool,
    pub allowed_frontend_origins: Vec<String>,
    pub request_timeout: Duration,
    pub log_format: LogFormat,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LogFormat {
    Pretty,
    Json,
}

impl AppConfig {
    pub fn from_env() -> AppResult<Self> {
        let clickhouse_url = env_string("CLICKHOUSE_URL", "http://default:@127.0.0.1:8123/rlobs");
        let bind_addr = env_string("RLOBS_BIND_ADDR", "127.0.0.1:8001")
            .parse()
            .map_err(|_| {
                AppError::config("RLOBS_BIND_ADDR must be a socket address like 127.0.0.1:8001")
            })?;
        let auth_mode = match env_string("RLOBS_AUTH_MODE", "local")
            .to_ascii_lowercase()
            .as_str()
        {
            "local" | "none" | "off" => AuthMode::Local,
            "api-key" | "api_key" | "hosted" => AuthMode::ApiKey,
            _ => return Err(AppError::config("RLOBS_AUTH_MODE must be local or api-key")),
        };
        let log_format = match env_string("RLOBS_LOG_FORMAT", "pretty")
            .to_ascii_lowercase()
            .as_str()
        {
            "pretty" => LogFormat::Pretty,
            "json" => LogFormat::Json,
            _ => return Err(AppError::config("RLOBS_LOG_FORMAT must be pretty or json")),
        };
        Ok(Self {
            clickhouse_url,
            bind_addr,
            max_body_bytes: env_usize("RLOBS_MAX_BODY_BYTES", 1_000_000)?,
            max_upload_body_bytes: env_usize("RLOBS_MAX_UPLOAD_BODY_BYTES", 50_000_000)?,
            artifact_root: PathBuf::from(env_string(
                "RLOBS_ARTIFACT_ROOT",
                ".rlobs/rust-artifacts",
            )),
            bootstrap_token: env::var("RLOBS_BOOTSTRAP_TOKEN").unwrap_or_default(),
            dev_auth_enabled: matches!(auth_mode, AuthMode::Local)
                && env_bool_optional("RLOBS_DEV_AUTH_ENABLED")?
                    .unwrap_or_else(|| bind_addr.ip().is_loopback()),
            managed_google_enabled: false,
            allowed_frontend_origins: env_origin_list("RLOBS_ALLOWED_FRONTEND_ORIGINS"),
            auth_mode,
            request_timeout: Duration::from_secs(env_u64("RLOBS_REQUEST_TIMEOUT_SECONDS", 30)?),
            log_format,
        })
    }
}

fn env_string(key: &str, fallback: &str) -> String {
    env::var(key).unwrap_or_else(|_| fallback.to_string())
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
