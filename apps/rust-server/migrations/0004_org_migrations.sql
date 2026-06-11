-- Phase 5A backend scaling primitive: resumable org migration control state.
--
-- This slice supports planning, write-blocking the source route, and restoring
-- source writes. Copy/cutover/completion are intentionally modeled but not
-- activated by the Rust API until a later accepted Phase 5B design lands.

CREATE TABLE org_migrations (
    id                       uuid PRIMARY KEY,
    org_id                   uuid NOT NULL REFERENCES organizations (id),
    source_cell_id           text NOT NULL REFERENCES data_cells (cell_id),
    target_cell_id           text NOT NULL REFERENCES data_cells (cell_id),
    source_route_version     bigint NOT NULL,
    target_route_version     bigint,
    state                    text NOT NULL,
    requested_by             text NOT NULL,
    transition_actor         text NOT NULL,
    customer_notice          text,
    legacy_client_approved   boolean NOT NULL DEFAULT false,
    retry_after_seconds      integer NOT NULL DEFAULT 30,
    copy_evidence            jsonb NOT NULL DEFAULT '{}',
    validation_evidence      jsonb NOT NULL DEFAULT '{}',
    restored_route_version   bigint,
    started_at               timestamptz,
    updated_at               timestamptz NOT NULL,
    completed_at             timestamptz,
    failed_at                timestamptz,
    error                    text,
    CONSTRAINT org_migrations_distinct_cells_check
      CHECK (source_cell_id <> target_cell_id),
    CONSTRAINT org_migrations_state_check
      CHECK (state IN (
        'planned',
        'write_blocked',
        'failed',
        'restored',
        'copying',
        'validating',
        'cutover',
        'rollback_window',
        'complete'
      )),
    CONSTRAINT org_migrations_requested_by_check
      CHECK (length(btrim(requested_by)) > 0),
    CONSTRAINT org_migrations_transition_actor_check
      CHECK (length(btrim(transition_actor)) > 0),
    CONSTRAINT org_migrations_retry_after_check
      CHECK (retry_after_seconds >= 1 AND retry_after_seconds <= 3600),
    CONSTRAINT org_migrations_source_route_version_check
      CHECK (source_route_version >= 1),
    CONSTRAINT org_migrations_target_route_version_check
      CHECK (target_route_version IS NULL OR target_route_version >= 1),
    CONSTRAINT org_migrations_restored_route_version_check
      CHECK (restored_route_version IS NULL OR restored_route_version >= 1)
);

CREATE UNIQUE INDEX org_migrations_one_active_per_org_idx
    ON org_migrations (org_id)
    WHERE state NOT IN ('failed', 'restored', 'complete');
CREATE INDEX org_migrations_org_updated_idx
    ON org_migrations (org_id, updated_at DESC);
CREATE INDEX org_migrations_state_updated_idx
    ON org_migrations (state, updated_at DESC);

CREATE TABLE org_migration_events (
    id             uuid PRIMARY KEY,
    migration_id   uuid NOT NULL REFERENCES org_migrations (id),
    org_id         uuid NOT NULL REFERENCES organizations (id),
    from_state     text,
    to_state       text NOT NULL,
    actor          text NOT NULL,
    reason         text,
    route_version  bigint,
    details        jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL,
    CONSTRAINT org_migration_events_to_state_check
      CHECK (to_state IN (
        'planned',
        'write_blocked',
        'failed',
        'restored',
        'copying',
        'validating',
        'cutover',
        'rollback_window',
        'complete'
      )),
    CONSTRAINT org_migration_events_from_state_check
      CHECK (
        from_state IS NULL OR from_state IN (
          'planned',
          'write_blocked',
          'failed',
          'restored',
          'copying',
          'validating',
          'cutover',
          'rollback_window',
          'complete'
        )
      ),
    CONSTRAINT org_migration_events_actor_check
      CHECK (length(btrim(actor)) > 0)
);

CREATE INDEX org_migration_events_migration_created_idx
    ON org_migration_events (migration_id, created_at);
CREATE INDEX org_migration_events_org_created_idx
    ON org_migration_events (org_id, created_at DESC);
