use base64::{engine::general_purpose, Engine as _};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    config::{ByocCredentialStoreConfig, GcpSecretManagerConfig},
    errors::{AppError, AppResult},
};

const GCP_SECRET_REF_PREFIX: &str = "gcp-secret-manager:";
const LOCAL_USER_DATA_REF_PREFIX: &str = "local-user-data-byoc:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredByocSecret {
    pub secret_ref: String,
    pub local_ciphertext: Option<String>,
}

pub async fn store_byoc_clickhouse_password(
    config: &ByocCredentialStoreConfig,
    org_id: Uuid,
    password: &str,
) -> AppResult<StoredByocSecret> {
    match config {
        ByocCredentialStoreConfig::Disabled => Err(secret_unavailable(
            "BYOC credential storage is not configured",
        )),
        ByocCredentialStoreConfig::LocalUserData => Ok(StoredByocSecret {
            secret_ref: format!("{LOCAL_USER_DATA_REF_PREFIX}{}", org_id.simple()),
            local_ciphertext: Some(password.to_string()),
        }),
        ByocCredentialStoreConfig::GcpSecretManager(gcp) => {
            let version_name = gcp_store_password(gcp, org_id, password).await?;
            Ok(StoredByocSecret {
                secret_ref: format!("{GCP_SECRET_REF_PREFIX}{version_name}"),
                local_ciphertext: None,
            })
        }
    }
}

pub async fn read_byoc_clickhouse_password(
    config: &ByocCredentialStoreConfig,
    secret_ref: Option<&str>,
    local_ciphertext: Option<&str>,
) -> AppResult<String> {
    match config {
        ByocCredentialStoreConfig::Disabled => Err(secret_unavailable(
            "BYOC credential storage is not configured",
        )),
        ByocCredentialStoreConfig::LocalUserData => {
            let secret_ref = secret_ref
                .ok_or_else(|| secret_unavailable("BYOC local credential reference is missing"))?;
            if !secret_ref.starts_with(LOCAL_USER_DATA_REF_PREFIX) {
                return Err(secret_unavailable(
                    "BYOC local credential reference is invalid",
                ));
            }
            local_ciphertext
                .map(str::to_string)
                .ok_or_else(|| secret_unavailable("BYOC local credential payload is missing"))
        }
        ByocCredentialStoreConfig::GcpSecretManager(gcp) => {
            let secret_ref = secret_ref
                .ok_or_else(|| secret_unavailable("BYOC Secret Manager reference is missing"))?;
            let version_name = secret_ref
                .strip_prefix(GCP_SECRET_REF_PREFIX)
                .ok_or_else(|| secret_unavailable("BYOC Secret Manager reference is invalid"))?;
            gcp_read_password(gcp, version_name).await
        }
    }
}

pub async fn destroy_byoc_clickhouse_password_version(
    config: &ByocCredentialStoreConfig,
    secret_ref: Option<&str>,
) -> AppResult<()> {
    let Some(secret_ref) = secret_ref else {
        return Ok(());
    };
    match config {
        ByocCredentialStoreConfig::Disabled | ByocCredentialStoreConfig::LocalUserData => Ok(()),
        ByocCredentialStoreConfig::GcpSecretManager(gcp) => {
            let version_name = secret_ref
                .strip_prefix(GCP_SECRET_REF_PREFIX)
                .ok_or_else(|| secret_unavailable("BYOC Secret Manager reference is invalid"))?;
            if !version_name.starts_with(&format!("projects/{}/secrets/", gcp.project_id)) {
                return Err(secret_unavailable(
                    "BYOC Secret Manager reference points outside the configured project",
                ));
            }
            let client = reqwest::Client::new();
            let token = gcp_access_token(gcp, &client).await?;
            let url = format!("{}/{}:destroy", gcp.api_base, version_name);
            let response = client
                .post(url)
                .bearer_auth(token)
                .json(&json!({}))
                .send()
                .await
                .map_err(|err| {
                    secret_unavailable(format!("Secret Manager version destroy failed: {err}"))
                })?;
            if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
                Ok(())
            } else {
                Err(secret_unavailable(format!(
                    "Secret Manager version destroy failed with HTTP {}",
                    response.status()
                )))
            }
        }
    }
}

fn secret_unavailable(message: impl Into<String>) -> AppError {
    AppError::with_code(
        http::StatusCode::SERVICE_UNAVAILABLE,
        "secret_unavailable",
        message,
    )
}

async fn gcp_store_password(
    config: &GcpSecretManagerConfig,
    org_id: Uuid,
    password: &str,
) -> AppResult<String> {
    let client = reqwest::Client::new();
    let token = gcp_access_token(config, &client).await?;
    let secret_id = gcp_secret_id(&config.secret_prefix, org_id)?;
    create_gcp_secret_if_missing(config, &client, &token, &secret_id).await?;
    add_gcp_secret_version(config, &client, &token, &secret_id, password).await
}

async fn gcp_read_password(
    config: &GcpSecretManagerConfig,
    version_name: &str,
) -> AppResult<String> {
    if !version_name.starts_with(&format!("projects/{}/secrets/", config.project_id)) {
        return Err(secret_unavailable(
            "BYOC Secret Manager reference points outside the configured project",
        ));
    }
    let client = reqwest::Client::new();
    let token = gcp_access_token(config, &client).await?;
    let url = format!("{}/{}:access", config.api_base, version_name);
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|err| secret_unavailable(format!("Secret Manager read failed: {err}")))?;
    if !response.status().is_success() {
        return Err(secret_unavailable(format!(
            "Secret Manager read failed with HTTP {}",
            response.status()
        )));
    }
    let body = response
        .json::<GcpAccessSecretVersionResponse>()
        .await
        .map_err(|err| secret_unavailable(format!("Secret Manager response was invalid: {err}")))?;
    let bytes = general_purpose::STANDARD
        .decode(body.payload.data.as_bytes())
        .map_err(|_| secret_unavailable("Secret Manager payload was not valid base64"))?;
    String::from_utf8(bytes)
        .map_err(|_| secret_unavailable("Secret Manager payload was not valid UTF-8"))
}

async fn create_gcp_secret_if_missing(
    config: &GcpSecretManagerConfig,
    client: &reqwest::Client,
    token: &str,
    secret_id: &str,
) -> AppResult<()> {
    let url = format!(
        "{}/projects/{}/secrets?secretId={}",
        config.api_base, config.project_id, secret_id
    );
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&json!({ "replication": { "automatic": {} } }))
        .send()
        .await
        .map_err(|err| secret_unavailable(format!("Secret Manager create failed: {err}")))?;
    if response.status().is_success() || response.status() == StatusCode::CONFLICT {
        Ok(())
    } else {
        Err(secret_unavailable(format!(
            "Secret Manager create failed with HTTP {}",
            response.status()
        )))
    }
}

async fn add_gcp_secret_version(
    config: &GcpSecretManagerConfig,
    client: &reqwest::Client,
    token: &str,
    secret_id: &str,
    password: &str,
) -> AppResult<String> {
    let url = format!(
        "{}/projects/{}/secrets/{}:addVersion",
        config.api_base, config.project_id, secret_id
    );
    let payload = general_purpose::STANDARD.encode(password.as_bytes());
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&json!({ "payload": { "data": payload } }))
        .send()
        .await
        .map_err(|err| {
            secret_unavailable(format!("Secret Manager version create failed: {err}"))
        })?;
    if !response.status().is_success() {
        return Err(secret_unavailable(format!(
            "Secret Manager version create failed with HTTP {}",
            response.status()
        )));
    }
    let body = response
        .json::<GcpSecretVersionResponse>()
        .await
        .map_err(|err| secret_unavailable(format!("Secret Manager response was invalid: {err}")))?;
    Ok(body.name)
}

async fn gcp_access_token(
    config: &GcpSecretManagerConfig,
    client: &reqwest::Client,
) -> AppResult<String> {
    if let Some(token) = config.access_token.as_ref() {
        return Ok(token.clone());
    }
    let response = client
        .get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token")
        .header("Metadata-Flavor", "Google")
        .send()
        .await
        .map_err(|err| secret_unavailable(format!("metadata token fetch failed: {err}")))?;
    if !response.status().is_success() {
        return Err(secret_unavailable(format!(
            "metadata token fetch failed with HTTP {}",
            response.status()
        )));
    }
    let body = response
        .json::<GcpMetadataTokenResponse>()
        .await
        .map_err(|err| secret_unavailable(format!("metadata token response was invalid: {err}")))?;
    if body.access_token.trim().is_empty() {
        Err(secret_unavailable("metadata token response was empty"))
    } else {
        Ok(body.access_token)
    }
}

fn gcp_secret_id(prefix: &str, org_id: Uuid) -> AppResult<String> {
    let prefix = prefix.trim().trim_matches('-');
    if prefix.is_empty()
        || prefix.len() > 180
        || !prefix
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(AppError::config(
            "INSTANTML_BYOC_SECRET_PREFIX may only contain letters, numbers, dashes, and underscores",
        ));
    }
    Ok(format!("{prefix}-{}", org_id.simple()))
}

#[derive(Deserialize)]
struct GcpSecretVersionResponse {
    name: String,
}

#[derive(Deserialize)]
struct GcpAccessSecretVersionResponse {
    payload: GcpSecretPayload,
}

#[derive(Deserialize)]
struct GcpSecretPayload {
    data: String,
}

#[derive(Deserialize)]
struct GcpMetadataTokenResponse {
    access_token: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcp_secret_id_rejects_unsafe_prefixes() {
        let org_id = Uuid::nil();
        assert!(gcp_secret_id("instantml-byoc", org_id).is_ok());
        assert!(gcp_secret_id("../bad", org_id).is_err());
        assert!(gcp_secret_id("", org_id).is_err());
    }
}
