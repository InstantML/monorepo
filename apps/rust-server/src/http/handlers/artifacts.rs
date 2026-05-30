use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::header,
    http::{HeaderMap, HeaderName},
    response::Response,
    Json,
};
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;

use crate::{
    artifact_store::{ArtifactByteStore, ArtifactBytes},
    domain::{CreateArtifactRequest, UploadArtifactRequest},
    errors::{AppError, AppResult},
    store,
};

use super::super::{observability, AppState};
use super::helpers::{
    context, header_value, parse_uuid, read_json, require_scope, validate_session_mutation_origin,
};

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/artifacts",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    request_body = crate::domain::CreateArtifactRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Created artifact metadata", body = crate::http::openapi::ArtifactEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_artifact(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:write", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input = read_json::<CreateArtifactRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let artifact = store::create_artifact(&state.store, &ctx, run_id, input).await?;
    Ok(Json(json!({ "artifact": artifact.public_row() })))
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/artifacts/upload",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    request_body = crate::domain::UploadArtifactRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Created artifact with stored bytes", body = crate::http::openapi::ArtifactEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Artifact byte uploads disabled by server configuration", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn upload_artifact(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:write", &state)?;
    if !state.config.artifact_uploads_enabled {
        return Err(AppError::forbidden(
            "artifact byte uploads are disabled by server configuration",
        ));
    }
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input =
        read_json::<UploadArtifactRequest>(&headers, bytes, state.config.max_upload_body_bytes)?;
    let result = store::upload_artifact(&state.store, &state.config, &ctx, run_id, input).await;
    match &result {
        Ok(artifact) => observability::artifact_upload(
            ctx.org_id,
            run_id,
            Some(artifact.id),
            Some(&artifact.kind),
            Some(&artifact.storage_backend),
            artifact.size_bytes,
            None,
        ),
        Err(error) => {
            observability::artifact_upload(ctx.org_id, run_id, None, None, None, None, Some(error))
        }
    }
    let artifact = result?;
    Ok(Json(json!({ "artifact": artifact.public_row() })))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/artifacts",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("limit" = Option<i64>, Query, description = "Page size"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact rows for the run", body = crate::http::openapi::ArtifactsEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Read scope required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_artifacts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let artifacts = store::list_artifacts(&state.store, &ctx, run_id, &query)
        .await?
        .into_iter()
        .map(|artifact| artifact.public_row())
        .collect::<Vec<_>>();
    Ok(Json(json!({ "artifacts": artifacts })))
}

#[utoipa::path(
    get,
    path = "/api/artifacts/{artifact_id}/download",
    tag = "runs",
    params(
        ("artifact_id" = String, Path, description = "Artifact UUID"),
        ("Range" = Option<String>, Header, description = "Optional byte range forwarded to the stored artifact backend"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact byte stream. Runtime Content-Type uses the stored artifact MIME type when available and falls back to application/octet-stream.", body = crate::http::openapi::BinaryBody, content_type = "application/octet-stream"),
        (status = 206, description = "Artifact byte range. Runtime Content-Type uses the stored artifact MIME type when available and falls back to application/octet-stream.", body = crate::http::openapi::BinaryBody, content_type = "application/octet-stream"),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Read scope required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Artifact not found", body = crate::http::openapi::ErrorResponse),
        (status = 416, description = "Requested range is not satisfiable", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn download_artifact(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(artifact_id): Path<String>,
) -> AppResult<Response> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let artifact_id = parse_uuid(&artifact_id, "artifact not found")?;
    let artifact = store::get_artifact_for_context(&state.store, &ctx, artifact_id).await?;
    let artifact_store = ArtifactByteStore::for_artifact(&state.config, &artifact)?;
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let result = artifact_store.open(&artifact, range).await;
    observability::artifact_download(observability::ArtifactDownloadOutcome {
        org_id: ctx.org_id,
        run_id: artifact.run_id,
        artifact_id: artifact.id,
        artifact_type: &artifact.kind,
        storage_backend: &artifact.storage_backend,
        size_bytes: artifact.size_bytes,
        range_requested: range.is_some(),
        error: result.as_ref().err(),
    });
    let bytes = result?;
    let content_type = artifact
        .mime_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    match bytes {
        ArtifactBytes::File(file) => {
            let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
            add_artifact_download_headers(response.headers_mut(), &content_type, &artifact.name)?;
            if let Some(size_bytes) = artifact.size_bytes {
                response.headers_mut().insert(
                    header::CONTENT_LENGTH,
                    header_value(&size_bytes.to_string())?,
                );
            }
            Ok(response)
        }
        ArtifactBytes::Http(upstream) => {
            let status = upstream.status();
            let upstream_headers = upstream.headers().clone();
            let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
            *response.status_mut() = status;
            let headers = response.headers_mut();
            let content_type = upstream_headers
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or(&content_type);
            add_artifact_download_headers(headers, content_type, &artifact.name)?;
            for name in [
                header::CONTENT_LENGTH,
                header::CONTENT_RANGE,
                header::ACCEPT_RANGES,
                header::ETAG,
                header::LAST_MODIFIED,
            ] {
                if let Some(value) = upstream_headers.get(&name).cloned() {
                    headers.insert(name, value);
                }
            }
            Ok(response)
        }
    }
}

fn add_artifact_download_headers(
    headers: &mut HeaderMap,
    content_type: &str,
    artifact_name: &str,
) -> AppResult<()> {
    headers.insert(header::CONTENT_TYPE, header_value(content_type)?);
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        header_value("nosniff")?,
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        header_value("sandbox")?,
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        header_value(&format!(
            "attachment; filename=\"{}\"",
            safe_attachment_filename(artifact_name)
        ))?,
    );
    Ok(())
}

fn safe_attachment_filename(value: &str) -> String {
    let basename = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("artifact")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = basename.trim_matches('.');
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_filename_is_header_safe() {
        assert_eq!(safe_attachment_filename("../bad\"\r\n.svg"), "bad___.svg");
        assert_eq!(safe_attachment_filename(".."), "artifact");
        assert_eq!(
            safe_attachment_filename("metric plot.png"),
            "metric_plot.png"
        );
        assert_eq!(
            safe_attachment_filename("nested\\checkpoint.pt"),
            "checkpoint.pt"
        );
    }

    #[test]
    fn artifact_download_headers_force_attachment_and_sandbox() {
        let mut headers = HeaderMap::new();
        add_artifact_download_headers(&mut headers, "text/html", "../bad\"\r\n.svg").unwrap();

        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "text/html");
        assert_eq!(
            headers
                .get(HeaderName::from_static("x-content-type-options"))
                .unwrap(),
            "nosniff"
        );
        assert_eq!(
            headers
                .get(HeaderName::from_static("content-security-policy"))
                .unwrap(),
            "sandbox"
        );
        assert_eq!(
            headers.get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment; filename=\"bad___.svg\""
        );
    }
}
