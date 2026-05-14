alter table organizations
  add column account_type text not null default 'customer',
  add column seat_limit integer not null default 1;

alter table organizations
  add constraint organizations_account_type_check
  check (account_type in ('customer', 'business'));

alter table organizations
  add constraint organizations_seat_limit_check
  check (seat_limit > 0 and seat_limit <= 10000);

alter table memberships
  add column status text not null default 'active';

alter table memberships
  add constraint memberships_status_check
  check (status in ('active', 'invited'));

create index memberships_org_status_created_idx
  on memberships (org_id, status, created_at desc);

create table user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  token_hash bytea not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (org_id, user_id) references memberships(org_id, user_id) on delete cascade
);

create index user_sessions_user_active_idx
  on user_sessions (user_id, expires_at desc)
  where revoked_at is null;

create index user_sessions_expiry_idx
  on user_sessions (expires_at);
