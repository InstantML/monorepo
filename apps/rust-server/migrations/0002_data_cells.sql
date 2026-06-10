-- Phase 1 backend scaling primitives: operator-seeded data-cell registry,
-- tenant-route placement metadata, and route movement audit events.

CREATE TABLE data_cells (
    cell_id                        text PRIMARY KEY,
    environment                    text NOT NULL,
    region                         text NOT NULL,
    tier                           text NOT NULL,
    status                         text NOT NULL,
    service_name                   text NOT NULL,
    public_api_base                text,
    internal_api_base              text,
    clickhouse_endpoint_secret_ref text,
    clickhouse_username_secret_ref text,
    clickhouse_password_secret_ref text,
    clickhouse_database_mode       text,
    max_orgs                       integer,
    max_metric_points_monthly      bigint,
    max_api_requests_monthly       bigint,
    max_retained_bytes             bigint,
    max_disk_usage_pct             integer,
    reserved_headroom_pct          integer,
    last_health_at                 timestamptz,
    last_backup_at                 timestamptz,
    notes                          text,
    created_at                     timestamptz NOT NULL,
    updated_at                     timestamptz NOT NULL,
    CONSTRAINT data_cells_tier_check
      CHECK (tier IN ('free', 'standard', 'premium', 'byoc', 'internal')),
    CONSTRAINT data_cells_status_check
      CHECK (status IN ('open', 'draining', 'full', 'disabled', 'failed')),
    CONSTRAINT data_cells_database_mode_check
      CHECK (
        clickhouse_database_mode IS NULL
        OR clickhouse_database_mode IN ('shared-database', 'per-org-database', 'byoc')
      ),
    CONSTRAINT data_cells_max_orgs_check
      CHECK (max_orgs IS NULL OR max_orgs >= 0),
    CONSTRAINT data_cells_max_metric_points_check
      CHECK (max_metric_points_monthly IS NULL OR max_metric_points_monthly >= 0),
    CONSTRAINT data_cells_max_api_requests_check
      CHECK (max_api_requests_monthly IS NULL OR max_api_requests_monthly >= 0),
    CONSTRAINT data_cells_max_retained_bytes_check
      CHECK (max_retained_bytes IS NULL OR max_retained_bytes >= 0),
    CONSTRAINT data_cells_max_disk_usage_pct_check
      CHECK (max_disk_usage_pct IS NULL OR (max_disk_usage_pct >= 0 AND max_disk_usage_pct <= 100)),
    CONSTRAINT data_cells_reserved_headroom_pct_check
      CHECK (reserved_headroom_pct IS NULL OR (reserved_headroom_pct >= 0 AND reserved_headroom_pct < 100))
);

CREATE UNIQUE INDEX data_cells_environment_cell_idx
    ON data_cells (environment, cell_id);
CREATE UNIQUE INDEX data_cells_environment_service_name_idx
    ON data_cells (environment, service_name);
CREATE UNIQUE INDEX data_cells_environment_public_api_base_idx
    ON data_cells (environment, public_api_base)
    WHERE public_api_base IS NOT NULL;
CREATE UNIQUE INDEX data_cells_environment_internal_api_base_idx
    ON data_cells (environment, internal_api_base)
    WHERE internal_api_base IS NOT NULL;
CREATE INDEX data_cells_environment_tier_status_idx
    ON data_cells (environment, tier, status, cell_id);

ALTER TABLE tenant_routes
    ADD COLUMN cell_id text REFERENCES data_cells (cell_id),
    ADD COLUMN route_version bigint NOT NULL DEFAULT 1,
    ADD COLUMN placement_reason text,
    ADD COLUMN assigned_at timestamptz;

CREATE INDEX tenant_routes_cell_id_idx
    ON tenant_routes (cell_id)
    WHERE cell_id IS NOT NULL;

CREATE TABLE tenant_route_events (
    id            uuid PRIMARY KEY,
    org_id        uuid NOT NULL REFERENCES organizations (id),
    old_cell_id   text,
    new_cell_id   text,
    old_status    text,
    new_status    text NOT NULL,
    route_version bigint NOT NULL,
    actor         text NOT NULL,
    reason        text NOT NULL,
    created_at    timestamptz NOT NULL
);

CREATE INDEX tenant_route_events_org_created_idx
    ON tenant_route_events (org_id, created_at DESC);
CREATE INDEX tenant_route_events_new_cell_created_idx
    ON tenant_route_events (new_cell_id, created_at DESC)
    WHERE new_cell_id IS NOT NULL;
