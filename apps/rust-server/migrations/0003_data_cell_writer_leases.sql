-- Phase 2/3 scaling prerequisite: app-level single-writer fencing for data
-- cells. Cloud Run instance limits reduce risk, but this table is the
-- correctness boundary used by readiness and data-plane write checks.

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
      CHECK (fence_token >= 1)
);

CREATE INDEX data_cell_writer_leases_expires_idx
    ON data_cell_writer_leases (expires_at);
