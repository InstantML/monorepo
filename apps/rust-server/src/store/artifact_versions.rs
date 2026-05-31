use super::*;
use crate::artifact_store::{CompletedUploadPart, RenewVersionedUploadPartsRequest};
use sha2::Digest;

const DEFAULT_COLLECTION_LIMIT: i64 = 100;
const MAX_COLLECTION_LIMIT: i64 = 500;
const DEFAULT_VERSION_LIMIT: i64 = 100;
const MAX_VERSION_LIMIT: i64 = 1_000;
const DEFAULT_MANIFEST_LIMIT: i64 = 100;
const MAX_MANIFEST_LIMIT: i64 = 1_000;
const DEFAULT_EDGE_LIMIT: i64 = 200;
const MAX_EDGE_LIMIT: i64 = 200;
const MAX_MANIFEST_ENTRIES: usize = 1_000;
const MAX_MANIFEST_CHUNK_BYTES: usize = 500 * 1024;
const MAX_UPLOAD_SESSION_PARTS: i64 = 20_000;
const MAX_COMPLETE_FILES: usize = 1_000;
const UPLOAD_SESSION_TTL_MINUTES: i64 = 60;
const MAX_VERSIONED_ARTIFACT_FILE_BYTES: i64 = 5 * 1024 * 1024 * 1024 * 1024;

#[derive(Clone)]
struct NormalizedManifestEntry {
    id: Uuid,
    path: String,
    kind: String,
    size_bytes: Option<i64>,
    sha256: Option<String>,
    mime_type: Option<String>,
    reference_uri: Option<String>,
}

pub async fn initiate_artifact_upload(
    store: &Store,
    config: &AppConfig,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: InitiateArtifactUploadRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    ensure_billing_write_allowed(store, ctx.org_id, "create artifact versions").await?;
    let request_hash = hash_idempotency(run_id, &raw)?;
    let request_hash_hex = hex_bytes_local(&request_hash);
    let idempotency_key = idempotency_key.or(input.idempotency_key.clone());
    let collection_name = validate_collection_name(input.collection.name.as_deref())?;
    let collection_kind =
        validate_artifact_collection_type(input.collection.kind.as_deref().unwrap_or("file"))?;
    let collection_description =
        validate_optional_name(input.collection.description.as_deref(), "description")?;
    let collection_metadata =
        validate_json_object(input.collection.metadata, "collection metadata")?;
    validate_json_size(
        &collection_metadata,
        "collection metadata",
        MAX_OBJECT_METADATA_BYTES,
    )?;
    let source_step = validate_optional_step(input.source_step.as_ref(), "source_step")?;
    let ttl_days = validate_ttl_days(input.ttl_days)?;
    let aliases = validate_aliases(input.aliases.unwrap_or_default())?;
    let normalized_entries = normalize_manifest_entries(input.manifest.entries)?;
    let digest = manifest_digest(&normalized_entries);
    let total_bytes = normalized_entries
        .iter()
        .filter(|entry| entry.reference_uri.is_none())
        .try_fold(0i64, |total, entry| {
            total
                .checked_add(entry.size_bytes.unwrap_or(0))
                .ok_or_else(|| AppError::validation("artifact manifest total size is too large"))
        })?;
    if let Some(key) = idempotency_key.as_ref() {
        store.reserve_idempotency_key(ctx.org_id, key).await?;
    }
    let result = async {
        let (run, project, existing_collection, existing_version) = {
            let data = store.data.lock().await;
            if let Some(key) = idempotency_key.as_ref() {
                if let Some(existing) = data
                    .idempotency
                    .get(&(ctx.org_id, key.clone()))
                    .filter(|record| record.expires_at > Utc::now())
                {
                    if existing.request_hash == request_hash {
                        if initiate_idempotency_response_is_live(&data, &existing.response_json) {
                            return Ok(existing.response_json.clone());
                        }
                    } else {
                        return Err(AppError::conflict(
                            "idempotency key was already used with a different request body",
                        ));
                    }
                }
            }
            let run = fetch_run_in_data(&data, ctx, run_id)?;
            ensure_run_access_in_data(ctx, &run)?;
            let project = data
                .projects
                .get(&run.project_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("project not found"))?;
            let collection_id = data
                .artifact_collections_by_project_type_name
                .get(&(
                    run.project_id,
                    collection_kind.clone(),
                    collection_name.clone(),
                ))
                .copied();
            let collection =
                collection_id.and_then(|id| data.artifact_collections.get(&id).cloned());
            let existing = collection.as_ref().and_then(|collection| {
                latest_active_version_in_data(&data, collection.id)
                    .filter(|version| version.digest == digest)
            });
            (run, project, collection, existing)
        };

        if let Some(version) = existing_version {
            let response = {
                let mut data = store.data.lock().await;
                let collection = existing_collection
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| AppError::internal("artifact collection missing"))?;
                for alias in &aliases {
                    upsert_artifact_alias_locked(
                        store,
                        &mut data,
                        ctx.org_id,
                        &collection,
                        version.id,
                        alias,
                        None,
                    )
                    .await?;
                }
                json!({
                    "artifact_version": public_version_value(&data, &collection, &version),
                    "deduplicated": true
                })
            };
            if let Some(key) = idempotency_key.as_ref() {
                persist_idempotency_response(
                    store,
                    ctx.org_id,
                    key,
                    request_hash.clone(),
                    response.clone(),
                )
                .await?;
            }
            return Ok(response);
        }

        let capacity_guard = store.artifact_upload_capacity_lock.lock().await;
        enforce_plan_capacity(
            store,
            ctx.org_id,
            UsageDelta {
                storage_bytes: total_bytes + ARTIFACT_METADATA_BYTES,
                ..UsageDelta::default()
            },
            "create artifact versions",
        )
        .await?;

        let artifact_version_id = Uuid::new_v4();
        let artifact_store = ArtifactByteStore::for_upload(config)?;
        let mut files = Vec::new();
        let mut initial_parts_by_entry: HashMap<
            Uuid,
            Vec<crate::artifact_store::PresignedUploadPart>,
        > = HashMap::new();
        let mut manifest_entries = Vec::new();
        for entry in &normalized_entries {
            let mut row = ArtifactManifestEntryRow {
                id: entry.id,
                org_id: ctx.org_id,
                project_id: run.project_id,
                collection_id: existing_collection
                    .as_ref()
                    .map(|collection| collection.id)
                    .unwrap_or_else(Uuid::new_v4),
                artifact_version_id,
                path: entry.path.clone(),
                kind: entry.kind.clone(),
                size_bytes: entry.size_bytes,
                sha256: entry.sha256.clone(),
                mime_type: entry.mime_type.clone(),
                storage_backend: if entry.reference_uri.is_some() {
                    "external".to_string()
                } else {
                    match config.artifact_backend {
                        crate::config::ArtifactBackend::Local => "local".to_string(),
                        crate::config::ArtifactBackend::R2 => "r2".to_string(),
                    }
                },
                storage_key: None,
                storage_path: None,
                reference_uri: entry.reference_uri.clone(),
                created_at: Utc::now(),
            };
            if entry.reference_uri.is_none() {
                let target = artifact_store
                    .create_versioned_upload_target(
                        ctx.org_id,
                        artifact_version_id,
                        entry.id,
                        entry.size_bytes.unwrap_or(0),
                        entry.mime_type.as_deref(),
                    )
                    .await?;
                row.storage_backend = target.storage_backend.clone();
                row.storage_key = Some(target.storage_key.clone());
                row.storage_path = target.storage_path.clone();
                initial_parts_by_entry.insert(entry.id, target.parts.clone());
                files.push(ArtifactUploadFile {
                    entry_id: entry.id,
                    path: entry.path.clone(),
                    kind: entry.kind.clone(),
                    size_bytes: entry.size_bytes.unwrap_or(0),
                    sha256: entry.sha256.clone().unwrap_or_default(),
                    mime_type: entry.mime_type.clone(),
                    storage_backend: target.storage_backend,
                    storage_key: Some(target.storage_key),
                    storage_path: target.storage_path,
                    multipart_upload_id: target.multipart_upload_id,
                    part_size_bytes: target.part_size_bytes,
                    part_count: target.part_count,
                });
            }
            manifest_entries.push(row);
        }
        let total_part_count = files.iter().map(|file| file.part_count).sum::<i64>();
        if total_part_count > MAX_UPLOAD_SESSION_PARTS {
            return Err(AppError::validation(format!(
                "artifact upload has too many parts; maximum is {MAX_UPLOAD_SESSION_PARTS}"
            )));
        }

        let response = {
            let mut data = store.data.lock().await;
            let run = fetch_run_in_data(&data, ctx, run_id)?;
            ensure_run_access_in_data(ctx, &run)?;
            let collection = match data
                .artifact_collections_by_project_type_name
                .get(&(
                    run.project_id,
                    collection_kind.clone(),
                    collection_name.clone(),
                ))
                .and_then(|id| data.artifact_collections.get(id))
                .cloned()
            {
                Some(collection) => collection,
                None => {
                    let collection = ArtifactCollectionRow {
                        id: manifest_entries
                            .first()
                            .map(|entry| entry.collection_id)
                            .unwrap_or_else(Uuid::new_v4),
                        org_id: ctx.org_id,
                        project_id: run.project_id,
                        project: project.name.clone(),
                        name: collection_name.clone(),
                        kind: collection_kind.clone(),
                        description: collection_description,
                        metadata: collection_metadata,
                        default_ttl_days: None,
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                        deleted_at: None,
                    };
                    store
                        .persist_locked(
                            "artifact_collection",
                            ctx.org_id,
                            &collection.id.to_string(),
                            &collection,
                        )
                        .await?;
                    data.insert_artifact_collection(collection.clone());
                    collection
                }
            };
            for entry in &mut manifest_entries {
                entry.collection_id = collection.id;
            }
            let session = ArtifactUploadSessionRow {
                id: Uuid::new_v4(),
                org_id: ctx.org_id,
                project_id: run.project_id,
                run_id,
                artifact_version_id,
                collection_id: collection.id,
                state: "uploading".to_string(),
                request_hash: request_hash_hex.clone(),
                expected_total_bytes: total_bytes,
                total_part_count,
                aliases,
                ttl_days,
                source_step,
                digest: digest.clone(),
                files,
                manifest_entries,
                idempotency_response: None,
                expires_at: Utc::now() + ChronoDuration::minutes(UPLOAD_SESSION_TTL_MINUTES),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            };
            let response = upload_session_response_with_parts(&session, &initial_parts_by_entry);
            store
                .persist_locked(
                    "artifact_upload_session",
                    ctx.org_id,
                    &session.id.to_string(),
                    &session,
                )
                .await?;
            data.insert_artifact_upload_session(session.clone());
            response
        };
        drop(capacity_guard);
        if let Some(key) = idempotency_key.as_ref() {
            persist_idempotency_response(
                store,
                ctx.org_id,
                key,
                request_hash.clone(),
                response.clone(),
            )
            .await?;
        }
        Ok(response)
    }
    .await;
    if let Some(key) = idempotency_key.as_ref() {
        store.release_idempotency_key(ctx.org_id, key).await;
    }
    result
}

pub async fn renew_artifact_upload(
    store: &Store,
    config: &AppConfig,
    ctx: &RequestContext,
    upload_session_id: Uuid,
    input: RenewArtifactUploadRequest,
) -> AppResult<Value> {
    let (file, session) = {
        let data = store.data.lock().await;
        let session = upload_session_in_data(&data, ctx, upload_session_id)?;
        if session.state != "uploading" {
            return Err(AppError::conflict(
                "artifact upload session is not uploadable",
            ));
        }
        if session.expires_at <= Utc::now() {
            return Err(AppError::new(
                axum::http::StatusCode::GONE,
                "artifact upload session expired",
            ));
        }
        let file = session
            .files
            .iter()
            .find(|file| file.entry_id == input.entry_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("artifact upload entry not found"))?;
        if input.start_part_number < 1 || !(1..=256).contains(&input.part_count) {
            return Err(AppError::validation(
                "part range must start at 1 or higher and include 1-256 parts",
            ));
        }
        let end_part_number = input.start_part_number + input.part_count - 1;
        if input.start_part_number > file.part_count || end_part_number > file.part_count {
            return Err(AppError::validation(
                "part range exceeds artifact upload part count",
            ));
        }
        (file, session)
    };
    let artifact_store = ArtifactByteStore::for_upload(config)?;
    let storage_key = file
        .storage_key
        .as_deref()
        .ok_or_else(|| AppError::not_found("artifact upload storage target not found"))?;
    let parts = artifact_store
        .renew_versioned_upload_parts(RenewVersionedUploadPartsRequest {
            storage_key,
            multipart_upload_id: file.multipart_upload_id.as_deref(),
            start_part_number: input.start_part_number,
            part_count: input.part_count,
            part_size_bytes: file.part_size_bytes,
            expected_size_bytes: file.size_bytes,
            expected_part_count: file.part_count,
            expires_seconds: 15 * 60,
        })
        .await?;
    Ok(json!({
        "upload_session": { "id": session.id, "expires_at": session.expires_at },
        "entry_id": file.entry_id,
        "parts": parts.into_iter().map(presigned_part_value).collect::<Vec<_>>()
    }))
}

pub async fn complete_artifact_upload(
    store: &Store,
    config: &AppConfig,
    ctx: &RequestContext,
    upload_session_id: Uuid,
    input: CompleteArtifactUploadRequest,
) -> AppResult<Value> {
    ensure_billing_write_allowed(store, ctx.org_id, "complete artifact upload").await?;
    if input.files.len() > MAX_COMPLETE_FILES {
        return Err(AppError::validation(format!(
            "complete request can include at most {MAX_COMPLETE_FILES} files"
        )));
    }
    let session = {
        let mut data = store.data.lock().await;
        let mut session = upload_session_in_data(&data, ctx, upload_session_id)?;
        if let Some(response) = session.idempotency_response.clone() {
            return Ok(response);
        }
        if session.expires_at <= Utc::now()
            && !matches!(session.state.as_str(), "provider_completed" | "completing")
        {
            return Err(AppError::new(
                axum::http::StatusCode::GONE,
                "artifact upload session expired",
            ));
        }
        if !matches!(
            session.state.as_str(),
            "uploading" | "completing" | "provider_completed"
        ) {
            return Err(AppError::conflict(
                "artifact upload session is not uploadable",
            ));
        }
        validate_complete_file_ids(session.files.iter().map(|file| file.entry_id), &input.files)?;
        if session.state == "uploading" {
            session.state = "completing".to_string();
            session.updated_at = Utc::now();
            store
                .persist_locked(
                    "artifact_upload_session",
                    ctx.org_id,
                    &session.id.to_string(),
                    &session,
                )
                .await?;
            data.insert_artifact_upload_session(session.clone());
        }
        session
    };

    let artifact_store = ArtifactByteStore::for_upload(config)?;
    if session.state != "provider_completed" {
        for file in &session.files {
            let complete_file = input
                .files
                .iter()
                .find(|candidate| candidate.entry_id == file.entry_id)
                .ok_or_else(|| {
                    AppError::validation("complete request is missing an upload file")
                })?;
            if file.storage_backend == "local" {
                let content = complete_file.content_base64.as_deref().ok_or_else(|| {
                    AppError::validation("content_base64 is required for local artifact storage")
                })?;
                let stored = artifact_store
                    .store_versioned_inline_base64(
                        ctx.org_id,
                        file.storage_key.as_deref().ok_or_else(|| {
                            AppError::not_found("artifact upload storage target not found")
                        })?,
                        content,
                    )
                    .await?;
                if stored.size_bytes != file.size_bytes || stored.sha256 != file.sha256 {
                    artifact_store.cleanup(&stored).await;
                    return Err(AppError::validation(
                        "uploaded file did not match expected size or sha256",
                    ));
                }
            } else if file.storage_backend == "r2" {
                let parts = complete_file
                    .parts
                    .as_ref()
                    .map(|parts| {
                        parts
                            .iter()
                            .map(|part| CompletedUploadPart {
                                part_number: part.part_number,
                                etag: part.etag.clone(),
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                artifact_store
                    .complete_versioned_upload(
                        file.storage_key.as_deref().ok_or_else(|| {
                            AppError::not_found("artifact upload storage target not found")
                        })?,
                        file.multipart_upload_id.as_deref(),
                        &parts,
                        file.size_bytes,
                        file.part_count,
                        &file.sha256,
                    )
                    .await?;
            }
        }
        let mut data = store.data.lock().await;
        let mut session = upload_session_in_data(&data, ctx, upload_session_id)?;
        if let Some(response) = session.idempotency_response.clone() {
            return Ok(response);
        }
        if session.state == "completing" {
            session.state = "provider_completed".to_string();
            session.updated_at = Utc::now();
            store
                .persist_locked(
                    "artifact_upload_session",
                    ctx.org_id,
                    &session.id.to_string(),
                    &session,
                )
                .await?;
            data.insert_artifact_upload_session(session);
        } else if session.state != "provider_completed" {
            return Err(AppError::conflict(
                "artifact upload session provider completion was interrupted",
            ));
        }
    }

    let response = {
        let mut data = store.data.lock().await;
        let mut session = upload_session_in_data(&data, ctx, upload_session_id)?;
        if let Some(response) = session.idempotency_response.clone() {
            return Ok(response);
        }
        if session.state != "provider_completed" {
            return Err(AppError::conflict(
                "artifact upload session provider completion was not recorded",
            ));
        }
        let collection = data
            .artifact_collections
            .get(&session.collection_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("artifact collection not found"))?;
        if let Some(existing) =
            active_version_with_digest_in_data(&data, collection.id, &session.digest)
        {
            cleanup_session_files(&artifact_store, &session).await?;
            for alias in &session.aliases {
                upsert_artifact_alias_locked(
                    store,
                    &mut data,
                    ctx.org_id,
                    &collection,
                    existing.id,
                    alias,
                    None,
                )
                .await?;
            }
            upsert_artifact_edge_locked(
                store,
                &mut data,
                ArtifactEdgeUpsert {
                    org_id: ctx.org_id,
                    project_id: session.project_id,
                    run_id: session.run_id,
                    artifact_version_id: existing.id,
                    direction: "output",
                    source: "sdk",
                },
            )
            .await?;
            let response = json!({
                "artifact_version": public_version_value(&data, &collection, &existing),
                "deduplicated": true
            });
            session.state = "deduplicated".to_string();
            session.updated_at = Utc::now();
            session.idempotency_response = Some(response.clone());
            store
                .persist_locked(
                    "artifact_upload_session",
                    ctx.org_id,
                    &session.id.to_string(),
                    &session,
                )
                .await?;
            data.insert_artifact_upload_session(session);
            return Ok(response);
        }
        session.state = "active".to_string();
        session.updated_at = Utc::now();
        let version_index = next_version_index_in_data(&data, collection.id);
        let expires_at = session
            .ttl_days
            .map(|days| Utc::now() + ChronoDuration::days(days));
        let version = ArtifactVersionRow {
            id: session.artifact_version_id,
            org_id: ctx.org_id,
            project_id: session.project_id,
            collection_id: collection.id,
            version_index,
            digest: session.digest.clone(),
            source_run_id: Some(session.run_id),
            source_step: session.source_step,
            file_count: session.manifest_entries.len() as i64,
            size_bytes: session.expected_total_bytes,
            state: "active".to_string(),
            metadata: json!({}),
            ttl_days: session.ttl_days,
            retention_mode: if session.ttl_days.is_some() {
                "days".to_string()
            } else {
                "inherit".to_string()
            },
            expires_at,
            delete_requested_at: None,
            deleted_at: None,
            audit_reason: None,
            created_at: Utc::now(),
        };
        store
            .persist_locked(
                "artifact_version",
                ctx.org_id,
                &version.id.to_string(),
                &version,
            )
            .await?;
        data.insert_artifact_version(version.clone());
        for chunk in manifest_chunks(&session.manifest_entries)? {
            store
                .persist_locked(
                    "artifact_manifest_entries",
                    ctx.org_id,
                    &format!("{}:{}", chunk.artifact_version_id, chunk.chunk_index),
                    &chunk,
                )
                .await?;
            data.insert_artifact_manifest_entries(chunk);
        }
        for alias in &session.aliases {
            upsert_artifact_alias_locked(
                store,
                &mut data,
                ctx.org_id,
                &collection,
                version.id,
                alias,
                None,
            )
            .await?;
        }
        upsert_artifact_edge_locked(
            store,
            &mut data,
            ArtifactEdgeUpsert {
                org_id: ctx.org_id,
                project_id: session.project_id,
                run_id: session.run_id,
                artifact_version_id: version.id,
                direction: "output",
                source: "sdk",
            },
        )
        .await?;
        let response =
            json!({ "artifact_version": public_version_value(&data, &collection, &version) });
        session.idempotency_response = Some(response.clone());
        store
            .persist_locked(
                "artifact_upload_session",
                ctx.org_id,
                &session.id.to_string(),
                &session,
            )
            .await?;
        data.insert_artifact_upload_session(session);
        response
    };
    Ok(response)
}

pub async fn abort_artifact_upload(
    store: &Store,
    config: &AppConfig,
    ctx: &RequestContext,
    upload_session_id: Uuid,
    _input: AbortArtifactUploadRequest,
) -> AppResult<Value> {
    let session = {
        let mut data = store.data.lock().await;
        let mut session = upload_session_in_data(&data, ctx, upload_session_id)?;
        if matches!(
            session.state.as_str(),
            "active" | "provider_completed" | "deduplicated"
        ) {
            return Err(AppError::conflict(
                "artifact upload session is already committed or awaiting activation",
            ));
        }
        if session.state == "failed" {
            return Ok(json!({ "upload_session": { "id": session.id, "state": session.state } }));
        }
        if session.state == "completing" {
            return Err(AppError::conflict(
                "artifact upload session is currently completing",
            ));
        }
        session.state = "aborting".to_string();
        session.updated_at = Utc::now();
        store
            .persist_locked(
                "artifact_upload_session",
                ctx.org_id,
                &session.id.to_string(),
                &session,
            )
            .await?;
        data.insert_artifact_upload_session(session.clone());
        session
    };
    let artifact_store = ArtifactByteStore::for_upload(config)?;
    cleanup_session_files(&artifact_store, &session).await?;
    let mut data = store.data.lock().await;
    let mut session = upload_session_in_data(&data, ctx, upload_session_id)?;
    if matches!(
        session.state.as_str(),
        "active" | "provider_completed" | "deduplicated" | "completing"
    ) {
        return Err(AppError::conflict(
            "artifact upload session is already committed or completing",
        ));
    }
    if session.state != "failed" {
        session.state = "failed".to_string();
        session.updated_at = Utc::now();
        store
            .persist_locked(
                "artifact_upload_session",
                ctx.org_id,
                &session.id.to_string(),
                &session,
            )
            .await?;
        data.insert_artifact_upload_session(session.clone());
    }
    Ok(json!({ "upload_session": { "id": session.id, "state": session.state } }))
}

pub async fn cleanup_expired_artifact_uploads(store: &Store, config: &AppConfig) -> AppResult<u64> {
    let expired_ids = {
        let data = store.data.lock().await;
        let now = Utc::now();
        data.artifact_upload_sessions
            .values()
            .filter(|session| session.state == "uploading" && session.expires_at <= now)
            .map(|session| session.id)
            .collect::<Vec<_>>()
    };
    if expired_ids.is_empty() {
        return Ok(0);
    }
    let artifact_store = ArtifactByteStore::for_upload(config)?;
    let mut cleaned = 0u64;
    for session_id in expired_ids {
        let session = {
            let mut data = store.data.lock().await;
            let Some(mut session) = data.artifact_upload_sessions.get(&session_id).cloned() else {
                continue;
            };
            if session.state != "uploading" || session.expires_at > Utc::now() {
                continue;
            }
            session.state = "aborting".to_string();
            session.updated_at = Utc::now();
            store
                .persist_locked(
                    "artifact_upload_session",
                    session.org_id,
                    &session.id.to_string(),
                    &session,
                )
                .await?;
            data.insert_artifact_upload_session(session.clone());
            session
        };
        cleanup_session_files(&artifact_store, &session).await?;
        let mut data = store.data.lock().await;
        if let Some(mut session) = data.artifact_upload_sessions.get(&session_id).cloned() {
            if session.state == "aborting" {
                session.state = "failed".to_string();
                session.updated_at = Utc::now();
                store
                    .persist_locked(
                        "artifact_upload_session",
                        session.org_id,
                        &session.id.to_string(),
                        &session,
                    )
                    .await?;
                data.insert_artifact_upload_session(session);
                cleaned += 1;
            }
        }
    }
    Ok(cleaned)
}

pub async fn list_artifact_collections(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_COLLECTION_LIMIT,
        MAX_COLLECTION_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let project_filter = query.get("project").map(String::as_str);
    let restricted_project_id = ctx.auth.as_ref().and_then(|auth| auth.project_id);
    let type_filter = query.get("type").map(String::as_str);
    let q = query.get("q").map(|value| value.to_ascii_lowercase());
    let mut rows = data
        .artifact_collections
        .values()
        .filter(|collection| collection.org_id == ctx.org_id && collection.deleted_at.is_none())
        .filter(|collection| {
            restricted_project_id
                .map(|project_id| collection.project_id == project_id)
                .unwrap_or(true)
        })
        .filter(|collection| {
            project_filter
                .map(|project| collection.project == project)
                .unwrap_or(true)
        })
        .filter(|collection| {
            type_filter
                .map(|kind| collection.kind == kind)
                .unwrap_or(true)
        })
        .filter(|collection| {
            q.as_ref()
                .map(|q| collection.name.to_ascii_lowercase().contains(q))
                .unwrap_or(true)
        })
        .map(|collection| collection_summary_value(&data, collection))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        json_string(right, "updated_at").cmp(&json_string(left, "updated_at"))
    });
    let total = rows.len();
    let rows = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    Ok(json!({
        "collections": rows,
        "limit": limit,
        "offset": offset,
        "total": total,
        "has_more": offset + limit < total
    }))
}

pub async fn get_artifact_collection(
    store: &Store,
    ctx: &RequestContext,
    collection_id: Uuid,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let collection = collection_in_data(&data, ctx, collection_id)?;
    Ok(json!({ "collection": collection_summary_value(&data, &collection) }))
}

pub async fn list_artifact_collection_versions(
    store: &Store,
    ctx: &RequestContext,
    collection_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let collection = collection_in_data(&data, ctx, collection_id)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_VERSION_LIMIT,
        MAX_VERSION_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let mut versions = data
        .artifact_versions_by_collection
        .get(&collection.id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifact_versions.get(id))
        .filter(|version| version_is_available(version))
        .map(|version| public_version_value(&data, &collection, version))
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| {
        json_i64_value(right, "version_index").cmp(&json_i64_value(left, "version_index"))
    });
    let total = versions.len();
    let versions = versions
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    Ok(json!({
        "versions": versions,
        "limit": limit,
        "offset": offset,
        "total": total,
        "has_more": offset + limit < total
    }))
}

pub async fn resolve_artifact_version(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let reference = validate_name(query.get("ref").map(String::as_str), "artifact ref")?;
    let kind = query.get("type").map(String::as_str);
    let project = query.get("project").map(String::as_str);
    let (collection, version) = resolve_version_in_data(&data, ctx, &reference, kind, project)?;
    Ok(json!({ "artifact_version": public_version_value(&data, &collection, &version) }))
}

pub async fn get_artifact_version(
    store: &Store,
    ctx: &RequestContext,
    version_id: Uuid,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let (collection, version) = version_in_data(&data, ctx, version_id)?;
    ensure_version_active(&version)?;
    Ok(json!({ "artifact_version": public_version_value(&data, &collection, &version) }))
}

pub async fn list_artifact_manifest(
    store: &Store,
    ctx: &RequestContext,
    version_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let (_collection, version) = version_in_data(&data, ctx, version_id)?;
    ensure_version_active(&version)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_MANIFEST_LIMIT,
        MAX_MANIFEST_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let path_prefix = query.get("path_prefix").map(String::as_str).unwrap_or("");
    let mut entries = manifest_entries_for_version(&data, version.id);
    entries.retain(|entry| entry.path.starts_with(path_prefix));
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let total = entries.len();
    let rows = entries
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|entry| entry.public_row())
        .collect::<Vec<_>>();
    Ok(json!({
        "artifact_version_id": version.id,
        "entries": rows,
        "limit": limit,
        "offset": offset,
        "total": total,
        "has_more": offset + limit < total
    }))
}

pub async fn artifact_version_lineage(
    store: &Store,
    ctx: &RequestContext,
    version_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let (collection, version) = version_in_data(&data, ctx, version_id)?;
    ensure_version_active(&version)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_EDGE_LIMIT,
        MAX_EDGE_LIMIT,
    )? as usize;
    Ok(graph_for_version(&data, &collection, &version, limit))
}

pub async fn create_artifact_input_edge(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateArtifactInputEdgeRequest,
) -> AppResult<Value> {
    ensure_billing_write_allowed(store, ctx.org_id, "mark artifact inputs").await?;
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    let (collection, version) = if let Some(version_id) = input.artifact_version_id {
        version_in_data(&data, ctx, version_id)?
    } else {
        let reference = validate_name(input.reference.as_deref(), "artifact ref")?;
        resolve_version_in_data(
            &data,
            ctx,
            &reference,
            input.kind.as_deref(),
            Some(&run.project),
        )?
    };
    ensure_version_active(&version)?;
    let edge = upsert_artifact_edge_locked(
        store,
        &mut data,
        ArtifactEdgeUpsert {
            org_id: ctx.org_id,
            project_id: run.project_id,
            run_id,
            artifact_version_id: version.id,
            direction: "input",
            source: "sdk",
        },
    )
    .await?;
    Ok(json!({
        "edge": edge,
        "artifact_version": public_version_value(&data, &collection, &version)
    }))
}

pub async fn run_artifact_edges(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_EDGE_LIMIT,
        MAX_EDGE_LIMIT,
    )? as usize;
    let direction = query.get("direction").map(String::as_str).unwrap_or("both");
    let mut edges = data
        .artifact_edges_by_run
        .get(&run.id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifact_edges.get(id))
        .filter(|edge| direction == "both" || edge.direction == direction)
        .cloned()
        .collect::<Vec<_>>();
    edges.sort_by_key(|edge| edge.created_at);
    edges.truncate(limit);
    Ok(json!({ "edges": edges, "limit": limit }))
}

pub async fn set_artifact_alias(
    store: &Store,
    ctx: &RequestContext,
    collection_id: Uuid,
    alias: &str,
    input: SetArtifactAliasRequest,
) -> AppResult<Value> {
    let alias = validate_alias(alias)?;
    let mut data = store.data.lock().await;
    let collection = collection_in_data(&data, ctx, collection_id)?;
    let version = data
        .artifact_versions
        .get(&input.artifact_version_id)
        .cloned()
        .filter(|version| version.collection_id == collection.id && version_is_available(version))
        .ok_or_else(|| AppError::not_found("artifact version not found"))?;
    let reason = require_artifact_confirmation(
        input.confirm.as_deref(),
        input.reason.as_deref(),
        &alias,
        "moving an artifact alias",
    )?;
    upsert_artifact_alias_locked(
        store,
        &mut data,
        ctx.org_id,
        &collection,
        version.id,
        &alias,
        Some(&reason),
    )
    .await?;
    Ok(json!({ "artifact_version": public_version_value(&data, &collection, &version) }))
}

pub async fn delete_artifact_alias(
    store: &Store,
    ctx: &RequestContext,
    collection_id: Uuid,
    alias: &str,
    input: DeleteArtifactAliasRequest,
) -> AppResult<Value> {
    let alias = validate_alias(alias)?;
    let reason = require_artifact_confirmation(
        input.confirm.as_deref(),
        input.reason.as_deref(),
        &alias,
        "deleting an artifact alias",
    )?;
    let mut data = store.data.lock().await;
    let collection = collection_in_data(&data, ctx, collection_id)?;
    let Some(existing) = data
        .artifact_aliases
        .get(&(collection.id, alias.clone()))
        .cloned()
    else {
        return Ok(json!({ "deleted": false }));
    };
    let row = ArtifactAliasRow {
        deleted_at: Some(Utc::now()),
        updated_at: Utc::now(),
        audit_reason: Some(reason),
        ..existing
    };
    store
        .persist_locked(
            "artifact_alias",
            ctx.org_id,
            &format!("{}:{}", collection.id, alias),
            &row,
        )
        .await?;
    data.insert_artifact_alias(row);
    Ok(json!({ "deleted": true }))
}

pub async fn update_artifact_retention(
    store: &Store,
    ctx: &RequestContext,
    version_id: Uuid,
    input: UpdateArtifactRetentionRequest,
) -> AppResult<Value> {
    let mut data = store.data.lock().await;
    let (collection, mut version) = version_in_data(&data, ctx, version_id)?;
    let (mode, ttl_days) = normalize_retention_update(input.retention_mode, input.ttl_days)?;
    let reason = require_artifact_confirmation(
        input.confirm.as_deref(),
        input.reason.as_deref(),
        &version.id.to_string(),
        "updating artifact retention",
    )?;
    version.retention_mode = mode;
    version.ttl_days = ttl_days;
    version.expires_at = ttl_days.map(|days| version.created_at + ChronoDuration::days(days));
    version.audit_reason = Some(reason);
    store
        .persist_locked(
            "artifact_version",
            ctx.org_id,
            &version.id.to_string(),
            &version,
        )
        .await?;
    data.insert_artifact_version(version.clone());
    Ok(json!({ "artifact_version": public_version_value(&data, &collection, &version) }))
}

pub async fn delete_artifact_version(
    store: &Store,
    ctx: &RequestContext,
    version_id: Uuid,
    input: DeleteArtifactVersionRequest,
) -> AppResult<Value> {
    let mut data = store.data.lock().await;
    let (collection, mut version) = version_in_data(&data, ctx, version_id)?;
    let reason = require_artifact_confirmation(
        input.confirm.as_deref(),
        input.reason.as_deref(),
        &version.id.to_string(),
        "deleting an artifact version",
    )?;
    let aliases = custom_aliases_for_version(&data, collection.id, version.id);
    if !aliases.is_empty() && input.delete_aliases != Some(true) {
        return Err(AppError::conflict(
            "artifact version has aliases; pass delete_aliases=true after confirmation",
        ));
    }
    if input.delete_aliases == Some(true) {
        for alias in aliases {
            if let Some(existing) = data
                .artifact_aliases
                .get(&(collection.id, alias.clone()))
                .cloned()
            {
                let row = ArtifactAliasRow {
                    deleted_at: Some(Utc::now()),
                    updated_at: Utc::now(),
                    audit_reason: Some(reason.clone()),
                    ..existing
                };
                store
                    .persist_locked(
                        "artifact_alias",
                        ctx.org_id,
                        &format!("{}:{}", collection.id, alias),
                        &row,
                    )
                    .await?;
                data.insert_artifact_alias(row);
            }
        }
    }
    version.state = "soft_deleted".to_string();
    version.delete_requested_at = Some(Utc::now());
    version.audit_reason = Some(reason);
    store
        .persist_locked(
            "artifact_version",
            ctx.org_id,
            &version.id.to_string(),
            &version,
        )
        .await?;
    data.insert_artifact_version(version.clone());
    Ok(json!({ "artifact_version": public_version_value(&data, &collection, &version) }))
}

pub async fn artifact_entry_for_context(
    store: &Store,
    ctx: &RequestContext,
    entry_id: Uuid,
) -> AppResult<(ArtifactManifestEntryRow, ArtifactVersionRow)> {
    let data = store.data.lock().await;
    let (version_id, chunk_index, index) = data
        .artifact_entries_by_id
        .get(&entry_id)
        .copied()
        .ok_or_else(|| AppError::not_found("artifact entry not found"))?;
    let version = data
        .artifact_versions
        .get(&version_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact version not found"))?;
    ensure_version_active(&version)?;
    let collection = data
        .artifact_collections
        .get(&version.collection_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact collection not found"))?;
    if collection.org_id != ctx.org_id {
        return Err(AppError::not_found("artifact entry not found"));
    }
    if ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .is_some_and(|project_id| project_id != collection.project_id)
    {
        return Err(AppError::forbidden(
            "artifact belongs to a different project",
        ));
    }
    let chunk = data
        .artifact_manifest_chunks
        .get(&(version_id, chunk_index))
        .ok_or_else(|| AppError::not_found("artifact entry not found"))?;
    let entry = chunk
        .entries
        .get(index)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact entry not found"))?;
    if !matches!(entry.storage_backend.as_str(), "local" | "r2") {
        return Err(AppError::not_found("artifact entry bytes not found"));
    }
    Ok((entry, version))
}

fn upload_session_response_with_parts(
    session: &ArtifactUploadSessionRow,
    parts_by_entry: &HashMap<Uuid, Vec<crate::artifact_store::PresignedUploadPart>>,
) -> Value {
    json!({
        "upload_session": {
            "id": session.id,
            "artifact_version_id": session.artifact_version_id,
            "expires_at": session.expires_at,
            "part_size_bytes": session.files.first().map(|file| file.part_size_bytes).unwrap_or(0)
        },
        "files": session.files.iter().map(|file| upload_file_value(
            file,
            parts_by_entry.get(&file.entry_id).cloned().unwrap_or_default()
        )).collect::<Vec<_>>()
    })
}

fn upload_file_value(
    file: &ArtifactUploadFile,
    parts: Vec<crate::artifact_store::PresignedUploadPart>,
) -> Value {
    json!({
        "entry_id": file.entry_id,
        "path": file.path,
        "upload_kind": if file.storage_backend == "local" {
            "inline".to_string()
        } else if file.multipart_upload_id.is_some() {
            "multipart".to_string()
        } else {
            "put".to_string()
        },
        "part_size_bytes": file.part_size_bytes,
        "part_count": file.part_count,
        "parts": parts.into_iter().map(presigned_part_value).collect::<Vec<_>>()
    })
}

fn presigned_part_value(part: crate::artifact_store::PresignedUploadPart) -> Value {
    json!({
        "part_number": part.part_number,
        "url": part.url,
        "expires_at": part.expires_at,
        "required_headers": part.required_headers
    })
}

fn collection_summary_value(data: &StoreData, collection: &ArtifactCollectionRow) -> Value {
    let latest = latest_active_version_in_data(data, collection.id);
    let best = data
        .artifact_aliases
        .get(&(collection.id, "best".to_string()))
        .and_then(|alias| data.artifact_versions.get(&alias.artifact_version_id))
        .filter(|version| version_is_available(version));
    let collection_versions = data
        .artifact_versions_by_collection
        .get(&collection.id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifact_versions.get(id))
        .filter(|version| version.deleted_at.is_none())
        .collect::<Vec<_>>();
    let active_versions = collection_versions
        .iter()
        .copied()
        .filter(|version| version_is_available(version))
        .collect::<Vec<_>>();
    let retained_bytes = active_versions
        .iter()
        .map(|version| version.size_bytes)
        .sum::<i64>();
    let pending_delete_bytes = collection_versions
        .iter()
        .filter(|version| version.state == "soft_deleted" || version.delete_requested_at.is_some())
        .map(|version| version.size_bytes)
        .sum::<i64>();
    json!({
        "id": collection.id,
        "org_id": collection.org_id,
        "project_id": collection.project_id,
        "project": collection.project,
        "name": collection.name,
        "type": collection.kind,
        "description": collection.description,
        "metadata": collection.metadata,
        "versions_count": active_versions.len(),
        "retained_bytes": retained_bytes,
        "pending_delete_bytes": pending_delete_bytes,
        "latest_version": latest.map(|version| public_version_value(data, collection, &version)),
        "best_version": best.map(|version| public_version_value(data, collection, version)),
        "created_at": collection.created_at,
        "updated_at": collection.updated_at
    })
}

fn public_version_value(
    data: &StoreData,
    collection: &ArtifactCollectionRow,
    version: &ArtifactVersionRow,
) -> Value {
    let aliases = aliases_for_version(data, collection.id, version.id);
    json!({
        "id": version.id,
        "org_id": version.org_id,
        "project_id": version.project_id,
        "collection_id": version.collection_id,
        "name": collection.name,
        "type": collection.kind,
        "version": version.version_label(),
        "version_index": version.version_index,
        "aliases": aliases,
        "digest": version.digest,
        "source_run_id": version.source_run_id,
        "source_step": version.source_step,
        "file_count": version.file_count,
        "size_bytes": version.size_bytes,
        "state": version.state,
        "metadata": version.metadata,
        "ttl_days": version.ttl_days,
        "retention_mode": version.retention_mode,
        "expires_at": version.expires_at,
        "delete_requested_at": version.delete_requested_at,
        "deleted_at": version.deleted_at,
        "audit_reason": version.audit_reason,
        "created_at": version.created_at
    })
}

fn aliases_for_version(data: &StoreData, collection_id: Uuid, version_id: Uuid) -> Vec<String> {
    let mut aliases = Vec::new();
    if latest_active_version_in_data(data, collection_id)
        .is_some_and(|latest| latest.id == version_id)
    {
        aliases.push("latest".to_string());
    }
    aliases.extend(custom_aliases_for_version(data, collection_id, version_id));
    aliases.sort();
    aliases
}

fn custom_aliases_for_version(
    data: &StoreData,
    collection_id: Uuid,
    version_id: Uuid,
) -> Vec<String> {
    data.artifact_aliases
        .values()
        .filter(|alias| {
            alias.collection_id == collection_id && alias.artifact_version_id == version_id
        })
        .map(|alias| alias.alias.clone())
        .collect()
}

fn active_version_with_digest_in_data(
    data: &StoreData,
    collection_id: Uuid,
    digest: &str,
) -> Option<ArtifactVersionRow> {
    data.artifact_versions_by_collection
        .get(&collection_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifact_versions.get(id))
        .find(|version| version.digest == digest && version_is_available(version))
        .cloned()
}

fn initiate_idempotency_response_is_live(data: &StoreData, response: &Value) -> bool {
    let Some(session_id) = response
        .get("upload_session")
        .and_then(|session| session.get("id"))
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
    else {
        return true;
    };
    data.artifact_upload_sessions
        .get(&session_id)
        .is_some_and(|session| {
            session.expires_at > Utc::now()
                && matches!(
                    session.state.as_str(),
                    "uploading" | "completing" | "provider_completed"
                )
        })
}

async fn cleanup_session_files(
    artifact_store: &ArtifactByteStore,
    session: &ArtifactUploadSessionRow,
) -> AppResult<()> {
    for file in &session.files {
        if let Some(storage_key) = file.storage_key.as_deref() {
            artifact_store
                .abort_versioned_upload(storage_key, file.multipart_upload_id.as_deref())
                .await?;
        }
    }
    Ok(())
}

fn require_artifact_confirmation(
    confirm: Option<&str>,
    reason: Option<&str>,
    expected: &str,
    action: &str,
) -> AppResult<String> {
    if confirm.map(str::trim) != Some(expected) {
        return Err(AppError::validation(format!(
            "{action} requires confirm={expected}"
        )));
    }
    let reason = validate_name(reason, "audit reason")?;
    Ok(reason)
}

#[derive(Clone, Copy)]
struct ArtifactEdgeUpsert<'a> {
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    artifact_version_id: Uuid,
    direction: &'a str,
    source: &'a str,
}

async fn upsert_artifact_edge_locked(
    store: &Store,
    data: &mut StoreData,
    input: ArtifactEdgeUpsert<'_>,
) -> AppResult<ArtifactEdgeRow> {
    if let Some(existing) = data
        .artifact_edges_by_run
        .get(&input.run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifact_edges.get(id))
        .find(|edge| {
            edge.artifact_version_id == input.artifact_version_id
                && edge.direction == input.direction
        })
        .cloned()
    {
        return Ok(existing);
    }
    let edge = ArtifactEdgeRow {
        id: Uuid::new_v4(),
        org_id: input.org_id,
        project_id: input.project_id,
        run_id: input.run_id,
        artifact_version_id: input.artifact_version_id,
        direction: input.direction.to_string(),
        source: input.source.to_string(),
        created_at: Utc::now(),
    };
    store
        .persist_locked("artifact_edge", input.org_id, &edge.id.to_string(), &edge)
        .await?;
    data.insert_artifact_edge(edge.clone());
    Ok(edge)
}

async fn upsert_artifact_alias_locked(
    store: &Store,
    data: &mut StoreData,
    org_id: Uuid,
    collection: &ArtifactCollectionRow,
    artifact_version_id: Uuid,
    alias: &str,
    audit_reason: Option<&str>,
) -> AppResult<()> {
    let existing = data
        .artifact_aliases
        .get(&(collection.id, alias.to_string()))
        .cloned();
    let row = ArtifactAliasRow {
        id: existing
            .as_ref()
            .map(|existing| existing.id)
            .unwrap_or_else(Uuid::new_v4),
        org_id,
        project_id: collection.project_id,
        collection_id: collection.id,
        artifact_version_id,
        alias: alias.to_string(),
        created_at: existing
            .as_ref()
            .map(|existing| existing.created_at)
            .unwrap_or_else(Utc::now),
        updated_at: Utc::now(),
        deleted_at: None,
        audit_reason: audit_reason.map(str::to_string).or_else(|| {
            existing
                .as_ref()
                .and_then(|existing| existing.audit_reason.clone())
        }),
    };
    store
        .persist_locked(
            "artifact_alias",
            org_id,
            &format!("{}:{}", collection.id, alias),
            &row,
        )
        .await?;
    data.insert_artifact_alias(row);
    Ok(())
}

fn latest_active_version_in_data(
    data: &StoreData,
    collection_id: Uuid,
) -> Option<ArtifactVersionRow> {
    data.artifact_versions_by_collection
        .get(&collection_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifact_versions.get(id))
        .filter(|version| version_is_available(version))
        .max_by_key(|version| version.version_index)
        .cloned()
}

fn next_version_index_in_data(data: &StoreData, collection_id: Uuid) -> i64 {
    data.artifact_versions_by_collection
        .get(&collection_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifact_versions.get(id))
        .map(|version| version.version_index + 1)
        .max()
        .unwrap_or(0)
}

fn collection_in_data(
    data: &StoreData,
    ctx: &RequestContext,
    collection_id: Uuid,
) -> AppResult<ArtifactCollectionRow> {
    let collection = data
        .artifact_collections
        .get(&collection_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact collection not found"))?;
    if collection.org_id != ctx.org_id {
        return Err(AppError::not_found("artifact collection not found"));
    }
    if ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .is_some_and(|project_id| project_id != collection.project_id)
    {
        return Err(AppError::forbidden(
            "artifact collection belongs to a different project",
        ));
    }
    Ok(collection)
}

fn version_in_data(
    data: &StoreData,
    ctx: &RequestContext,
    version_id: Uuid,
) -> AppResult<(ArtifactCollectionRow, ArtifactVersionRow)> {
    let version = data
        .artifact_versions
        .get(&version_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact version not found"))?;
    let collection = collection_in_data(data, ctx, version.collection_id)?;
    Ok((collection, version))
}

fn ensure_version_active(version: &ArtifactVersionRow) -> AppResult<()> {
    if version_is_available(version) {
        Ok(())
    } else {
        Err(AppError::new(
            axum::http::StatusCode::GONE,
            "artifact version is deleted or expired",
        ))
    }
}

fn version_is_available(version: &ArtifactVersionRow) -> bool {
    version.state == "active"
        && version.delete_requested_at.is_none()
        && version
            .expires_at
            .map(|expires_at| expires_at > Utc::now())
            .unwrap_or(true)
}

fn upload_session_in_data(
    data: &StoreData,
    ctx: &RequestContext,
    upload_session_id: Uuid,
) -> AppResult<ArtifactUploadSessionRow> {
    let session = data
        .artifact_upload_sessions
        .get(&upload_session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact upload session not found"))?;
    if session.org_id != ctx.org_id {
        return Err(AppError::not_found("artifact upload session not found"));
    }
    let run = data
        .runs
        .get(&session.run_id)
        .ok_or_else(|| AppError::not_found("run not found"))?;
    ensure_run_access_in_data(ctx, run)?;
    Ok(session)
}

fn resolve_version_in_data(
    data: &StoreData,
    ctx: &RequestContext,
    reference: &str,
    kind: Option<&str>,
    project: Option<&str>,
) -> AppResult<(ArtifactCollectionRow, ArtifactVersionRow)> {
    let (prefix, selector) = reference.rsplit_once(':').unwrap_or((reference, "latest"));
    let segments = prefix.split('/').collect::<Vec<_>>();
    let (project_name, kind_name, collection_name) = match segments.as_slice() {
        [name] => (project, kind, *name),
        [kind_name, name] => (project, Some(*kind_name), *name),
        [project_name, kind_name, name] => (Some(*project_name), Some(*kind_name), *name),
        _ => return Err(AppError::validation("artifact ref is invalid")),
    };
    let collection_name = validate_collection_name(Some(collection_name))?;
    let mut candidates = data
        .artifact_collections
        .values()
        .filter(|collection| {
            collection.org_id == ctx.org_id
                && collection.name == collection_name
                && collection.deleted_at.is_none()
        })
        .filter(|collection| {
            project_name
                .map(|project| collection.project == project)
                .unwrap_or(true)
        })
        .filter(|collection| {
            kind_name
                .map(|kind| collection.kind == kind)
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| candidate.created_at);
    let collection = match candidates.len() {
        1 => candidates.remove(0),
        0 => return Err(AppError::not_found("artifact collection not found")),
        _ => {
            return Err(AppError::validation(
                "artifact ref is ambiguous; pass project and type",
            ))
        }
    };
    if ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .is_some_and(|project_id| project_id != collection.project_id)
    {
        return Err(AppError::forbidden(
            "artifact collection belongs to a different project",
        ));
    }
    let version = if selector == "latest" {
        latest_active_version_in_data(data, collection.id)
    } else if let Some(number) = selector.strip_prefix('v') {
        let index = number
            .parse::<i64>()
            .map_err(|_| AppError::validation("artifact version ref is invalid"))?;
        data.artifact_versions_by_collection
            .get(&collection.id)
            .into_iter()
            .flatten()
            .filter_map(|id| data.artifact_versions.get(id))
            .find(|version| version.version_index == index && version_is_available(version))
            .cloned()
    } else {
        data.artifact_aliases
            .get(&(collection.id, selector.to_string()))
            .and_then(|alias| data.artifact_versions.get(&alias.artifact_version_id))
            .filter(|version| version_is_available(version))
            .cloned()
    }
    .ok_or_else(|| AppError::not_found("artifact version not found"))?;
    Ok((collection, version))
}

fn manifest_entries_for_version(
    data: &StoreData,
    version_id: Uuid,
) -> Vec<ArtifactManifestEntryRow> {
    let mut chunks = data
        .artifact_manifest_chunks
        .iter()
        .filter(|((candidate, _), _)| *candidate == version_id)
        .map(|((_, chunk_index), chunk)| (*chunk_index, chunk.clone()))
        .collect::<Vec<_>>();
    chunks.sort_by_key(|(chunk_index, _)| *chunk_index);
    chunks
        .into_iter()
        .flat_map(|(_, chunk)| chunk.entries)
        .collect()
}

fn graph_for_version(
    data: &StoreData,
    collection: &ArtifactCollectionRow,
    version: &ArtifactVersionRow,
    limit: usize,
) -> Value {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    nodes.push(json!({
        "id": format!("artifact-version:{}", version.id),
        "kind": "artifact_version",
        "label": format!("{}:{}", collection.name, version.version_label()),
        "summary": { "aliases": aliases_for_version(data, collection.id, version.id) },
        "state": version.state
    }));
    for edge in data
        .artifact_edges_by_version
        .get(&version.id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifact_edges.get(id))
        .take(limit)
    {
        if let Some(run) = data.runs.get(&edge.run_id) {
            nodes.push(json!({
                "id": format!("run:{}", run.id),
                "kind": "run",
                "label": run.name,
                "summary": { "project": run.project, "status": run.status },
                "state": run.status
            }));
            let (from, to) = if edge.direction == "input" {
                (
                    format!("artifact-version:{}", version.id),
                    format!("run:{}", run.id),
                )
            } else {
                (
                    format!("run:{}", run.id),
                    format!("artifact-version:{}", version.id),
                )
            };
            edges.push(json!({
                "from": from,
                "to": to,
                "direction": edge.direction
            }));
        }
    }
    nodes.sort_by_key(|node| json_string(node, "id"));
    nodes.dedup_by(|left, right| json_string(left, "id") == json_string(right, "id"));
    json!({
        "nodes": nodes,
        "edges": edges,
        "truncated": edges.len() >= limit,
        "limit": limit,
        "depth": 2
    })
}

fn normalize_manifest_entries(
    entries: Vec<VersionedArtifactManifestEntryInput>,
) -> AppResult<Vec<NormalizedManifestEntry>> {
    if entries.is_empty() {
        return Err(AppError::validation(
            "artifact manifest requires at least one entry",
        ));
    }
    if entries.len() > MAX_MANIFEST_ENTRIES {
        return Err(AppError::validation(format!(
            "artifact manifest can include at most {MAX_MANIFEST_ENTRIES} entries"
        )));
    }
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for input in entries {
        let path = normalize_manifest_path(&input.path)?;
        if !seen.insert(path.clone()) {
            return Err(AppError::validation(
                "artifact manifest paths must be unique",
            ));
        }
        let reference_uri = input.reference_uri.and_then(|uri| {
            let trimmed = uri.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        let kind = input.kind.unwrap_or_else(|| {
            if reference_uri.is_some() {
                "reference".to_string()
            } else {
                "file".to_string()
            }
        });
        if !matches!(kind.as_str(), "file" | "reference" | "directory") {
            return Err(AppError::validation(
                "manifest entry kind must be file, directory, or reference",
            ));
        }
        let size_bytes = input
            .size_bytes
            .as_ref()
            .map(validate_size_bytes)
            .transpose()?;
        if let Some(size_bytes) = size_bytes {
            if size_bytes <= 0 || size_bytes > MAX_VERSIONED_ARTIFACT_FILE_BYTES {
                return Err(AppError::validation(
                    "stored manifest entry size_bytes must be between 1 byte and 5 TiB",
                ));
            }
        }
        let sha256 = input.sha256.map(validate_sha256).transpose()?;
        if reference_uri.is_none() && (size_bytes.is_none() || sha256.is_none()) {
            return Err(AppError::validation(
                "stored manifest entries require size_bytes and sha256",
            ));
        }
        normalized.push(NormalizedManifestEntry {
            id: Uuid::new_v4(),
            path,
            kind,
            size_bytes,
            sha256,
            mime_type: input.mime_type,
            reference_uri,
        });
    }
    normalized.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(normalized)
}

fn normalize_manifest_path(path: &str) -> AppResult<String> {
    let trimmed = path.trim();
    if trimmed.is_empty()
        || trimmed.len() > 1024
        || trimmed.starts_with('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(char::is_control)
    {
        return Err(AppError::validation(
            "manifest path must be a relative slash path",
        ));
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || matches!(part, "." | "..") {
            return Err(AppError::validation(
                "manifest path cannot contain empty, '.', or '..' segments",
            ));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

fn validate_collection_name(value: Option<&str>) -> AppResult<String> {
    let name = validate_name(value, "artifact collection name")?;
    if name.contains('/') || name.contains(':') {
        return Err(AppError::validation(
            "artifact collection name cannot contain / or :",
        ));
    }
    Ok(name)
}

fn validate_artifact_collection_type(kind: &str) -> AppResult<String> {
    let kind = validate_name(Some(kind), "artifact type")?;
    if matches!(
        kind.as_str(),
        "model" | "dataset" | "checkpoint" | "table" | "media" | "file"
    ) {
        Ok(kind)
    } else {
        Err(AppError::validation(
            "artifact type must be one of: model, dataset, checkpoint, table, media, file",
        ))
    }
}

fn validate_aliases(aliases: Vec<String>) -> AppResult<Vec<String>> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for alias in aliases {
        let alias = validate_alias(&alias)?;
        if seen.insert(alias.clone()) {
            out.push(alias);
        }
    }
    Ok(out)
}

fn validate_alias(alias: &str) -> AppResult<String> {
    let alias = validate_name(Some(alias), "artifact alias")?;
    if alias == "latest"
        || alias.starts_with('v') && alias[1..].chars().all(|ch| ch.is_ascii_digit())
    {
        return Err(AppError::validation("latest and vN aliases are reserved"));
    }
    if alias.len() > 64
        || !alias.chars().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '-' | '.')
        })
    {
        return Err(AppError::validation(
            "artifact alias must use lowercase letters, digits, _, -, or .",
        ));
    }
    Ok(alias)
}

fn validate_sha256(value: String) -> AppResult<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err(AppError::validation(
            "sha256 must be a 64-character hex digest",
        ))
    }
}

fn validate_ttl_days(value: Option<i64>) -> AppResult<Option<i64>> {
    match value {
        Some(days) if (1..=3650).contains(&days) => Ok(Some(days)),
        Some(_) => Err(AppError::validation("ttl_days must be between 1 and 3650")),
        None => Ok(None),
    }
}

fn normalize_retention_update(
    retention_mode: Option<String>,
    ttl_days: Option<i64>,
) -> AppResult<(String, Option<i64>)> {
    let mode = retention_mode.unwrap_or_else(|| "inherit".to_string());
    let mode = match mode.as_str() {
        "inherit" | "days" | "keep_forever" | "none" => mode,
        "forever" => "keep_forever".to_string(),
        _ => {
            return Err(AppError::validation(
                "retention_mode must be inherit, days, keep_forever, forever, or none",
            ))
        }
    };
    let ttl_days = validate_ttl_days(ttl_days)?;
    if mode == "days" && ttl_days.is_none() {
        return Err(AppError::validation(
            "ttl_days is required for days retention",
        ));
    }
    if mode != "days" && ttl_days.is_some() {
        return Err(AppError::validation(
            "ttl_days is only valid for days retention",
        ));
    }
    Ok((mode, ttl_days))
}

fn validate_complete_file_ids(
    expected_entry_ids: impl IntoIterator<Item = Uuid>,
    completed_files: &[CompleteArtifactUploadFile],
) -> AppResult<()> {
    let expected = expected_entry_ids.into_iter().collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    for file in completed_files {
        if !seen.insert(file.entry_id) {
            return Err(AppError::validation(
                "complete request includes duplicate upload files",
            ));
        }
        if !expected.contains(&file.entry_id) {
            return Err(AppError::validation(
                "complete request includes an unknown upload file",
            ));
        }
    }
    if seen.len() != expected.len() {
        return Err(AppError::validation(
            "complete request is missing an upload file",
        ));
    }
    Ok(())
}

fn manifest_digest(entries: &[NormalizedManifestEntry]) -> String {
    let mut text = String::new();
    for entry in entries {
        text.push_str(&entry.path);
        text.push('\0');
        text.push_str(&entry.kind);
        text.push('\0');
        text.push_str(&entry.size_bytes.map(|v| v.to_string()).unwrap_or_default());
        text.push('\0');
        text.push_str(entry.sha256.as_deref().unwrap_or(""));
        text.push('\0');
        text.push_str(entry.reference_uri.as_deref().unwrap_or(""));
        text.push('\n');
    }
    format!(
        "sha256:{}",
        hex_bytes_local(sha2::Sha256::digest(text.as_bytes()))
    )
}

fn manifest_chunks(
    entries: &[ArtifactManifestEntryRow],
) -> AppResult<Vec<ArtifactManifestEntriesRecord>> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut current_size = 0usize;
    let mut chunk_index = 0i64;
    for entry in entries {
        let size = serde_json::to_vec(entry)
            .map_err(|_| AppError::internal("manifest entry serialization failed"))?
            .len();
        if size > MAX_MANIFEST_CHUNK_BYTES {
            return Err(AppError::validation(
                "manifest entry metadata exceeds the per-entry size limit",
            ));
        }
        if !current.is_empty() && current_size + size > MAX_MANIFEST_CHUNK_BYTES {
            chunks.push(chunk_record(chunk_index, &current));
            chunk_index += 1;
            current = Vec::new();
            current_size = 0;
        }
        current_size += size;
        current.push(entry.clone());
    }
    if !current.is_empty() {
        chunks.push(chunk_record(chunk_index, &current));
    }
    Ok(chunks)
}

fn chunk_record(
    chunk_index: i64,
    entries: &[ArtifactManifestEntryRow],
) -> ArtifactManifestEntriesRecord {
    let first = entries.first().expect("chunk has entries");
    ArtifactManifestEntriesRecord {
        org_id: first.org_id,
        project_id: first.project_id,
        collection_id: first.collection_id,
        artifact_version_id: first.artifact_version_id,
        chunk_index,
        entries: entries.to_vec(),
    }
}

async fn persist_idempotency_response(
    store: &Store,
    org_id: Uuid,
    key: &str,
    request_hash: Vec<u8>,
    response: Value,
) -> AppResult<()> {
    let record = IdempotencyRecord {
        org_id,
        key: key.to_string(),
        request_hash,
        response_json: response,
        expires_at: Utc::now() + ChronoDuration::days(7),
    };
    store
        .persist_locked("idempotency", org_id, key, &record)
        .await?;
    store
        .data
        .lock()
        .await
        .idempotency
        .insert((org_id, key.to_string()), record);
    Ok(())
}

fn hex_bytes_local(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn json_i64_value(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_path_rejects_traversal() {
        assert!(normalize_manifest_path("checkpoint.pt").is_ok());
        assert!(normalize_manifest_path("tokenizer/config.json").is_ok());
        assert!(normalize_manifest_path("../secret").is_err());
        assert!(normalize_manifest_path("/absolute").is_err());
        assert!(normalize_manifest_path("nested//file").is_err());
        assert!(normalize_manifest_path("nested\\file").is_err());
    }

    #[test]
    fn aliases_reject_reserved_names() {
        assert!(validate_alias("best").is_ok());
        assert!(validate_alias("latest").is_err());
        assert!(validate_alias("v12").is_err());
        assert!(validate_alias("NotLower").is_err());
    }

    #[test]
    fn retention_update_accepts_forever_alias_and_scopes_ttl() {
        assert_eq!(
            normalize_retention_update(Some("forever".to_string()), None).unwrap(),
            ("keep_forever".to_string(), None)
        );
        assert_eq!(
            normalize_retention_update(Some("days".to_string()), Some(30)).unwrap(),
            ("days".to_string(), Some(30))
        );
        assert!(normalize_retention_update(Some("days".to_string()), None).is_err());
        assert!(normalize_retention_update(Some("keep_forever".to_string()), Some(30)).is_err());
    }

    #[test]
    fn complete_file_ids_require_exact_manifest_set() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let file = |entry_id| CompleteArtifactUploadFile {
            entry_id,
            parts: None,
            content_base64: None,
        };
        assert!(validate_complete_file_ids([first, second], &[file(first), file(second)]).is_ok());
        assert!(validate_complete_file_ids([first, second], &[file(first)]).is_err());
        assert!(validate_complete_file_ids([first], &[file(first), file(first)]).is_err());
        assert!(validate_complete_file_ids([first], &[file(second)]).is_err());
    }

    #[test]
    fn available_versions_exclude_expired_deleted_and_pending_delete_rows() {
        let now = Utc::now();
        let mut version = ArtifactVersionRow {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            collection_id: Uuid::new_v4(),
            version_index: 0,
            digest: "digest".to_string(),
            source_run_id: None,
            source_step: None,
            file_count: 1,
            size_bytes: 1,
            state: "active".to_string(),
            metadata: json!({}),
            ttl_days: None,
            retention_mode: "inherit".to_string(),
            expires_at: None,
            delete_requested_at: None,
            deleted_at: None,
            audit_reason: None,
            created_at: now,
        };
        assert!(version_is_available(&version));
        version.expires_at = Some(now - ChronoDuration::seconds(1));
        assert!(!version_is_available(&version));
        version.expires_at = None;
        version.delete_requested_at = Some(now);
        assert!(!version_is_available(&version));
        version.delete_requested_at = None;
        version.state = "soft_deleted".to_string();
        assert!(!version_is_available(&version));
    }
}
