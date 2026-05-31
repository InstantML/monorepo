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
use uuid::Uuid;

use crate::{
    artifact_store::{ArtifactByteStore, ArtifactBytes},
    domain::{
        AbortArtifactUploadRequest, ArtifactRow, CompleteArtifactUploadRequest,
        CreateArtifactInputEdgeRequest, CreateArtifactRequest, DeleteArtifactVersionRequest,
        InitiateArtifactUploadRequest, RenewArtifactUploadRequest, SetArtifactAliasRequest,
        UpdateArtifactRetentionRequest, UploadArtifactRequest,
    },
    errors::{AppError, AppResult},
    store,
};

use super::super::{observability, AppState};
use super::helpers::{
    context, header_text, header_value, parse_uuid, read_json, read_json_with_raw, require_scope,
    validate_session_mutation_origin,
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
        (status = 403, description = "Artifact write scope required", body = crate::http::openapi::ErrorResponse),
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
        (status = 403, description = "Artifact write scope required or artifact byte uploads disabled by server configuration", body = crate::http::openapi::ErrorResponse),
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

#[utoipa::path(
    get,
    path = "/api/artifact-collections",
    tag = "runs",
    params(
        ("project" = Option<String>, Query, description = "Project name filter"),
        ("type" = Option<String>, Query, description = "Artifact collection type filter"),
        ("q" = Option<String>, Query, description = "Case-insensitive collection name search"),
        ("limit" = Option<i64>, Query, description = "Maximum collections to return"),
        ("offset" = Option<i64>, Query, description = "Collection offset"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Versioned artifact collections", body = crate::http::openapi::ArtifactCollectionsEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Read scope required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_artifact_collections(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    Ok(Json(
        store::list_artifact_collections(&state.store, &ctx, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/artifact-collections/{collection_id}",
    tag = "runs",
    params(("collection_id" = String, Path, description = "Artifact collection UUID")),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact collection", body = crate::http::openapi::ArtifactCollectionEnvelope),
        (status = 404, description = "Collection not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_artifact_collection(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(collection_id): Path<String>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let collection_id = parse_uuid(&collection_id, "artifact collection not found")?;
    Ok(Json(
        store::get_artifact_collection(&state.store, &ctx, collection_id).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/artifact-collections/{collection_id}/versions",
    tag = "runs",
    params(
        ("collection_id" = String, Path, description = "Artifact collection UUID"),
        ("limit" = Option<i64>, Query, description = "Maximum versions to return"),
        ("offset" = Option<i64>, Query, description = "Version offset"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact collection versions", body = crate::http::openapi::ArtifactVersionsEnvelope),
        (status = 404, description = "Collection not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_artifact_collection_versions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(collection_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let collection_id = parse_uuid(&collection_id, "artifact collection not found")?;
    Ok(Json(
        store::list_artifact_collection_versions(&state.store, &ctx, collection_id, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/artifact-versions/resolve",
    tag = "runs",
    params(
        ("ref" = String, Query, description = "Artifact reference such as name:latest, type/name:best, or project/type/name:v0"),
        ("type" = Option<String>, Query, description = "Artifact collection type disambiguator"),
        ("project" = Option<String>, Query, description = "Project name disambiguator"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Resolved artifact version", body = crate::http::openapi::ArtifactVersionEnvelope),
        (status = 404, description = "Version not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn resolve_artifact_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    Ok(Json(
        store::resolve_artifact_version(&state.store, &ctx, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/artifact-versions/{version_id}",
    tag = "runs",
    params(("version_id" = String, Path, description = "Artifact version UUID")),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact version", body = crate::http::openapi::ArtifactVersionEnvelope),
        (status = 404, description = "Version not found", body = crate::http::openapi::ErrorResponse),
        (status = 410, description = "Artifact version deleted or expired", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_artifact_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(version_id): Path<String>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let version_id = parse_uuid(&version_id, "artifact version not found")?;
    Ok(Json(
        store::get_artifact_version(&state.store, &ctx, version_id).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/artifact-versions/{version_id}/manifest",
    tag = "runs",
    params(
        ("version_id" = String, Path, description = "Artifact version UUID"),
        ("limit" = Option<i64>, Query, description = "Maximum manifest entries to return"),
        ("offset" = Option<i64>, Query, description = "Manifest entry offset"),
        ("path_prefix" = Option<String>, Query, description = "Optional artifact path prefix"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact manifest page", body = crate::http::openapi::ArtifactManifestEnvelope),
        (status = 404, description = "Version not found", body = crate::http::openapi::ErrorResponse),
        (status = 410, description = "Artifact version deleted or expired", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_artifact_manifest(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(version_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let version_id = parse_uuid(&version_id, "artifact version not found")?;
    Ok(Json(
        store::list_artifact_manifest(&state.store, &ctx, version_id, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/artifact-versions/{version_id}/lineage",
    tag = "runs",
    params(
        ("version_id" = String, Path, description = "Artifact version UUID"),
        ("limit" = Option<i64>, Query, description = "Maximum lineage edges to return"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact lineage graph", body = crate::http::openapi::ArtifactLineageEnvelope),
        (status = 404, description = "Version not found", body = crate::http::openapi::ErrorResponse),
        (status = 410, description = "Artifact version deleted or expired", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn artifact_version_lineage(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(version_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let version_id = parse_uuid(&version_id, "artifact version not found")?;
    Ok(Json(
        store::artifact_version_lineage(&state.store, &ctx, version_id, &query).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/artifact-uploads",
    tag = "runs",
    params(("run_id" = String, Path, description = "Run UUID")),
    request_body = crate::domain::InitiateArtifactUploadRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact upload session", body = crate::http::openapi::ArtifactUploadSessionEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Write scope required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn initiate_artifact_upload(
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
    let (input, raw) = read_json_with_raw::<InitiateArtifactUploadRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    let key = header_text(&headers, "idempotency-key").map(str::to_string);
    Ok(Json(
        store::initiate_artifact_upload(&state.store, &state.config, &ctx, run_id, raw, input, key)
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/artifact-uploads/{upload_session_id}/renew",
    tag = "runs",
    params(("upload_session_id" = String, Path, description = "Artifact upload session UUID")),
    request_body = crate::domain::RenewArtifactUploadRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Renewed upload URLs", body = crate::http::openapi::ArtifactUploadRenewEnvelope)),
)]
pub async fn renew_artifact_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(upload_session_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:write", &state)?;
    let upload_session_id = parse_uuid(&upload_session_id, "artifact upload session not found")?;
    let input =
        read_json::<RenewArtifactUploadRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::renew_artifact_upload(&state.store, &state.config, &ctx, upload_session_id, input)
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/artifact-uploads/{upload_session_id}/complete",
    tag = "runs",
    params(("upload_session_id" = String, Path, description = "Artifact upload session UUID")),
    request_body = crate::domain::CompleteArtifactUploadRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Committed artifact version", body = crate::http::openapi::ArtifactVersionEnvelope)),
)]
pub async fn complete_artifact_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(upload_session_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:write", &state)?;
    let upload_session_id = parse_uuid(&upload_session_id, "artifact upload session not found")?;
    let mut input = read_json::<CompleteArtifactUploadRequest>(
        &headers,
        bytes,
        state.config.max_upload_body_bytes,
    )?;
    if input.idempotency_key.is_none() {
        input.idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    }
    Ok(Json(
        store::complete_artifact_upload(
            &state.store,
            &state.config,
            &ctx,
            upload_session_id,
            input,
        )
        .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/artifact-uploads/{upload_session_id}/abort",
    tag = "runs",
    params(("upload_session_id" = String, Path, description = "Artifact upload session UUID")),
    request_body = crate::domain::AbortArtifactUploadRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Aborted artifact upload", body = crate::http::openapi::ArtifactUploadAbortEnvelope)),
)]
pub async fn abort_artifact_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(upload_session_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:write", &state)?;
    let upload_session_id = parse_uuid(&upload_session_id, "artifact upload session not found")?;
    let input =
        read_json::<AbortArtifactUploadRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::abort_artifact_upload(&state.store, &state.config, &ctx, upload_session_id, input)
            .await?,
    ))
}

#[utoipa::path(
    put,
    path = "/api/artifact-collections/{collection_id}/aliases/{alias}",
    tag = "runs",
    request_body = crate::domain::SetArtifactAliasRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Moved artifact alias", body = crate::http::openapi::ArtifactVersionEnvelope)),
)]
pub async fn set_artifact_alias(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((collection_id, alias)): Path<(String, String)>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:manage", &state)?;
    let collection_id = parse_uuid(&collection_id, "artifact collection not found")?;
    let input = read_json::<SetArtifactAliasRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::set_artifact_alias(&state.store, &ctx, collection_id, &alias, input).await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/api/artifact-collections/{collection_id}/aliases/{alias}",
    tag = "runs",
    request_body = crate::domain::DeleteArtifactAliasRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Deleted artifact alias", body = crate::http::openapi::ArtifactAliasDeletedEnvelope)),
)]
pub async fn delete_artifact_alias(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((collection_id, alias)): Path<(String, String)>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:manage", &state)?;
    let collection_id = parse_uuid(&collection_id, "artifact collection not found")?;
    let input = read_json::<crate::domain::DeleteArtifactAliasRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    Ok(Json(
        store::delete_artifact_alias(&state.store, &ctx, collection_id, &alias, input).await?,
    ))
}

#[utoipa::path(
    patch,
    path = "/api/artifact-versions/{version_id}/retention",
    tag = "runs",
    params(("version_id" = String, Path, description = "Artifact version UUID")),
    request_body = crate::domain::UpdateArtifactRetentionRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Updated artifact retention", body = crate::http::openapi::ArtifactVersionEnvelope)),
)]
pub async fn update_artifact_retention(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(version_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:manage", &state)?;
    let version_id = parse_uuid(&version_id, "artifact version not found")?;
    let input =
        read_json::<UpdateArtifactRetentionRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::update_artifact_retention(&state.store, &ctx, version_id, input).await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/api/artifact-versions/{version_id}",
    tag = "runs",
    params(("version_id" = String, Path, description = "Artifact version UUID")),
    request_body = crate::domain::DeleteArtifactVersionRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Soft-deleted artifact version", body = crate::http::openapi::ArtifactVersionEnvelope)),
)]
pub async fn delete_artifact_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(version_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:manage", &state)?;
    let version_id = parse_uuid(&version_id, "artifact version not found")?;
    let input =
        read_json::<DeleteArtifactVersionRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::delete_artifact_version(&state.store, &ctx, version_id, input).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/artifact-inputs",
    tag = "runs",
    params(("run_id" = String, Path, description = "Run UUID")),
    request_body = crate::domain::CreateArtifactInputEdgeRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Created artifact input edge", body = crate::http::openapi::ArtifactVersionEnvelope)),
)]
pub async fn create_artifact_input_edge(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    if require_scope(&ctx, "sdk:ingest", &state).is_err() {
        require_scope(&ctx, "artifacts:write", &state)?;
    }
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input =
        read_json::<CreateArtifactInputEdgeRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::create_artifact_input_edge(&state.store, &ctx, run_id, input).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/artifact-edges",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("direction" = Option<String>, Query, description = "Edge direction: input, output, or both"),
        ("limit" = Option<i64>, Query, description = "Maximum edges to return"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses((status = 200, description = "Artifact input/output edges for a run", body = crate::http::openapi::ArtifactEdgesEnvelope)),
)]
pub async fn run_artifact_edges(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::run_artifact_edges(&state.store, &ctx, run_id, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/artifact-entries/{entry_id}/download",
    tag = "runs",
    params(("entry_id" = String, Path, description = "Artifact manifest entry UUID")),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Artifact entry byte stream", content_type = "application/octet-stream"),
        (status = 404, description = "Artifact entry not found", body = crate::http::openapi::ErrorResponse),
        (status = 410, description = "Artifact version deleted or expired", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn download_artifact_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(entry_id): Path<String>,
) -> AppResult<Response> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let entry_id = parse_uuid(&entry_id, "artifact entry not found")?;
    let (entry, version) = store::artifact_entry_for_context(&state.store, &ctx, entry_id).await?;
    let artifact = ArtifactRow {
        id: entry.id,
        org_id: entry.org_id,
        run_id: version.source_run_id.unwrap_or_else(Uuid::nil),
        kind: entry.kind.clone(),
        name: entry.path.clone(),
        uri: format!("instantml://artifact-entries/{}", entry.id),
        step: version.source_step,
        size_bytes: entry.size_bytes,
        sha256: entry.sha256.clone(),
        mime_type: entry.mime_type.clone(),
        storage_backend: entry.storage_backend.clone(),
        storage_key: entry.storage_key.clone(),
        storage_path: entry.storage_path.clone(),
        metadata: json!({}),
        created_at: entry.created_at,
    };
    let artifact_store = ArtifactByteStore::for_artifact(&state.config, &artifact)?;
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let bytes = artifact_store.open(&artifact, range).await?;
    let content_type = artifact
        .mime_type
        .clone()
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
            add_artifact_download_headers(headers, &content_type, &artifact.name)?;
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
