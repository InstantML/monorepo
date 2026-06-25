CREATE TABLE embed_sessions (
    id                                   uuid PRIMARY KEY,
    schema_version                       integer NOT NULL,
    org_id                               uuid NOT NULL REFERENCES organizations (id),
    source_api_key_id                    uuid NOT NULL REFERENCES api_keys (id),
    source_service_account_id            uuid NOT NULL REFERENCES service_accounts (id),
    source_project_restriction_id        uuid,
    source_scopes_snapshot               text[] NOT NULL DEFAULT '{}',
    token_hash                           bytea NOT NULL,
    token_prefix                         text NOT NULL,
    run_ids                              uuid[] NOT NULL,
    allowed_parent_origin                text NOT NULL,
    options                              jsonb NOT NULL DEFAULT '{}',
    created_at                           timestamptz NOT NULL,
    expires_at                           timestamptz NOT NULL,
    deleted_at                           timestamptz,
    CONSTRAINT embed_sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX embed_sessions_org_live_idx
    ON embed_sessions (org_id, expires_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX embed_sessions_source_key_live_idx
    ON embed_sessions (source_api_key_id, expires_at DESC)
    WHERE deleted_at IS NULL;
