use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use tokio::fs::File;
use uuid::Uuid;

use crate::{
    domain::ArtifactRow,
    errors::{AppError, AppResult},
};

#[derive(Clone, Debug)]
pub struct LocalArtifactStore {
    root: PathBuf,
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

impl LocalArtifactStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub async fn stage_base64(
        &self,
        org_id: Uuid,
        run_id: Uuid,
        artifact_id: Uuid,
        name: &str,
        content_base64: &str,
    ) -> AppResult<StagedArtifact> {
        let bytes = STANDARD
            .decode(content_base64.as_bytes())
            .map_err(|_| AppError::validation("content_base64 must be valid base64"))?;
        if bytes.is_empty() {
            return Err(AppError::validation("content_base64 must decode to bytes"));
        }
        let size_bytes = i64::try_from(bytes.len())
            .map_err(|_| AppError::validation("artifact is too large"))?;
        let sha256 = hex_sha256(&bytes);
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
        tokio::fs::write(&tmp_path, bytes).await?;
        Ok(StagedArtifact {
            tmp_path,
            final_path,
            storage_key: storage_key.clone(),
            uri: format!("rlobs://artifacts/{storage_key}"),
            size_bytes,
            sha256,
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

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}
