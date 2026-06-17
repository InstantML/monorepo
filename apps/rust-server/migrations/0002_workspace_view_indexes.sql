CREATE INDEX IF NOT EXISTS workspace_views_owner_live_updated_idx
    ON workspace_views (org_id, owner_user_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS workspace_views_owner_tombstone_idx
    ON workspace_views (org_id, owner_user_id, deleted_at DESC, updated_at DESC)
    WHERE deleted_at IS NOT NULL;
