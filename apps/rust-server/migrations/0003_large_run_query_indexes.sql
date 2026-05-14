create index if not exists runs_org_created_id_idx
  on runs (org_id, created_at desc, id desc);

create index if not exists runs_org_project_created_id_idx
  on runs (org_id, project_id, created_at desc, id desc);

create index if not exists runs_org_project_name_id_idx
  on runs (org_id, project_id, lower(name), id);

create index if not exists runs_org_name_id_idx
  on runs (org_id, lower(name), id);

create index if not exists runs_org_project_status_name_id_idx
  on runs (org_id, project_id, status, lower(name), id);

create index if not exists runs_org_status_name_id_idx
  on runs (org_id, status, lower(name), id);

create index if not exists runs_org_project_duration_created_id_idx
  on runs (
    org_id,
    project_id,
    (extract(epoch from (finished_at - started_at))) desc nulls last,
    created_at desc,
    id desc
  );

create index if not exists runs_org_duration_created_id_idx
  on runs (
    org_id,
    (extract(epoch from (finished_at - started_at))) desc nulls last,
    created_at desc,
    id desc
  );

create index if not exists metric_series_org_key_latest_run_idx
  on metric_series (org_id, key, latest desc nulls last, run_id);

create index if not exists metric_series_org_key_max_run_idx
  on metric_series (org_id, key, max desc nulls last, run_id);
