use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use reqwest::Method;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::fs::File;
use uuid::Uuid;

use crate::{
    config::{AppConfig, ArtifactBackend, R2ArtifactConfig},
    domain::ArtifactRow,
    errors::{AppError, AppResult},
};

#[derive(Clone, Debug)]
pub enum ArtifactByteStore {
    Local(LocalArtifactStore),
    R2(R2ArtifactStore),
}

#[derive(Clone, Debug)]
pub struct LocalArtifactStore {
    root: PathBuf,
}

#[derive(Clone, Debug)]
pub struct R2ArtifactStore {
    config: R2ArtifactConfig,
    client: reqwest::Client,
}

#[derive(Clone, Debug)]
pub struct StagedArtifact {
    pub tmp_path: PathBuf,
    pub final_path: PathBuf,
    pub storage_key: String,
    pub uri: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub struct StoredArtifact {
    pub id: Uuid,
    pub storage_backend: String,
    pub storage_key: String,
    pub storage_path: Option<String>,
    pub uri: String,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub struct PreparedArtifactBytes {
    bytes: Vec<u8>,
    pub size_bytes: i64,
    pub sha256: String,
}

pub enum ArtifactBytes {
    File(File),
    Http(reqwest::Response),
}

#[derive(Clone, Debug)]
struct R2Credentials {
    access_key_id: String,
    secret_access_key: String,
}

struct R2S3Request<'a> {
    method: Method,
    bucket: &'a str,
    object_key: &'a str,
    body: Option<Vec<u8>>,
    content_type: Option<&'a str>,
    payload_hash: String,
    range: Option<&'a str>,
}

impl ArtifactByteStore {
    pub fn for_upload(config: &AppConfig) -> AppResult<Self> {
        match config.artifact_backend {
            ArtifactBackend::Local => {
                Ok(Self::Local(LocalArtifactStore::new(&config.artifact_root)))
            }
            ArtifactBackend::R2 => Ok(Self::R2(R2ArtifactStore::new(
                config
                    .r2_artifacts
                    .clone()
                    .ok_or_else(|| AppError::config("R2 artifact storage is not configured"))?,
            ))),
        }
    }

    pub fn for_artifact(config: &AppConfig, artifact: &ArtifactRow) -> AppResult<Self> {
        match artifact.storage_backend.as_str() {
            "local" => Ok(Self::Local(LocalArtifactStore::new(&config.artifact_root))),
            "r2" => Ok(Self::R2(R2ArtifactStore::new(
                config
                    .r2_artifacts
                    .clone()
                    .ok_or_else(|| AppError::config("R2 artifact storage is not configured"))?,
            ))),
            _ => Err(AppError::not_found("artifact bytes not found")),
        }
    }

    pub async fn store_base64(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        mime_type: Option<&str>,
        content_base64: &str,
    ) -> AppResult<StoredArtifact> {
        let prepared = prepare_base64_artifact(content_base64)?;
        self.store_prepared(org_id, run_id, artifact_id, name, mime_type, prepared)
            .await
    }

    pub async fn store_prepared(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        mime_type: Option<&str>,
        prepared: PreparedArtifactBytes,
    ) -> AppResult<StoredArtifact> {
        match self {
            Self::Local(store) => {
                store
                    .store_prepared(org_id, run_id, artifact_id, name, prepared)
                    .await
            }
            Self::R2(store) => {
                store
                    .store_prepared(org_id, run_id, artifact_id, name, mime_type, prepared)
                    .await
            }
        }
    }

    pub async fn open(
        &self,
        artifact: &ArtifactRow,
        range: Option<&str>,
    ) -> AppResult<ArtifactBytes> {
        match self {
            Self::Local(store) => store.open(artifact).await.map(ArtifactBytes::File),
            Self::R2(store) => store.open(artifact, range).await.map(ArtifactBytes::Http),
        }
    }

    pub async fn cleanup(&self, stored: &StoredArtifact) {
        match self {
            Self::Local(store) => {
                if let Some(path) = stored
                    .storage_path
                    .as_ref()
                    .map(PathBuf::from)
                    .or_else(|| Some(store.root.join(&stored.storage_key)))
                {
                    store.cleanup(&path).await;
                }
            }
            Self::R2(store) => {
                store.cleanup(stored).await;
            }
        }
    }
}

impl LocalArtifactStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub async fn store_base64(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        content_base64: &str,
    ) -> AppResult<StoredArtifact> {
        self.store_prepared(
            org_id,
            run_id,
            artifact_id,
            name,
            prepare_base64_artifact(content_base64)?,
        )
        .await
    }

    pub async fn store_prepared(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        prepared: PreparedArtifactBytes,
    ) -> AppResult<StoredArtifact> {
        let staged = self
            .stage_prepared(org_id, run_id, artifact_id, name, prepared)
            .await?;
        if let Err(error) = self.finalize(&staged).await {
            self.cleanup(&staged.tmp_path).await;
            self.cleanup(&staged.final_path).await;
            return Err(error);
        }
        Ok(StoredArtifact {
            id: artifact_id,
            storage_backend: "local".to_string(),
            storage_key: staged.storage_key,
            storage_path: None,
            uri: staged.uri,
            size_bytes: staged.size_bytes,
            sha256: staged.sha256,
        })
    }

    pub async fn stage_base64(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        content_base64: &str,
    ) -> AppResult<StagedArtifact> {
        self.stage_prepared(
            org_id,
            run_id,
            artifact_id,
            name,
            prepare_base64_artifact(content_base64)?,
        )
        .await
    }

    pub async fn stage_prepared(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        prepared: PreparedArtifactBytes,
    ) -> AppResult<StagedArtifact> {
        let filename = sanitize_name(name);
        let storage_key = format!("{org_id}/{run_id}/{artifact_id}/{filename}");
        let final_path = self.root.join(&storage_key);
        let tmp_path = self
            .root
            .join("tmp")
            .join(format!("{artifact_id}-{filename}.tmp"));
        if let Some(parent) = tmp_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&tmp_path, prepared.bytes).await?;
        Ok(StagedArtifact {
            tmp_path,
            final_path,
            storage_key: storage_key.clone(),
            uri: format!("instantml://artifacts/{storage_key}"),
            size_bytes: prepared.size_bytes,
            sha256: prepared.sha256,
        })
    }

    pub async fn finalize(&self, staged: &StagedArtifact) -> AppResult<()> {
        if let Some(parent) = staged.final_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&staged.tmp_path, &staged.final_path).await?;
        Ok(())
    }

    pub async fn cleanup(&self, path: &Path) {
        let _ = tokio::fs::remove_file(path).await;
    }

    pub async fn open(&self, artifact: &ArtifactRow) -> AppResult<File> {
        let path = artifact_path(&self.root, artifact)?;
        let root = tokio::fs::canonicalize(&self.root)
            .await
            .map_err(|_| AppError::not_found("artifact bytes not found"))?;
        let target = tokio::fs::canonicalize(&path)
            .await
            .map_err(|_| AppError::not_found("artifact bytes not found"))?;
        if !is_within_root(&root, &target) {
            return Err(AppError::not_found("artifact bytes not found"));
        }
        File::open(target)
            .await
            .map_err(|_| AppError::not_found("artifact bytes not found"))
    }
}

impl R2ArtifactStore {
    pub fn new(config: R2ArtifactConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    pub async fn store_base64(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        mime_type: Option<&str>,
        content_base64: &str,
    ) -> AppResult<StoredArtifact> {
        self.store_prepared(
            org_id,
            run_id,
            artifact_id,
            name,
            mime_type,
            prepare_base64_artifact(content_base64)?,
        )
        .await
    }

    pub async fn store_prepared(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        mime_type: Option<&str>,
        prepared: PreparedArtifactBytes,
    ) -> AppResult<StoredArtifact> {
        let bucket = r2_bucket_name(&self.config.bucket_prefix, org_id);
        let object_key = r2_object_key(run_id, artifact_id, name);
        self.ensure_bucket(&bucket).await?;
        self.put_object(
            &bucket,
            &object_key,
            prepared.bytes,
            mime_type.unwrap_or("application/octet-stream"),
        )
        .await?;
        let storage_key = format!("{bucket}/{object_key}");
        Ok(StoredArtifact {
            id: artifact_id,
            storage_backend: "r2".to_string(),
            storage_key: storage_key.clone(),
            storage_path: Some(format!("r2://{storage_key}")),
            uri: format!("instantml://artifacts/{storage_key}"),
            size_bytes: prepared.size_bytes,
            sha256: prepared.sha256,
        })
    }

    pub async fn open(
        &self,
        artifact: &ArtifactRow,
        range: Option<&str>,
    ) -> AppResult<reqwest::Response> {
        let storage_key = artifact
            .storage_key
            .as_deref()
            .or_else(|| artifact.storage_path.as_deref().and_then(strip_r2_scheme))
            .ok_or_else(|| AppError::not_found("artifact bytes not found"))?;
        let (bucket, object_key) = split_r2_storage_key(storage_key)?;
        self.get_object(bucket, object_key, range).await
    }

    pub async fn cleanup(&self, stored: &StoredArtifact) {
        let Ok((bucket, object_key)) = split_r2_storage_key(&stored.storage_key) else {
            return;
        };
        let _ = self.delete_object(bucket, object_key).await;
    }

    async fn ensure_bucket(&self, bucket: &str) -> AppResult<()> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/r2/buckets/{}",
            self.config.account_id, bucket
        );
        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.config.api_token)
            .send()
            .await
            .map_err(|err| {
                AppError::service_unavailable(format!("R2 bucket check failed: {err}"))
            })?;
        if response.status().is_success() {
            return Ok(());
        }
        if response.status() != StatusCode::NOT_FOUND {
            return Err(cloudflare_api_error("R2 bucket check", response).await);
        }

        let create_url = format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/r2/buckets",
            self.config.account_id
        );
        let response = self
            .client
            .post(create_url)
            .bearer_auth(&self.config.api_token)
            .json(&json!({ "name": bucket }))
            .send()
            .await
            .map_err(|err| {
                AppError::service_unavailable(format!("R2 bucket creation failed: {err}"))
            })?;
        if response.status().is_success() || response.status() == StatusCode::CONFLICT {
            return Ok(());
        }
        Err(cloudflare_api_error("R2 bucket creation", response).await)
    }

    async fn put_object(
        &self,
        bucket: &str,
        object_key: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> AppResult<()> {
        let payload_hash = hex_sha256(&bytes);
        let response = self
            .signed_s3_request(R2S3Request {
                method: Method::PUT,
                bucket,
                object_key,
                body: Some(bytes),
                content_type: Some(content_type),
                payload_hash,
                range: None,
            })
            .await?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(r2_object_error("R2 object upload", response).await)
    }

    async fn get_object(
        &self,
        bucket: &str,
        object_key: &str,
        range: Option<&str>,
    ) -> AppResult<reqwest::Response> {
        let response = self
            .signed_s3_request(R2S3Request {
                method: Method::GET,
                bucket,
                object_key,
                body: None,
                content_type: None,
                payload_hash: hex_sha256(&[]),
                range,
            })
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(AppError::not_found("artifact bytes not found"));
        }
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
            return Err(AppError::new(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "artifact byte range not satisfiable",
            ));
        }
        if !response.status().is_success() {
            return Err(r2_object_error("R2 object download", response).await);
        }
        Ok(response)
    }

    async fn delete_object(&self, bucket: &str, object_key: &str) -> AppResult<()> {
        let response = self
            .signed_s3_request(R2S3Request {
                method: Method::DELETE,
                bucket,
                object_key,
                body: None,
                content_type: None,
                payload_hash: hex_sha256(&[]),
                range: None,
            })
            .await?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(r2_object_error("R2 object cleanup", response).await)
    }

    async fn signed_s3_request(&self, request: R2S3Request<'_>) -> AppResult<reqwest::Response> {
        let credentials = self.credentials().await?;
        let endpoint = self.config.endpoint.trim_end_matches('/');
        let host = url::Url::parse(endpoint)
            .map_err(|err| AppError::config(format!("CLOUDFLARE_R2_ENDPOINT is invalid: {err}")))?
            .host_str()
            .ok_or_else(|| AppError::config("CLOUDFLARE_R2_ENDPOINT must include a host"))?
            .to_string();
        let canonical_uri = format!("/{}/{}", request.bucket, request.object_key);
        let url = format!("{endpoint}{canonical_uri}");
        let now = Utc::now();
        let signed = sign_r2_request(
            request.method.as_str(),
            &host,
            &canonical_uri,
            request.content_type,
            &request.payload_hash,
            &credentials,
            now,
        );
        let mut builder = match request.method {
            Method::PUT => self.client.put(url),
            Method::GET => self.client.get(url),
            Method::DELETE => self.client.delete(url),
            _ => return Err(AppError::internal("unsupported R2 method")),
        }
        .header("host", host)
        .header("x-amz-date", signed.amz_date)
        .header("x-amz-content-sha256", request.payload_hash)
        .header("authorization", signed.authorization);
        if let Some(content_type) = request.content_type {
            builder = builder.header("content-type", content_type);
        }
        if let Some(range) = request.range {
            builder = builder.header(reqwest::header::RANGE, range);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        builder.send().await.map_err(|err| {
            AppError::service_unavailable(format!("R2 object request failed: {err}"))
        })
    }

    async fn credentials(&self) -> AppResult<R2Credentials> {
        let secret_access_key = self
            .config
            .secret_access_key
            .clone()
            .unwrap_or_else(|| hex_sha256(self.config.api_token.as_bytes()));
        if let Some(access_key_id) = &self.config.access_key_id {
            return Ok(R2Credentials {
                access_key_id: access_key_id.clone(),
                secret_access_key,
            });
        }
        let token_id = self.verify_token_id().await?;
        Ok(R2Credentials {
            access_key_id: token_id,
            secret_access_key,
        })
    }

    async fn verify_token_id(&self) -> AppResult<String> {
        let response = self
            .client
            .get("https://api.cloudflare.com/client/v4/user/tokens/verify")
            .bearer_auth(&self.config.api_token)
            .send()
            .await
            .map_err(|err| {
                AppError::service_unavailable(format!(
                    "Cloudflare token verification failed: {err}"
                ))
            })?;
        if !response.status().is_success() {
            return Err(cloudflare_api_error("Cloudflare token verification", response).await);
        }
        let body: CloudflareTokenVerifyResponse = response.json().await.map_err(|err| {
            AppError::internal(format!("Cloudflare token response failed: {err}"))
        })?;
        body.result
            .and_then(|result| result.id)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                AppError::config("Cloudflare token verification did not return a token id")
            })
    }
}

#[derive(Debug, Deserialize)]
struct CloudflareTokenVerifyResponse {
    result: Option<CloudflareTokenVerifyResult>,
}

#[derive(Debug, Deserialize)]
struct CloudflareTokenVerifyResult {
    id: Option<String>,
}

#[derive(Debug)]
struct SignedRequest {
    amz_date: String,
    authorization: String,
}

fn artifact_path(root: &Path, artifact: &ArtifactRow) -> AppResult<PathBuf> {
    if let Some(storage_key) = artifact.storage_key.as_ref() {
        return Ok(root.join(storage_key));
    }
    artifact
        .storage_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::not_found("artifact bytes not found"))
}

fn is_within_root(root: &Path, target: &Path) -> bool {
    target == root || target.starts_with(root)
}

pub fn prepare_base64_artifact(content_base64: &str) -> AppResult<PreparedArtifactBytes> {
    let bytes = STANDARD
        .decode(content_base64.as_bytes())
        .map_err(|_| AppError::validation("content_base64 must be valid base64"))?;
    if bytes.is_empty() {
        return Err(AppError::validation("content_base64 must decode to bytes"));
    }
    let size_bytes =
        i64::try_from(bytes.len()).map_err(|_| AppError::validation("artifact is too large"))?;
    let sha256 = hex_sha256(&bytes);
    Ok(PreparedArtifactBytes {
        bytes,
        size_bytes,
        sha256,
    })
}

fn sanitize_name(name: &str) -> String {
    let value = Path::new(name)
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("artifact");
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "artifact".to_string()
    } else {
        sanitized
    }
}

fn r2_object_key(run_id: Uuid, artifact_id: Uuid, name: &str) -> String {
    format!(
        "runs/{run_id}/artifacts/{artifact_id}/{}",
        sanitize_name(name)
    )
}

fn r2_bucket_name(prefix: &str, org_id: Uuid) -> String {
    let mut prefix = prefix
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    prefix = prefix.trim_matches('-').to_string();
    if prefix.is_empty() {
        prefix = "instantml-org".to_string();
    }
    let suffix = org_id.simple().to_string();
    let max_prefix_len = 63usize.saturating_sub(suffix.len() + 1);
    if prefix.len() > max_prefix_len {
        prefix.truncate(max_prefix_len);
        prefix = prefix.trim_matches('-').to_string();
    }
    if prefix.len() < 3 {
        prefix = "instantml-org".to_string();
    }
    format!("{prefix}-{suffix}")
}

fn split_r2_storage_key(storage_key: &str) -> AppResult<(&str, &str)> {
    let key = strip_r2_scheme(storage_key).unwrap_or(storage_key);
    let (bucket, object_key) = key
        .split_once('/')
        .ok_or_else(|| AppError::not_found("artifact bytes not found"))?;
    if bucket.is_empty() || object_key.is_empty() {
        return Err(AppError::not_found("artifact bytes not found"));
    }
    Ok((bucket, object_key))
}

fn strip_r2_scheme(value: &str) -> Option<&str> {
    value.strip_prefix("r2://")
}

fn sign_r2_request(
    method: &str,
    host: &str,
    canonical_uri: &str,
    content_type: Option<&str>,
    payload_hash: &str,
    credentials: &R2Credentials,
    now: DateTime<Utc>,
) -> SignedRequest {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let mut canonical_headers = String::new();
    let mut signed_headers = Vec::new();
    if let Some(content_type) = content_type {
        canonical_headers.push_str(&format!("content-type:{content_type}\n"));
        signed_headers.push("content-type");
    }
    canonical_headers.push_str(&format!("host:{host}\n"));
    canonical_headers.push_str(&format!("x-amz-content-sha256:{payload_hash}\n"));
    canonical_headers.push_str(&format!("x-amz-date:{amz_date}\n"));
    signed_headers.extend(["host", "x-amz-content-sha256", "x-amz-date"]);
    let signed_headers = signed_headers.join(";");
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let scope = format!("{date_stamp}/auto/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex_sha256(canonical_request.as_bytes())
    );
    let signing_key = aws_signing_key(&credentials.secret_access_key, &date_stamp);
    let signature = hex_bytes(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    SignedRequest {
        amz_date,
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            credentials.access_key_id
        ),
    }
}

fn aws_signing_key(secret: &str, date_stamp: &str) -> [u8; 32] {
    let date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
    let region = hmac_sha256(&date, b"auto");
    let service = hmac_sha256(&region, b"s3");
    hmac_sha256(&service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let digest = Sha256::digest(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut outer = [0x5c; BLOCK_SIZE];
    let mut inner = [0x36; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        outer[i] ^= key_block[i];
        inner[i] ^= key_block[i];
    }
    let mut inner_hash = Sha256::new();
    inner_hash.update(inner);
    inner_hash.update(data);
    let inner_digest = inner_hash.finalize();

    let mut outer_hash = Sha256::new();
    outer_hash.update(outer);
    outer_hash.update(inner_digest);
    let digest = outer_hash.finalize();
    let mut output = [0u8; 32];
    output.copy_from_slice(&digest);
    output
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex_bytes(Sha256::digest(bytes))
}

fn hex_bytes(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

async fn cloudflare_api_error(operation: &str, response: reqwest::Response) -> AppError {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
        return AppError::service_unavailable(format!(
            "{operation} provider authorization failed: {}",
            safe_error_excerpt(&text)
        ));
    }
    AppError::service_unavailable(format!(
        "{operation} failed with status {status}: {}",
        safe_error_excerpt(&text)
    ))
}

async fn r2_object_error(operation: &str, response: reqwest::Response) -> AppError {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
        return AppError::service_unavailable(format!(
            "{operation} provider authorization failed: {}",
            safe_error_excerpt(&text)
        ));
    }
    AppError::service_unavailable(format!(
        "{operation} failed with status {status}: {}",
        safe_error_excerpt(&text)
    ))
}

fn safe_error_excerpt(text: &str) -> String {
    text.chars().take(240).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn r2_bucket_names_are_valid_and_deterministic() {
        let org_id = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        assert_eq!(
            r2_bucket_name("InstantML Org", org_id),
            "instantml-org-00000000000000000000000000000001"
        );
        let long = r2_bucket_name(
            "this-prefix-is-far-too-long-for-r2-bucket-names-and-gets-trimmed",
            org_id,
        );
        assert!(long.len() <= 63);
        assert!(long.ends_with("00000000000000000000000000000001"));
    }

    #[test]
    fn r2_object_key_uses_sanitized_basename() {
        let run_id = Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap();
        let artifact_id = Uuid::parse_str("00000000-0000-0000-0000-000000000003").unwrap();
        assert_eq!(
            r2_object_key(run_id, artifact_id, "../frames/sample image.png"),
            "runs/00000000-0000-0000-0000-000000000002/artifacts/00000000-0000-0000-0000-000000000003/sample_image.png"
        );
    }

    #[test]
    fn split_r2_key_accepts_plain_or_uri_form() {
        assert_eq!(
            split_r2_storage_key("bucket/runs/1/file.txt").unwrap(),
            ("bucket", "runs/1/file.txt")
        );
        assert_eq!(
            split_r2_storage_key("r2://bucket/runs/1/file.txt").unwrap(),
            ("bucket", "runs/1/file.txt")
        );
        assert!(split_r2_storage_key("bucket-only").is_err());
    }

    #[test]
    fn r2_signing_is_stable_for_fixed_inputs() {
        let credentials = R2Credentials {
            access_key_id: "token-id".to_string(),
            secret_access_key: "secret".to_string(),
        };
        let signed = sign_r2_request(
            "PUT",
            "example.r2.cloudflarestorage.com",
            "/bucket/runs/1/file.txt",
            Some("text/plain"),
            &hex_sha256(b"hello"),
            &credentials,
            Utc.with_ymd_and_hms(2026, 5, 21, 12, 0, 0)
                .single()
                .unwrap(),
        );
        assert_eq!(signed.amz_date, "20260521T120000Z");
        assert!(signed
            .authorization
            .contains("Credential=token-id/20260521/auto/s3/aws4_request"));
        assert!(signed
            .authorization
            .contains("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"));
        assert!(signed.authorization.contains("Signature="));
    }
}
