-- Metric storage moved to ClickHouse. Drop the Postgres tables that held raw
-- points and maintained aggregates so they cannot drift from the canonical
-- ClickHouse data plane.
--
-- See `apps/rust-server/clickhouse/0001_initial.sql` for the replacement
-- schema and `apps/rust-server/src/metric_store.rs` for the access layer.

drop index if exists metric_points_org_run_key_step_idx;
drop index if exists metric_points_org_run_step_idx;
drop index if exists metric_points_org_created_idx;
drop index if exists metric_points_org_key_created_idx;
drop index if exists metric_series_org_key_best_idx;
drop index if exists metric_series_org_key_latest_run_idx;
drop index if exists metric_series_org_key_max_run_idx;

drop table if exists metric_points;
drop table if exists metric_series;
