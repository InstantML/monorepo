create extension if not exists pg_trgm;

alter table runs
  add column if not exists search_text text not null default '';

create or replace function runs_refresh_search_text()
returns trigger
language plpgsql
as $$
begin
  new.search_text := lower(
    coalesce(new.name, '') || ' ' ||
    coalesce(array_to_string(new.tags, ' '), '') || ' ' ||
    coalesce(new.config::text, '') || ' ' ||
    coalesce(new.metadata->>'notes', '') || ' ' ||
    coalesce(new.metadata->>'note', '') || ' ' ||
    coalesce(new.metadata->>'description', '') || ' ' ||
    coalesce(new.metadata->>'summary', '') || ' ' ||
    coalesce(new.metadata->>'comment', '')
  );
  return new;
end;
$$;

update runs
set search_text = lower(
  coalesce(name, '') || ' ' ||
  coalesce(array_to_string(tags, ' '), '') || ' ' ||
  coalesce(config::text, '') || ' ' ||
  coalesce(metadata->>'notes', '') || ' ' ||
  coalesce(metadata->>'note', '') || ' ' ||
  coalesce(metadata->>'description', '') || ' ' ||
  coalesce(metadata->>'summary', '') || ' ' ||
  coalesce(metadata->>'comment', '')
);

drop trigger if exists runs_search_text_refresh on runs;
create trigger runs_search_text_refresh
before insert or update of name, tags, config, metadata on runs
for each row
execute function runs_refresh_search_text();

create index if not exists runs_search_text_trgm_idx on runs using gin (search_text gin_trgm_ops);
create index if not exists runs_tags_gin_idx on runs using gin (tags);
