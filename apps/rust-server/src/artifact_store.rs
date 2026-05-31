use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

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
    query: Option<&'a str>,
    body: Option<Vec<u8>>,
    content_type: Option<&'a str>,
    payload_hash: String,
    range: Option<&'a str>,
}

#[derive(Clone, Debug)]
pub struct VersionedUploadTarget {
    pub storage_backend: String,
    pub storage_key: String,
    pub storage_path: Option<String>,
    pub multipart_upload_id: Option<String>,
    pub part_size_bytes: i64,
    pub part_count: i64,
    pub upload_kind: String,
    pub parts: Vec<PresignedUploadPart>,
}

#[derive(Clone, Debug)]
pub struct PresignedUploadPart {
    pub part_number: i64,
    pub url: String,
    pub expires_at: DateTime<Utc>,
    pub required_headers: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug)]
pub struct RenewVersionedUploadPartsRequest<'a> {
    pub storage_key: &'a str,
    pub multipart_upload_id: Option<&'a str>,
    pub start_part_number: i64,
    pub part_count: i64,
    pub part_size_bytes: i64,
    pub expected_size_bytes: i64,
    pub expected_part_count: i64,
    pub expires_seconds: i64,
}

#[derive(Clone, Copy, Debug)]
struct MultipartPartPresignRequest<'a> {
    bucket: &'a str,
    object_key: &'a str,
    upload_id: &'a str,
    start_part_number: i64,
    part_count: i64,
    part_size_bytes: i64,
    expected_size_bytes: i64,
    expected_part_count: i64,
    expires_seconds: i64,
}

struct PresignedR2QueryInput<'a> {
    method: &'a str,
    host: &'a str,
    canonical_uri: &'a str,
    extra_query: &'a str,
    required_headers: &'a BTreeMap<String, String>,
    expires_seconds: i64,
    credentials: &'a R2Credentials,
    now: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct CompletedUploadPart {
    pub part_number: i64,
    pub etag: String,
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

    pub async fn create_versioned_upload_target(
        &self,
        org_id: Uuid,
        artifact_version_id: Uuid,
        entry_id: Uuid,
        size_bytes: i64,
        mime_type: Option<&str>,
    ) -> AppResult<VersionedUploadTarget> {
        match self {
            Self::Local(_store) => {
                let storage_key =
                    local_versioned_storage_key(org_id, artifact_version_id, entry_id);
                Ok(VersionedUploadTarget {
                    storage_backend: "local".to_string(),
                    storage_key,
                    storage_path: None,
                    multipart_upload_id: None,
                    part_size_bytes: size_bytes.max(1),
                    part_count: 1,
                    upload_kind: "inline".to_string(),
                    parts: Vec::new(),
                })
            }
            Self::R2(store) => {
                store
                    .create_versioned_upload_target(
                        org_id,
                        artifact_version_id,
                        entry_id,
                        size_bytes,
                        mime_type,
                    )
                    .await
            }
        }
    }

    pub async fn renew_versioned_upload_parts(
        &self,
        request: RenewVersionedUploadPartsRequest<'_>,
    ) -> AppResult<Vec<PresignedUploadPart>> {
        match self {
            Self::Local(_) => Ok(Vec::new()),
            Self::R2(store) => store.renew_versioned_upload_parts(request).await,
        }
    }

    pub async fn complete_versioned_upload(
        &self,
        storage_key: &str,
        multipart_upload_id: Option<&str>,
        parts: &[CompletedUploadPart],
        expected_size_bytes: i64,
        expected_part_count: i64,
        expected_sha256: &str,
    ) -> AppResult<()> {
        match self {
            Self::Local(_) => Ok(()),
            Self::R2(store) => {
                store
                    .complete_versioned_upload(
                        storage_key,
                        multipart_upload_id,
                        parts,
                        expected_size_bytes,
                        expected_part_count,
                        expected_sha256,
                    )
                    .await
            }
        }
    }

    pub async fn abort_versioned_upload(
        &self,
        storage_key: &str,
        multipart_upload_id: Option<&str>,
    ) -> AppResult<()> {
        match self {
            Self::Local(store) => store.abort_versioned_upload(storage_key).await,
            Self::R2(store) => {
                store
                    .abort_versioned_upload(storage_key, multipart_upload_id)
                    .await
            }
        }
    }

    pub async fn store_versioned_inline_base64(
        &self,
        org_id: Uuid,
        storage_key: &str,
        content_base64: &str,
    ) -> AppResult<StoredArtifact> {
        match self {
            Self::Local(store) => {
                store
                    .store_versioned_prepared(
                        org_id,
                        storage_key,
                        prepare_base64_artifact(content_base64)?,
                    )
                    .await
            }
            Self::R2(_) => Err(AppError::validation(
                "inline artifact upload is only available for local artifact storage",
            )),
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

    pub async fn store_versioned_prepared(
        &self,
        _org_id: Uuid,
        storage_key: &str,
        prepared: PreparedArtifactBytes,
    ) -> AppResult<StoredArtifact> {
        let final_path = self.root.join(storage_key);
        let tmp_path = self
            .root
            .join("tmp")
            .join(format!("{}.tmp", storage_key.replace('/', "-")));
        if let Some(parent) = tmp_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&tmp_path, prepared.bytes).await?;
        let staged = StagedArtifact {
            tmp_path,
            final_path,
            storage_key: storage_key.to_string(),
            uri: format!("instantml://artifact-entries/{storage_key}"),
            size_bytes: prepared.size_bytes,
            sha256: prepared.sha256,
        };
        if let Err(error) = self.finalize(&staged).await {
            self.cleanup(&staged.tmp_path).await;
            self.cleanup(&staged.final_path).await;
            return Err(error);
        }
        Ok(StoredArtifact {
            id: Uuid::new_v4(),
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

    async fn abort_versioned_upload(&self, storage_key: &str) -> AppResult<()> {
        self.cleanup(&self.root.join(storage_key)).await;
        Ok(())
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

    pub async fn create_versioned_upload_target(
        &self,
        org_id: Uuid,
        artifact_version_id: Uuid,
        entry_id: Uuid,
        size_bytes: i64,
        mime_type: Option<&str>,
    ) -> AppResult<VersionedUploadTarget> {
        let bucket = r2_bucket_name(&self.config.bucket_prefix, org_id);
        let object_key = r2_versioned_object_key(artifact_version_id, entry_id);
        self.ensure_bucket(&bucket).await?;
        let storage_key = format!("{bucket}/{object_key}");
        let part_size_bytes = default_part_size(size_bytes);
        let part_count = div_ceil_i64(size_bytes.max(1), part_size_bytes);
        let upload_id = self
            .create_multipart_upload(&bucket, &object_key, mime_type)
            .await?;
        let parts = self
            .presign_multipart_parts(MultipartPartPresignRequest {
                bucket: &bucket,
                object_key: &object_key,
                upload_id: &upload_id,
                start_part_number: 1,
                part_count: part_count.min(256),
                part_size_bytes,
                expected_size_bytes: size_bytes,
                expected_part_count: part_count,
                expires_seconds: 15 * 60,
            })
            .await?;
        Ok(VersionedUploadTarget {
            storage_backend: "r2".to_string(),
            storage_key: storage_key.clone(),
            storage_path: Some(format!("r2://{storage_key}")),
            multipart_upload_id: Some(upload_id),
            part_size_bytes,
            part_count,
            upload_kind: "multipart".to_string(),
            parts,
        })
    }

    async fn renew_versioned_upload_parts(
        &self,
        request: RenewVersionedUploadPartsRequest<'_>,
    ) -> AppResult<Vec<PresignedUploadPart>> {
        let (bucket, object_key) = split_r2_storage_key(request.storage_key)?;
        let expires_seconds = request.expires_seconds.clamp(60, 60 * 60);
        if let Some(upload_id) = request.multipart_upload_id {
            return self
                .presign_multipart_parts(MultipartPartPresignRequest {
                    bucket,
                    object_key,
                    upload_id,
                    start_part_number: request.start_part_number,
                    part_count: request.part_count,
                    part_size_bytes: request.part_size_bytes,
                    expected_size_bytes: request.expected_size_bytes,
                    expected_part_count: request.expected_part_count,
                    expires_seconds,
                })
                .await;
        }
        Err(AppError::validation(
            "R2 artifact uploads require multipart upload sessions",
        ))
    }

    async fn complete_versioned_upload(
        &self,
        storage_key: &str,
        multipart_upload_id: Option<&str>,
        parts: &[CompletedUploadPart],
        expected_size_bytes: i64,
        expected_part_count: i64,
        expected_sha256: &str,
    ) -> AppResult<()> {
        let (bucket, object_key) = split_r2_storage_key(storage_key)?;
        let Some(upload_id) = multipart_upload_id else {
            return Err(AppError::validation(
                "R2 artifact completion requires a multipart upload id",
            ));
        };
        validate_completed_multipart_parts(parts, expected_part_count)?;
        let body = multipart_complete_xml(parts)?;
        let payload_hash = hex_sha256(body.as_bytes());
        let query = format!("uploadId={}", percent_encode_query_value(upload_id));
        let response = self
            .signed_s3_request(R2S3Request {
                method: Method::POST,
                bucket,
                object_key,
                query: Some(&query),
                body: Some(body.into_bytes()),
                content_type: Some("application/xml"),
                payload_hash,
                range: None,
            })
            .await?;
        if response.status().is_success() {
            self.ensure_object_size(bucket, object_key, expected_size_bytes, expected_sha256)
                .await?;
            return Ok(());
        }
        if self
            .ensure_object_size(bucket, object_key, expected_size_bytes, expected_sha256)
            .await
            .is_ok()
        {
            return Ok(());
        }
        Err(r2_object_error("R2 multipart completion", response).await)
    }

    async fn abort_versioned_upload(
        &self,
        storage_key: &str,
        multipart_upload_id: Option<&str>,
    ) -> AppResult<()> {
        let (bucket, object_key) = split_r2_storage_key(storage_key)?;
        if let Some(upload_id) = multipart_upload_id {
            let abort_result = self
                .abort_multipart_upload(bucket, object_key, upload_id)
                .await;
            let delete_result = self.delete_object(bucket, object_key).await;
            if let Err(error) = abort_result {
                delete_result?;
                return Err(error);
            }
            delete_result?;
            return Ok(());
        }
        self.delete_object(bucket, object_key).await
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
                query: None,
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
                query: None,
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

    async fn ensure_object_size(
        &self,
        bucket: &str,
        object_key: &str,
        expected_size_bytes: i64,
        _expected_sha256: &str,
    ) -> AppResult<()> {
        let response = self.head_object(bucket, object_key).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(AppError::validation(
                "uploaded artifact object was not found in storage",
            ));
        }
        if !response.status().is_success() {
            return Err(r2_object_error("R2 object verification", response).await);
        }
        let actual_size = response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<i64>().ok())
            .ok_or_else(|| {
                AppError::service_unavailable("R2 object verification returned no content length")
            })?;
        if actual_size != expected_size_bytes {
            return Err(AppError::validation(
                "uploaded artifact object size did not match manifest",
            ));
        }
        Ok(())
    }

    async fn head_object(&self, bucket: &str, object_key: &str) -> AppResult<reqwest::Response> {
        let response = self
            .signed_s3_request(R2S3Request {
                method: Method::HEAD,
                bucket,
                object_key,
                query: None,
                body: None,
                content_type: None,
                payload_hash: hex_sha256(&[]),
                range: None,
            })
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(AppError::not_found("artifact bytes not found"));
        }
        if !response.status().is_success() {
            return Err(r2_object_error("R2 object verification", response).await);
        }
        Ok(response)
    }

    async fn delete_object(&self, bucket: &str, object_key: &str) -> AppResult<()> {
        let response = self
            .signed_s3_request(R2S3Request {
                method: Method::DELETE,
                bucket,
                object_key,
                query: None,
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

    async fn abort_multipart_upload(
        &self,
        bucket: &str,
        object_key: &str,
        upload_id: &str,
    ) -> AppResult<()> {
        let query = format!("uploadId={}", percent_encode_query_value(upload_id));
        let response = self
            .signed_s3_request(R2S3Request {
                method: Method::DELETE,
                bucket,
                object_key,
                query: Some(&query),
                body: None,
                content_type: None,
                payload_hash: hex_sha256(&[]),
                range: None,
            })
            .await?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(r2_object_error("R2 multipart abort", response).await)
    }

    async fn create_multipart_upload(
        &self,
        bucket: &str,
        object_key: &str,
        mime_type: Option<&str>,
    ) -> AppResult<String> {
        let response = self
            .signed_s3_request(R2S3Request {
                method: Method::POST,
                bucket,
                object_key,
                query: Some("uploads="),
                body: None,
                content_type: mime_type,
                payload_hash: hex_sha256(&[]),
                range: None,
            })
            .await?;
        if !response.status().is_success() {
            return Err(r2_object_error("R2 multipart initiation", response).await);
        }
        let body = response.text().await.map_err(|err| {
            AppError::service_unavailable(format!("R2 multipart initiation failed: {err}"))
        })?;
        xml_tag_text(&body, "UploadId")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AppError::service_unavailable("R2 multipart initiation returned no upload id")
            })
    }

    async fn presign_multipart_parts(
        &self,
        request: MultipartPartPresignRequest<'_>,
    ) -> AppResult<Vec<PresignedUploadPart>> {
        if request.start_part_number < 1 || !(1..=256).contains(&request.part_count) {
            return Err(AppError::validation(
                "part range must start at 1 or higher and include 1-256 parts",
            ));
        }
        if request.expected_part_count <= 0
            || request.start_part_number + request.part_count - 1 > request.expected_part_count
            || request.part_size_bytes <= 0
            || request.expected_size_bytes < 0
        {
            return Err(AppError::validation(
                "invalid artifact multipart part range",
            ));
        }
        let expires_at = Utc::now() + chrono::Duration::seconds(request.expires_seconds);
        let mut parts = Vec::new();
        for part_number in request.start_part_number..request.start_part_number + request.part_count
        {
            let query = format!(
                "partNumber={part_number}&uploadId={}",
                percent_encode_query_value(request.upload_id)
            );
            let mut required_headers = BTreeMap::new();
            required_headers.insert(
                "content-length".to_string(),
                expected_part_size(
                    part_number,
                    request.part_size_bytes,
                    request.expected_size_bytes,
                    request.expected_part_count,
                )?
                .to_string(),
            );
            parts.push(PresignedUploadPart {
                part_number,
                url: self
                    .presign_s3_url(
                        Method::PUT,
                        request.bucket,
                        request.object_key,
                        Some(&query),
                        &required_headers,
                        request.expires_seconds,
                    )
                    .await?,
                expires_at,
                required_headers,
            });
        }
        Ok(parts)
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
        let url = if let Some(query) = request.query {
            format!("{endpoint}{canonical_uri}?{query}")
        } else {
            format!("{endpoint}{canonical_uri}")
        };
        let now = Utc::now();
        let signed = sign_r2_request(R2SigningRequest {
            method: request.method.as_str(),
            host: &host,
            canonical_uri: &canonical_uri,
            canonical_query: request.query.unwrap_or(""),
            content_type: request.content_type,
            payload_hash: &request.payload_hash,
            credentials: &credentials,
            now,
        });
        let mut builder = match request.method {
            Method::PUT => self.client.put(url),
            Method::GET => self.client.get(url),
            Method::HEAD => self.client.head(url),
            Method::POST => self.client.post(url),
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

    async fn presign_s3_url(
        &self,
        method: Method,
        bucket: &str,
        object_key: &str,
        query: Option<&str>,
        required_headers: &BTreeMap<String, String>,
        expires_seconds: i64,
    ) -> AppResult<String> {
        let credentials = self.credentials().await?;
        let endpoint = self.config.endpoint.trim_end_matches('/');
        let host = url::Url::parse(endpoint)
            .map_err(|err| AppError::config(format!("CLOUDFLARE_R2_ENDPOINT is invalid: {err}")))?
            .host_str()
            .ok_or_else(|| AppError::config("CLOUDFLARE_R2_ENDPOINT must include a host"))?
            .to_string();
        let canonical_uri = format!("/{}/{}", bucket, object_key);
        let now = Utc::now();
        let presigned_query = presigned_r2_query(PresignedR2QueryInput {
            method: method.as_str(),
            host: &host,
            canonical_uri: &canonical_uri,
            extra_query: query.unwrap_or(""),
            required_headers,
            expires_seconds,
            credentials: &credentials,
            now,
        });
        let separator = if presigned_query.is_empty() { "" } else { "?" };
        Ok(format!(
            "{endpoint}{canonical_uri}{separator}{presigned_query}"
        ))
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

pub fn local_versioned_storage_key(
    org_id: Uuid,
    artifact_version_id: Uuid,
    entry_id: Uuid,
) -> String {
    format!("orgs/{org_id}/artifact-versions/{artifact_version_id}/{entry_id}")
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

fn r2_versioned_object_key(_artifact_version_id: Uuid, _entry_id: Uuid) -> String {
    format!("artifact-blobs/{}", Uuid::new_v4().simple())
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

struct R2SigningRequest<'a> {
    method: &'a str,
    host: &'a str,
    canonical_uri: &'a str,
    canonical_query: &'a str,
    content_type: Option<&'a str>,
    payload_hash: &'a str,
    credentials: &'a R2Credentials,
    now: DateTime<Utc>,
}

fn sign_r2_request(input: R2SigningRequest<'_>) -> SignedRequest {
    let amz_date = input.now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = input.now.format("%Y%m%d").to_string();
    let mut canonical_headers = String::new();
    let mut signed_headers = Vec::new();
    if let Some(content_type) = input.content_type {
        canonical_headers.push_str(&format!("content-type:{content_type}\n"));
        signed_headers.push("content-type");
    }
    canonical_headers.push_str(&format!("host:{}\n", input.host));
    canonical_headers.push_str(&format!("x-amz-content-sha256:{}\n", input.payload_hash));
    canonical_headers.push_str(&format!("x-amz-date:{amz_date}\n"));
    signed_headers.extend(["host", "x-amz-content-sha256", "x-amz-date"]);
    let signed_headers = signed_headers.join(";");
    let canonical_request = format!(
        "{}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{}",
        input.method, input.canonical_uri, input.canonical_query, input.payload_hash
    );
    let scope = format!("{date_stamp}/auto/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex_sha256(canonical_request.as_bytes())
    );
    let signing_key = aws_signing_key(&input.credentials.secret_access_key, &date_stamp);
    let signature = hex_bytes(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    SignedRequest {
        amz_date,
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            input.credentials.access_key_id
        ),
    }
}

fn presigned_r2_query(input: PresignedR2QueryInput<'_>) -> String {
    let amz_date = input.now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = input.now.format("%Y%m%d").to_string();
    let scope = format!("{date_stamp}/auto/s3/aws4_request");
    let mut params = Vec::new();
    for pair in input.extra_query.split('&').filter(|part| !part.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.push((key.to_string(), value.to_string()));
    }
    let mut signed_header_names = vec!["host".to_string()];
    signed_header_names.extend(
        input
            .required_headers
            .keys()
            .map(|key| key.to_ascii_lowercase()),
    );
    signed_header_names.sort();
    let signed_headers = signed_header_names.join(";");
    params.extend([
        (
            "X-Amz-Algorithm".to_string(),
            "AWS4-HMAC-SHA256".to_string(),
        ),
        (
            "X-Amz-Credential".to_string(),
            percent_encode_query_value(&format!("{}/{}", input.credentials.access_key_id, scope)),
        ),
        ("X-Amz-Date".to_string(), amz_date.clone()),
        (
            "X-Amz-Expires".to_string(),
            input.expires_seconds.clamp(60, 60 * 60).to_string(),
        ),
        ("X-Amz-SignedHeaders".to_string(), signed_headers.clone()),
    ]);
    params.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let canonical_query = params
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode_query_value(key), value))
        .collect::<Vec<_>>()
        .join("&");
    let mut canonical_headers = String::new();
    for header in &signed_header_names {
        if header == "host" {
            canonical_headers.push_str(&format!("host:{}\n", input.host));
        } else if let Some(value) = input.required_headers.get(header) {
            canonical_headers.push_str(&format!("{header}:{}\n", value.trim()));
        }
    }
    let canonical_request = format!(
        "{}\n{}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\nUNSIGNED-PAYLOAD",
        input.method, input.canonical_uri
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex_sha256(canonical_request.as_bytes())
    );
    let signing_key = aws_signing_key(&input.credentials.secret_access_key, &date_stamp);
    let signature = hex_bytes(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    format!("{canonical_query}&X-Amz-Signature={signature}")
}

fn percent_encode_query_value(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn default_part_size(size_bytes: i64) -> i64 {
    const DEFAULT: i64 = 64 * 1024 * 1024;
    if size_bytes <= 0 {
        return DEFAULT;
    }
    let min_for_limit = div_ceil_i64(size_bytes, 10_000).max(5 * 1024 * 1024);
    DEFAULT.max(min_for_limit)
}

fn div_ceil_i64(value: i64, divisor: i64) -> i64 {
    if value <= 0 {
        0
    } else {
        (value + divisor - 1) / divisor
    }
}

fn expected_part_size(
    part_number: i64,
    part_size_bytes: i64,
    expected_size_bytes: i64,
    expected_part_count: i64,
) -> AppResult<i64> {
    if !(1..=expected_part_count).contains(&part_number)
        || part_size_bytes <= 0
        || expected_size_bytes < 0
    {
        return Err(AppError::validation(
            "invalid artifact multipart part range",
        ));
    }
    if part_number == expected_part_count {
        let previous = part_size_bytes.saturating_mul(expected_part_count.saturating_sub(1));
        return Ok((expected_size_bytes - previous).max(0));
    }
    Ok(part_size_bytes)
}

fn multipart_complete_xml(parts: &[CompletedUploadPart]) -> AppResult<String> {
    if parts.is_empty() {
        return Err(AppError::validation("multipart completion requires parts"));
    }
    let mut sorted = parts.to_vec();
    sorted.sort_by_key(|part| part.part_number);
    let mut body = String::from("<CompleteMultipartUpload>");
    for part in sorted {
        if part.part_number < 1 {
            return Err(AppError::validation("part numbers must be positive"));
        }
        body.push_str("<Part><PartNumber>");
        body.push_str(&part.part_number.to_string());
        body.push_str("</PartNumber><ETag>");
        body.push_str(&xml_escape(&part.etag));
        body.push_str("</ETag></Part>");
    }
    body.push_str("</CompleteMultipartUpload>");
    Ok(body)
}

fn validate_completed_multipart_parts(
    parts: &[CompletedUploadPart],
    expected_part_count: i64,
) -> AppResult<()> {
    if expected_part_count <= 0 {
        return Err(AppError::validation("multipart completion requires parts"));
    }
    if i64::try_from(parts.len()).unwrap_or(i64::MAX) != expected_part_count {
        return Err(AppError::validation(
            "multipart completion must include exactly the expected parts",
        ));
    }
    let mut seen = BTreeSet::new();
    for part in parts {
        if !(1..=expected_part_count).contains(&part.part_number) {
            return Err(AppError::validation(
                "multipart completion part number is out of range",
            ));
        }
        if !seen.insert(part.part_number) {
            return Err(AppError::validation(
                "multipart completion includes duplicate parts",
            ));
        }
        if part.etag.trim().is_empty() {
            return Err(AppError::validation(
                "multipart completion etags must be non-empty",
            ));
        }
    }
    Ok(())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml_tag_text(body: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = body.find(&open)? + open.len();
    let end = body[start..].find(&close)? + start;
    Some(body[start..end].to_string())
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
        let payload_hash = hex_sha256(b"hello");
        let signed = sign_r2_request(R2SigningRequest {
            method: "PUT",
            host: "example.r2.cloudflarestorage.com",
            canonical_uri: "/bucket/runs/1/file.txt",
            canonical_query: "",
            content_type: Some("text/plain"),
            payload_hash: &payload_hash,
            credentials: &credentials,
            now: Utc
                .with_ymd_and_hms(2026, 5, 21, 12, 0, 0)
                .single()
                .unwrap(),
        });
        assert_eq!(signed.amz_date, "20260521T120000Z");
        assert!(signed
            .authorization
            .contains("Credential=token-id/20260521/auto/s3/aws4_request"));
        assert!(signed
            .authorization
            .contains("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"));
        assert!(signed.authorization.contains("Signature="));
    }

    #[test]
    fn multipart_completion_requires_exact_non_empty_part_set() {
        let parts = vec![
            CompletedUploadPart {
                part_number: 1,
                etag: "etag-1".to_string(),
            },
            CompletedUploadPart {
                part_number: 2,
                etag: "etag-2".to_string(),
            },
        ];
        assert!(validate_completed_multipart_parts(&parts, 2).is_ok());
        assert!(validate_completed_multipart_parts(&parts, 3).is_err());
        assert!(validate_completed_multipart_parts(&parts, 1).is_err());
        assert!(validate_completed_multipart_parts(
            &[
                CompletedUploadPart {
                    part_number: 1,
                    etag: "etag-1".to_string(),
                },
                CompletedUploadPart {
                    part_number: 1,
                    etag: "etag-2".to_string(),
                },
            ],
            2
        )
        .is_err());
        assert!(validate_completed_multipart_parts(
            &[CompletedUploadPart {
                part_number: 1,
                etag: " ".to_string(),
            }],
            1
        )
        .is_err());
    }
}
