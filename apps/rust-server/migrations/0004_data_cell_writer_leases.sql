-- Phase 1A backend scaling primitive: one active writer lease per data cell.

CREATE TABLE data_cell_writer_leases (
    cell_id            text PRIMARY KEY REFERENCES data_cells (cell_id),
    fence_token        bigint NOT NULL,
    holder_instance_id text NOT NULL,
    service_name       text NOT NULL,
    revision           text NOT NULL,
    acquired_at        timestamptz NOT NULL,
    heartbeat_at       timestamptz NOT NULL,
    expires_at         timestamptz NOT NULL,
    CONSTRAINT data_cell_writer_leases_fence_token_check
      CHECK (fence_token >= 1),
    CONSTRAINT data_cell_writer_leases_holder_instance_id_check
      CHECK (holder_instance_id <> ''),
    CONSTRAINT data_cell_writer_leases_service_name_check
      CHECK (service_name <> ''),
    CONSTRAINT data_cell_writer_leases_revision_check
      CHECK (revision <> ''),
    CONSTRAINT data_cell_writer_leases_expiry_check
      CHECK (expires_at >= heartbeat_at)
);

CREATE INDEX data_cell_writer_leases_expires_at_idx
    ON data_cell_writer_leases (expires_at);
