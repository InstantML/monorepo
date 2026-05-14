alter table attributes
  drop constraint if exists attributes_type_check;

alter table attributes
  add constraint attributes_type_check
  check (type in (
    'config',
    'float_series',
    'string_series',
    'file',
    'file_series',
    'histogram_series',
    'tag',
    'table',
    'image',
    'video',
    'audio'
  ));

alter table attributes
  add constraint attributes_org_id_id_unique unique (org_id, id);

create index attributes_rich_object_list_idx
  on attributes (org_id, run_id, (coalesce(step, -1)) desc, created_at desc, id desc)
  where type in ('table', 'image', 'video', 'audio', 'histogram_series');

create table table_object_rows (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  attribute_id bigint not null,
  row_index bigint not null check (row_index >= 0),
  row jsonb not null check (jsonb_typeof(row) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (org_id, attribute_id) references attributes(org_id, id) on delete cascade,
  unique (org_id, attribute_id, row_index)
);
