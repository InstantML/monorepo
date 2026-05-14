create extension if not exists pgcrypto;
create extension if not exists citext;

create table users (
  id uuid primary key default gen_random_uuid(),
  primary_email citext not null unique,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  email citext not null,
  email_verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique,
  name text not null,
  plan_tier text not null default 'free' check (plan_tier in ('free', 'lab', 'startup', 'growth')),
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create table service_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  unique (org_id, id)
);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  service_account_id uuid not null,
  name text not null,
  key_prefix text not null,
  key_hash bytea not null unique,
  scopes text[] not null default array['sdk:ingest'],
  project_id uuid,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  foreign key (org_id, service_account_id) references service_accounts(org_id, id) on delete cascade
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, name)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null,
  name text not null,
  status text not null default 'running' check (status in ('running', 'finished', 'failed')),
  config jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, project_id) references projects(org_id, id) on delete cascade
);

alter table api_keys
  add constraint api_keys_project_scope_fkey
  foreign key (org_id, project_id) references projects(org_id, id);

create table metric_series (
  org_id uuid not null references organizations(id) on delete cascade,
  run_id uuid not null,
  key text not null,
  count bigint not null default 0 check (count >= 0),
  sum double precision not null default 0,
  sum_sq double precision not null default 0,
  min double precision,
  max double precision,
  mean double precision,
  variance double precision,
  latest double precision,
  latest_step double precision,
  latest_logged_at timestamptz,
  best double precision,
  best_step double precision,
  updated_at timestamptz not null default now(),
  primary key (org_id, run_id, key),
  foreign key (org_id, run_id) references runs(org_id, id) on delete cascade
);

create table metric_points (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  run_id uuid not null,
  key text not null,
  step double precision not null check (
    step >= 0
    and step not in ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
  ),
  value double precision not null check (
    value not in ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)
  ),
  logged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (org_id, run_id) references runs(org_id, id) on delete cascade
);

create table attributes (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  run_id uuid not null,
  path text not null,
  type text not null check (type in ('config', 'float_series', 'string_series', 'file', 'file_series', 'histogram_series', 'tag')),
  step double precision check (step is null or step >= 0),
  logged_at timestamptz,
  value jsonb not null,
  summary jsonb not null default '{}'::jsonb,
  artifact_id uuid,
  created_at timestamptz not null default now(),
  foreign key (org_id, run_id) references runs(org_id, id) on delete cascade
);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  run_id uuid not null,
  type text not null check (type in ('checkpoint', 'rollout', 'file')),
  name text not null,
  uri text not null,
  step double precision check (step is null or step >= 0),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  sha256 text,
  mime_type text,
  storage_backend text not null default 'local',
  storage_key text,
  storage_path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, run_id) references runs(org_id, id) on delete cascade
);

alter table attributes
  add constraint attributes_artifact_id_fkey
  foreign key (org_id, artifact_id) references artifacts(org_id, id);

create table imports (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid,
  source_type text not null,
  status text not null default 'completed' check (status in ('dry_run', 'running', 'completed', 'failed')),
  summary jsonb not null default '{}'::jsonb,
  run_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (org_id, project_id) references projects(org_id, id)
);

create table idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  key text not null,
  request_hash bytea not null,
  response_json jsonb not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  unique (org_id, key)
);

create table audit_events (
  id bigint generated always as identity primary key,
  org_id uuid references organizations(id) on delete set null,
  actor_user_id uuid references users(id) on delete set null,
  actor_service_account_id uuid,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (org_id, actor_service_account_id) references service_accounts(org_id, id)
);

create table usage_daily (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  rollup_kind text not null check (rollup_kind in ('daily_snapshot', 'correction')),
  schema_version integer not null default 1 check (schema_version > 0),
  correction_of_rollup_id uuid references usage_daily(id) on delete restrict,
  plan_tier text not null check (plan_tier in ('free', 'lab', 'startup', 'growth')),
  seat_count bigint not null check (seat_count >= 0),
  project_count bigint not null check (project_count >= 0),
  run_count bigint not null check (run_count >= 0),
  metric_point_count bigint not null check (metric_point_count >= 0),
  metric_series_count bigint not null check (metric_series_count >= 0),
  artifact_count bigint not null check (artifact_count >= 0),
  api_key_count bigint not null check (api_key_count >= 0),
  artifact_bytes_exact bigint not null check (artifact_bytes_exact >= 0),
  artifact_bytes_unknown_count bigint not null check (artifact_bytes_unknown_count >= 0),
  estimated_metadata_bytes bigint not null check (estimated_metadata_bytes >= 0),
  estimated_storage_bytes_for_warnings bigint not null check (estimated_storage_bytes_for_warnings >= 0),
  generated_at timestamptz not null default now(),
  check (period_end > period_start),
  check (
    (rollup_kind = 'daily_snapshot' and correction_of_rollup_id is null)
    or (rollup_kind = 'correction' and correction_of_rollup_id is not null)
  )
);

create index user_identities_user_id_idx on user_identities (user_id);
create index memberships_user_id_idx on memberships (user_id);
create index memberships_org_role_idx on memberships (org_id, role);
create index service_accounts_org_id_idx on service_accounts (org_id);
create index api_keys_hash_active_idx on api_keys (key_hash) where revoked_at is null;
create index api_keys_org_active_idx on api_keys (org_id, created_at desc) where revoked_at is null;
create index api_keys_org_expiry_active_idx on api_keys (org_id, expires_at, created_at desc) where revoked_at is null;
create index api_keys_org_project_active_idx on api_keys (org_id, project_id, created_at desc) where revoked_at is null;
create index api_keys_service_account_id_idx on api_keys (service_account_id);
create index projects_org_created_idx on projects (org_id, created_at desc);
create index projects_org_name_idx on projects (org_id, name);
create index runs_project_created_idx on runs (project_id, created_at desc);
create index runs_org_project_created_idx on runs (org_id, project_id, created_at desc, id desc);
create index runs_org_project_status_created_idx on runs (org_id, project_id, status, created_at desc, id desc);
create index runs_org_status_created_idx on runs (org_id, status, created_at desc);
create index runs_org_created_idx on runs (org_id, created_at desc);
create index metric_points_org_run_key_step_idx on metric_points (org_id, run_id, key, step, id);
create index metric_points_org_run_step_idx on metric_points (org_id, run_id, step, id);
create index metric_points_org_created_idx on metric_points (org_id, created_at desc);
create index metric_points_org_key_created_idx on metric_points (org_id, key, created_at desc);
create index metric_series_org_key_best_idx on metric_series (org_id, key, max desc nulls last);
create index attributes_run_type_path_idx on attributes (run_id, type, path);
create index attributes_org_run_type_path_step_idx on attributes (org_id, run_id, type, path, step, id);
create index attributes_org_path_idx on attributes (org_id, path);
create index attributes_artifact_id_idx on attributes (artifact_id);
create index artifacts_run_type_step_idx on artifacts (run_id, type, step);
create index artifacts_org_run_type_step_created_idx on artifacts (org_id, run_id, type, step, created_at, id);
create index artifacts_org_created_idx on artifacts (org_id, created_at desc);
create index artifacts_org_run_idx on artifacts (org_id, run_id);
create index imports_org_created_idx on imports (org_id, created_at desc);
create index imports_org_project_created_idx on imports (org_id, project_id, created_at desc);
create index imports_run_ids_gin_idx on imports using gin (run_ids);
create index imports_project_id_idx on imports (project_id);
create index idempotency_keys_org_created_idx on idempotency_keys (org_id, created_at desc);
create index idempotency_keys_expires_idx on idempotency_keys (expires_at);
create index audit_events_org_created_idx on audit_events (org_id, created_at desc);
create index audit_events_actor_user_id_idx on audit_events (actor_user_id);
create index audit_events_actor_service_account_id_idx on audit_events (actor_service_account_id);
create unique index usage_daily_org_period_snapshot_idx
  on usage_daily (org_id, period_start)
  where rollup_kind = 'daily_snapshot';
create index usage_daily_org_period_idx on usage_daily (org_id, period_start desc);
create index usage_daily_correction_of_idx on usage_daily (correction_of_rollup_id);
