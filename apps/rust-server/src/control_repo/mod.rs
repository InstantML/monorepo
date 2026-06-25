//! Typed Postgres access for the control plane.
//!
//! These methods are the replacement for the in-memory `StoreData` mutations
//! and lookups in `store/auth/*`. They use runtime-checked `sqlx` queries (no
//! compile-time database required, so the Docker/CI build stays hermetic) and
//! map dedicated `FromRow` structs to the domain types in `domain.rs`.
//!
//! Correctness properties the old event-log model lacked, now provided here:
//!   * Uniqueness — `UNIQUE` constraints reject duplicate slug/email/key-hash
//!     instead of silently appending a second event.
//!   * Atomicity — multi-row writes (org + owner membership, or a full signup)
//!     run inside one transaction, so a crash can't leave an org with no owner.
//!   * Read-after-write — reads hit the table, not a process-local projection.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{
    control_db::ControlDb,
    domain::{
        BillingAccountProjection, BillingChangeIntent, BillingCheckoutIntent, BillingEventRecord,
        BillingSubscriptionRecord, BillingUsageReportRecord, DashboardPreferenceRow, DataCellRow,
        DataCellWriterLeaseRow, EmailDeliveryRow, MembershipRow, OrgInvitationRow, OrganizationRow,
        PublicApiKeyRow, ServiceAccountRow, TenantRouteEventRow, UserRow, UserSessionRow,
        WorkspaceViewRow,
    },
    errors::{AppError, AppResult},
    store::TenantRouteRecord,
};

/// Postgres SQLSTATE for a unique-constraint violation.
const PG_UNIQUE_VIOLATION: &str = "23505";
pub(crate) const DATA_CELL_HEALTH_MAX_AGE_SECS: i64 = 10 * 60;
pub(crate) const DATA_CELL_BACKUP_MAX_AGE_SECS: i64 = 36 * 60 * 60;
pub(crate) const DATA_CELL_FUTURE_TIMESTAMP_TOLERANCE_SECS: i64 = 5 * 60;
const CUSTOMER_CLICKHOUSE_PROVISIONER: &str = "customer-clickhouse";

fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|db| db.code())
        .map(|code| code == PG_UNIQUE_VIOLATION)
        .unwrap_or(false)
}

fn internal(context: &str, err: sqlx::Error) -> AppError {
    AppError::internal(format!("control-plane query failed ({context}): {err}"))
}

fn writer_lease_ttl_seconds(ttl: ChronoDuration) -> AppResult<i64> {
    let seconds = ttl.num_seconds();
    if seconds <= 0 {
        return Err(AppError::config(
            "data-cell writer lease TTL must be greater than zero seconds",
        ));
    }
    Ok(seconds)
}

pub(crate) fn data_cell_timestamp_is_not_fresh(
    now: DateTime<Utc>,
    observed_at: Option<DateTime<Utc>>,
    max_age_secs: i64,
) -> bool {
    observed_at.is_none_or(|observed_at| {
        let age = now.signed_duration_since(observed_at);
        age < ChronoDuration::seconds(-DATA_CELL_FUTURE_TIMESTAMP_TOLERANCE_SECS)
            || age > ChronoDuration::seconds(max_age_secs)
    })
}

/// Identity (provider + subject) and the user it created, written together so a
/// signup never produces a user without a resolvable identity.
#[derive(Clone, Debug)]
pub struct NewIdentity {
    pub provider: String,
    pub provider_subject: String,
}

/// A session row plus its opaque token hash, mirroring the in-memory
/// `SessionRecord`.
#[derive(Clone, Debug)]
pub struct NewSession {
    pub row: UserSessionRow,
    pub token_hash: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct TenantRoutePlacement {
    pub environment: String,
    pub cell_id: String,
    pub actor: String,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct DataCellWriterLeaseAcquire {
    pub cell_id: String,
    pub holder_instance_id: String,
    pub service_name: String,
    pub revision: String,
    pub ttl: ChronoDuration,
}

#[derive(Clone, Debug)]
pub struct DataCellWriterLeaseRenewal {
    pub cell_id: String,
    pub holder_instance_id: String,
    pub fence_token: i64,
    pub ttl: ChronoDuration,
}

#[derive(Clone, Debug)]
pub struct DataCellWriterLeaseObservation {
    pub cell_id: String,
    pub holder_instance_id: String,
    pub fence_token: i64,
}

#[derive(Clone, Debug)]
pub struct DataCellWriterLeaseRelease {
    pub cell_id: String,
    pub holder_instance_id: String,
    pub fence_token: i64,
}

impl ControlDb {
    // --- Users ------------------------------------------------------------

    pub async fn get_user(&self, id: Uuid) -> AppResult<Option<UserRow>> {
        let row = sqlx::query_as::<_, UserRowDb>(
            "SELECT id, primary_email, display_name, avatar_url, created_at, last_seen_at \
             FROM users WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("get_user", err))?;
        Ok(row.map(Into::into))
    }

    pub async fn find_user_by_email(&self, email: &str) -> AppResult<Option<UserRow>> {
        let row = sqlx::query_as::<_, UserRowDb>(
            "SELECT id, primary_email, display_name, avatar_url, created_at, last_seen_at \
             FROM users WHERE primary_email = $1",
        )
        .bind(email)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("find_user_by_email", err))?;
        Ok(row.map(Into::into))
    }

    pub async fn find_user_by_identity(
        &self,
        provider: &str,
        subject: &str,
    ) -> AppResult<Option<UserRow>> {
        let row = sqlx::query_as::<_, UserRowDb>(
            "SELECT u.id, u.primary_email, u.display_name, u.avatar_url, u.created_at, u.last_seen_at \
             FROM users u JOIN identities i ON i.user_id = u.id \
             WHERE i.provider = $1 AND i.provider_subject = $2",
        )
        .bind(provider)
        .bind(subject)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("find_user_by_identity", err))?;
        Ok(row.map(Into::into))
    }

    pub async fn list_users(&self) -> AppResult<Vec<UserRow>> {
        let rows = sqlx::query_as::<_, UserRowDb>(
            "SELECT id, primary_email, display_name, avatar_url, created_at, last_seen_at \
             FROM users ORDER BY created_at, id",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("list_users", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    /// Find-or-create a user keyed by identity, then email. Mirrors the
    /// semantics of the old `create_user`: an existing identity or email
    /// returns the existing user; otherwise the user and identity are inserted
    /// atomically. Uniqueness is enforced by the database, so a concurrent
    /// caller racing the same email cannot create a duplicate.
    pub async fn create_user_with_identity(
        &self,
        user: &UserRow,
        identity: &NewIdentity,
    ) -> AppResult<UserRow> {
        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|err| internal("create_user begin", err))?;

        if let Some(existing) = find_user_by_identity_tx(&mut tx, identity).await? {
            return Ok(existing);
        }
        if let Some(existing) = find_user_by_email_tx(&mut tx, &user.primary_email).await? {
            return Ok(existing);
        }

        insert_user_tx(&mut tx, user).await?;
        insert_identity_tx(&mut tx, user.id, identity).await?;

        tx.commit()
            .await
            .map_err(|err| internal("create_user commit", err))?;
        Ok(user.clone())
    }

    // --- Organizations ----------------------------------------------------

    pub async fn get_org(&self, id: Uuid) -> AppResult<Option<OrganizationRow>> {
        let row = sqlx::query_as::<_, OrganizationRowDb>(ORG_SELECT_BY_ID)
            .bind(id)
            .fetch_optional(self.pool())
            .await
            .map_err(|err| internal("get_org", err))?;
        Ok(row.map(Into::into))
    }

    pub async fn get_org_by_slug(&self, slug: &str) -> AppResult<Option<OrganizationRow>> {
        let row = sqlx::query_as::<_, OrganizationRowDb>(
            "SELECT id, slug, name, plan_tier, account_type, seat_limit, created_by_user_id, \
             created_at, tenant_routing_tier, storage_choice, storage_state \
             FROM organizations WHERE slug = $1",
        )
        .bind(slug)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("get_org_by_slug", err))?;
        Ok(row.map(Into::into))
    }

    /// Create an organization and, optionally, its owner membership in a single
    /// transaction. This is the fix for "a crash mid-signup leaves an org with
    /// no owner": both rows commit together or not at all. A duplicate slug
    /// surfaces as `conflict` from the `UNIQUE` constraint rather than a
    /// silently-appended second org.
    pub async fn create_org_with_owner(
        &self,
        org: &OrganizationRow,
        owner_membership: Option<&MembershipRow>,
    ) -> AppResult<()> {
        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|err| internal("create_org begin", err))?;

        insert_org_tx(&mut tx, org).await?;
        if let Some(membership) = owner_membership {
            insert_membership_tx(&mut tx, membership).await?;
        }

        tx.commit()
            .await
            .map_err(|err| internal("create_org commit", err))?;
        Ok(())
    }

    // --- Memberships ------------------------------------------------------

    pub async fn membership_for(
        &self,
        org_id: Uuid,
        user_id: Uuid,
    ) -> AppResult<Option<MembershipRow>> {
        let row = sqlx::query_as::<_, MembershipRowDb>(
            "SELECT id, org_id, user_id, role, status, created_at \
             FROM memberships WHERE org_id = $1 AND user_id = $2",
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("membership_for", err))?;
        Ok(row.map(Into::into))
    }

    pub async fn memberships_for_user(&self, user_id: Uuid) -> AppResult<Vec<MembershipRow>> {
        let rows = sqlx::query_as::<_, MembershipRowDb>(
            "SELECT id, org_id, user_id, role, status, created_at \
             FROM memberships WHERE user_id = $1 ORDER BY created_at, id",
        )
        .bind(user_id)
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("memberships_for_user", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    // --- Sessions ---------------------------------------------------------

    pub async fn insert_session(&self, session: &NewSession) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, org_id, token_hash, metadata, created_at, last_seen_at, expires_at, revoked_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(session.row.id)
        .bind(session.row.user_id)
        .bind(session.row.org_id)
        .bind(&session.token_hash)
        .bind(&session.row.metadata)
        .bind(session.row.created_at)
        .bind(session.row.last_seen_at)
        .bind(session.row.expires_at)
        .bind(session.row.revoked_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("insert_session", err))?;
        Ok(())
    }
}

const ORG_SELECT_BY_ID: &str =
    "SELECT id, slug, name, plan_tier, account_type, seat_limit, created_by_user_id, \
     created_at, tenant_routing_tier, storage_choice, storage_state \
     FROM organizations WHERE id = $1";

// --- Transaction-scoped helpers ------------------------------------------

async fn find_user_by_identity_tx(
    tx: &mut Transaction<'_, Postgres>,
    identity: &NewIdentity,
) -> AppResult<Option<UserRow>> {
    let row = sqlx::query_as::<_, UserRowDb>(
        "SELECT u.id, u.primary_email, u.display_name, u.avatar_url, u.created_at, u.last_seen_at \
         FROM users u JOIN identities i ON i.user_id = u.id \
         WHERE i.provider = $1 AND i.provider_subject = $2",
    )
    .bind(&identity.provider)
    .bind(&identity.provider_subject)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|err| internal("find_user_by_identity_tx", err))?;
    Ok(row.map(Into::into))
}

async fn find_user_by_email_tx(
    tx: &mut Transaction<'_, Postgres>,
    email: &str,
) -> AppResult<Option<UserRow>> {
    let row = sqlx::query_as::<_, UserRowDb>(
        "SELECT id, primary_email, display_name, avatar_url, created_at, last_seen_at \
         FROM users WHERE primary_email = $1",
    )
    .bind(email)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|err| internal("find_user_by_email_tx", err))?;
    Ok(row.map(Into::into))
}

async fn insert_user_tx(tx: &mut Transaction<'_, Postgres>, user: &UserRow) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO users (id, primary_email, display_name, avatar_url, created_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(user.id)
    .bind(&user.primary_email)
    .bind(&user.display_name)
    .bind(&user.avatar_url)
    .bind(user.created_at)
    .bind(user.last_seen_at)
    .execute(&mut **tx)
    .await
    .map_err(|err| {
        if is_unique_violation(&err) {
            AppError::conflict("user already exists")
        } else {
            internal("insert_user", err)
        }
    })?;
    Ok(())
}

async fn insert_identity_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    identity: &NewIdentity,
) -> AppResult<()> {
    sqlx::query("INSERT INTO identities (provider, provider_subject, user_id) VALUES ($1, $2, $3)")
        .bind(&identity.provider)
        .bind(&identity.provider_subject)
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(|err| {
            if is_unique_violation(&err) {
                AppError::conflict("identity already exists")
            } else {
                internal("insert_identity", err)
            }
        })?;
    Ok(())
}

async fn insert_org_tx(tx: &mut Transaction<'_, Postgres>, org: &OrganizationRow) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO organizations \
         (id, slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at, \
          tenant_routing_tier, storage_choice, storage_state) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(org.id)
    .bind(&org.slug)
    .bind(&org.name)
    .bind(&org.plan_tier)
    .bind(&org.account_type)
    .bind(org.seat_limit)
    .bind(org.created_by_user_id)
    .bind(org.created_at)
    .bind(&org.tenant_routing_tier)
    .bind(&org.storage_choice)
    .bind(&org.storage_state)
    .execute(&mut **tx)
    .await
    .map_err(|err| {
        if is_unique_violation(&err) {
            AppError::conflict("organization already exists")
        } else {
            internal("insert_org", err)
        }
    })?;
    Ok(())
}

async fn insert_membership_tx(
    tx: &mut Transaction<'_, Postgres>,
    membership: &MembershipRow,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO memberships (id, org_id, user_id, role, status, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(membership.id)
    .bind(membership.org_id)
    .bind(membership.user_id)
    .bind(&membership.role)
    .bind(&membership.status)
    .bind(membership.created_at)
    .execute(&mut **tx)
    .await
    .map_err(|err| {
        if is_unique_violation(&err) {
            AppError::conflict("membership already exists")
        } else {
            internal("insert_membership", err)
        }
    })?;
    Ok(())
}

// === Write-through upserts + bulk loads ===================================
//
// These back the `persist_locked` chokepoint and the startup projection
// rebuild. Upserts are keyed by primary key (last-writer-wins, matching the
// event-log replay semantics), while the secondary `UNIQUE` constraints
// (slug/email/key-hash/token-hash) still reject a *different* entity that
// collides — the actual correctness win.

/// A session row plus its token hash, loaded from Postgres for the projection
/// rebuild. Mirrors `NewSession`; named separately for read intent.
pub type LoadedSession = NewSession;

/// An API key row plus its opaque key hash (the in-memory `ApiKeyRecord`
/// equivalent, which is private to the store module).
#[derive(Clone, Debug)]
pub struct ApiKeyWithHash {
    pub row: PublicApiKeyRow,
    pub key_hash: Vec<u8>,
}

/// A user's external identity mapping, loaded for rebuild.
#[derive(Clone, Debug)]
pub struct LoadedIdentity {
    pub provider: String,
    pub provider_subject: String,
    pub user_id: Uuid,
}

fn map_write(context: &'static str, err: sqlx::Error) -> AppError {
    if is_unique_violation(&err) {
        AppError::conflict(context)
    } else {
        internal(context, err)
    }
}

impl ControlDb {
    pub async fn upsert_user(&self, user: &UserRow) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO users (id, primary_email, display_name, avatar_url, created_at, last_seen_at) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (id) DO UPDATE SET \
               primary_email = EXCLUDED.primary_email, \
               display_name = EXCLUDED.display_name, \
               avatar_url = EXCLUDED.avatar_url, \
               created_at = EXCLUDED.created_at, \
               last_seen_at = EXCLUDED.last_seen_at",
        )
        .bind(user.id)
        .bind(&user.primary_email)
        .bind(&user.display_name)
        .bind(&user.avatar_url)
        .bind(user.created_at)
        .bind(user.last_seen_at)
        .execute(self.pool())
        .await
        .map_err(|err| map_write("user already exists", err))?;
        Ok(())
    }

    pub async fn upsert_identity(
        &self,
        provider: &str,
        provider_subject: &str,
        user_id: Uuid,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO identities (provider, provider_subject, user_id) VALUES ($1, $2, $3) \
             ON CONFLICT (provider, provider_subject) DO UPDATE SET user_id = EXCLUDED.user_id",
        )
        .bind(provider)
        .bind(provider_subject)
        .bind(user_id)
        .execute(self.pool())
        .await
        .map_err(|err| map_write("identity already exists", err))?;
        Ok(())
    }

    pub async fn upsert_org(&self, org: &OrganizationRow) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO organizations \
             (id, slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at, \
              tenant_routing_tier, storage_choice, storage_state) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
             ON CONFLICT (id) DO UPDATE SET \
               slug = EXCLUDED.slug, name = EXCLUDED.name, plan_tier = EXCLUDED.plan_tier, \
               account_type = EXCLUDED.account_type, seat_limit = EXCLUDED.seat_limit, \
               created_by_user_id = EXCLUDED.created_by_user_id, created_at = EXCLUDED.created_at, \
               tenant_routing_tier = EXCLUDED.tenant_routing_tier, \
               storage_choice = EXCLUDED.storage_choice, storage_state = EXCLUDED.storage_state",
        )
        .bind(org.id)
        .bind(&org.slug)
        .bind(&org.name)
        .bind(&org.plan_tier)
        .bind(&org.account_type)
        .bind(org.seat_limit)
        .bind(org.created_by_user_id)
        .bind(org.created_at)
        .bind(&org.tenant_routing_tier)
        .bind(&org.storage_choice)
        .bind(&org.storage_state)
        .execute(self.pool())
        .await
        .map_err(|err| map_write("organization already exists", err))?;
        Ok(())
    }

    pub async fn upsert_membership(&self, membership: &MembershipRow) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO memberships (id, org_id, user_id, role, status, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (id) DO UPDATE SET \
               role = EXCLUDED.role, status = EXCLUDED.status",
        )
        .bind(membership.id)
        .bind(membership.org_id)
        .bind(membership.user_id)
        .bind(&membership.role)
        .bind(&membership.status)
        .bind(membership.created_at)
        .execute(self.pool())
        .await
        .map_err(|err| map_write("membership already exists", err))?;
        Ok(())
    }

    pub async fn upsert_service_account(&self, account: &ServiceAccountRow) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO service_accounts (id, org_id, name, created_by_user_id, created_at, disabled_at) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (id) DO UPDATE SET \
               name = EXCLUDED.name, created_by_user_id = EXCLUDED.created_by_user_id, \
               created_at = EXCLUDED.created_at, disabled_at = EXCLUDED.disabled_at",
        )
        .bind(account.id)
        .bind(account.org_id)
        .bind(&account.name)
        .bind(account.created_by_user_id)
        .bind(account.created_at)
        .bind(account.disabled_at)
        .execute(self.pool())
        .await
        .map_err(|err| map_write("service account already exists", err))?;
        Ok(())
    }

    pub async fn upsert_api_key(&self, key: &ApiKeyWithHash) -> AppResult<()> {
        let row = &key.row;
        sqlx::query(
            "INSERT INTO api_keys \
             (id, org_id, service_account_id, name, key_prefix, key_hash, scopes, project_id, \
              created_at, expires_at, last_used_at, revoked_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             ON CONFLICT (id) DO UPDATE SET \
               name = EXCLUDED.name, scopes = EXCLUDED.scopes, project_id = EXCLUDED.project_id, \
               expires_at = EXCLUDED.expires_at, last_used_at = EXCLUDED.last_used_at, \
               revoked_at = EXCLUDED.revoked_at",
        )
        .bind(row.id)
        .bind(row.org_id)
        .bind(row.service_account_id)
        .bind(&row.name)
        .bind(&row.key_prefix)
        .bind(&key.key_hash)
        .bind(&row.scopes)
        .bind(row.project_id)
        .bind(row.created_at)
        .bind(row.expires_at)
        .bind(row.last_used_at)
        .bind(row.revoked_at)
        .execute(self.pool())
        .await
        .map_err(|err| map_write("api key already exists", err))?;
        Ok(())
    }

    pub async fn upsert_session(&self, session: &NewSession) -> AppResult<()> {
        let row = &session.row;
        sqlx::query(
            "INSERT INTO sessions \
             (id, user_id, org_id, token_hash, metadata, created_at, last_seen_at, expires_at, revoked_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (id) DO UPDATE SET \
               metadata = EXCLUDED.metadata, last_seen_at = EXCLUDED.last_seen_at, \
               expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at",
        )
        .bind(row.id)
        .bind(row.user_id)
        .bind(row.org_id)
        .bind(&session.token_hash)
        .bind(&row.metadata)
        .bind(row.created_at)
        .bind(row.last_seen_at)
        .bind(row.expires_at)
        .bind(row.revoked_at)
        .execute(self.pool())
        .await
        .map_err(|err| map_write("session already exists", err))?;
        Ok(())
    }

    // --- Bulk loads for projection rebuild --------------------------------

    pub async fn load_identities(&self) -> AppResult<Vec<LoadedIdentity>> {
        let rows = sqlx::query_as::<_, IdentityRowDb>(
            "SELECT provider, provider_subject, user_id FROM identities",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_identities", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_orgs(&self) -> AppResult<Vec<OrganizationRow>> {
        let rows = sqlx::query_as::<_, OrganizationRowDb>(
            "SELECT id, slug, name, plan_tier, account_type, seat_limit, created_by_user_id, \
             created_at, tenant_routing_tier, storage_choice, storage_state FROM organizations",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_orgs", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_memberships(&self) -> AppResult<Vec<MembershipRow>> {
        let rows = sqlx::query_as::<_, MembershipRowDb>(
            "SELECT id, org_id, user_id, role, status, created_at FROM memberships",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_memberships", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_service_accounts(&self) -> AppResult<Vec<ServiceAccountRow>> {
        let rows = sqlx::query_as::<_, ServiceAccountRowDb>(
            "SELECT id, org_id, name, created_by_user_id, created_at, disabled_at \
             FROM service_accounts",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_service_accounts", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_api_keys(&self) -> AppResult<Vec<ApiKeyWithHash>> {
        let rows = sqlx::query_as::<_, ApiKeyRowDb>(
            "SELECT id, org_id, service_account_id, name, key_prefix, key_hash, scopes, project_id, \
             created_at, expires_at, last_used_at, revoked_at FROM api_keys",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_api_keys", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_sessions(&self) -> AppResult<Vec<LoadedSession>> {
        let rows = sqlx::query_as::<_, SessionRowDb>(
            "SELECT id, user_id, org_id, token_hash, metadata, created_at, last_seen_at, \
             expires_at, revoked_at FROM sessions",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_sessions", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

// === Invitations, email deliveries, dashboard prefs, workspace views, routes ==

/// `u32`. These are small positive counts, so the cast is lossless in practice.
pub(super) fn opt_u32_to_i32(value: Option<u32>) -> Option<i32> {
    value.map(|v| v as i32)
}

pub(super) fn opt_i32_to_u32(value: Option<i32>) -> Option<u32> {
    value.map(|v| v as u32)
}

impl ControlDb {
    pub async fn upsert_org_invitation(&self, inv: &OrgInvitationRow) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO org_invitations \
             (id, org_id, email, role, status, token_hash, previous_token_hashes, \
              invited_by_user_id, created_at, expires_at, last_sent_at, accepted_at, \
              accepted_by_user_id, revoked_at, revoked_by_user_id, delivery_status, \
              email_provider, provider_message_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) \
             ON CONFLICT (id) DO UPDATE SET \
               email = EXCLUDED.email, role = EXCLUDED.role, status = EXCLUDED.status, \
               token_hash = EXCLUDED.token_hash, \
               previous_token_hashes = EXCLUDED.previous_token_hashes, \
               expires_at = EXCLUDED.expires_at, last_sent_at = EXCLUDED.last_sent_at, \
               accepted_at = EXCLUDED.accepted_at, accepted_by_user_id = EXCLUDED.accepted_by_user_id, \
               revoked_at = EXCLUDED.revoked_at, revoked_by_user_id = EXCLUDED.revoked_by_user_id, \
               delivery_status = EXCLUDED.delivery_status, email_provider = EXCLUDED.email_provider, \
               provider_message_id = EXCLUDED.provider_message_id",
        )
        .bind(inv.id)
        .bind(inv.org_id)
        .bind(&inv.email)
        .bind(&inv.role)
        .bind(&inv.status)
        .bind(&inv.token_hash)
        .bind(&inv.previous_token_hashes)
        .bind(inv.invited_by_user_id)
        .bind(inv.created_at)
        .bind(inv.expires_at)
        .bind(inv.last_sent_at)
        .bind(inv.accepted_at)
        .bind(inv.accepted_by_user_id)
        .bind(inv.revoked_at)
        .bind(inv.revoked_by_user_id)
        .bind(&inv.delivery_status)
        .bind(&inv.email_provider)
        .bind(&inv.provider_message_id)
        .execute(self.pool())
        .await
        .map_err(|err| map_write("invitation token already exists", err))?;
        Ok(())
    }

    pub async fn upsert_email_delivery(&self, delivery: &EmailDeliveryRow) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO email_deliveries \
             (id, org_id, invitation_id, recipient_email, provider, status, provider_message_id, \
              error_code, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (id) DO UPDATE SET \
               status = EXCLUDED.status, provider_message_id = EXCLUDED.provider_message_id, \
               error_code = EXCLUDED.error_code",
        )
        .bind(delivery.id)
        .bind(delivery.org_id)
        .bind(delivery.invitation_id)
        .bind(&delivery.recipient_email)
        .bind(&delivery.provider)
        .bind(&delivery.status)
        .bind(&delivery.provider_message_id)
        .bind(&delivery.error_code)
        .bind(delivery.created_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_email_delivery", err))?;
        Ok(())
    }

    pub async fn upsert_dashboard_preference(
        &self,
        pref: &DashboardPreferenceRow,
    ) -> AppResult<()> {
        // The org-wide default (user_id NULL) and per-user rows live under two
        // separate partial unique indexes, so the conflict target differs.
        let sql = if pref.user_id.is_some() {
            "INSERT INTO dashboard_preferences (schema_version, org_id, user_id, selected_project, updated_at) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (org_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, \
               selected_project = EXCLUDED.selected_project, updated_at = EXCLUDED.updated_at"
        } else {
            "INSERT INTO dashboard_preferences (schema_version, org_id, user_id, selected_project, updated_at) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (org_id) WHERE user_id IS NULL DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, \
               selected_project = EXCLUDED.selected_project, updated_at = EXCLUDED.updated_at"
        };
        sqlx::query(sql)
            .bind(pref.schema_version)
            .bind(pref.org_id)
            .bind(pref.user_id)
            .bind(&pref.selected_project)
            .bind(pref.updated_at)
            .execute(self.pool())
            .await
            .map_err(|err| internal("upsert_dashboard_preference", err))?;
        Ok(())
    }

    pub async fn upsert_workspace_view(&self, view: &WorkspaceViewRow) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO workspace_views \
             (schema_version, id, org_id, owner_user_id, name, project, payload, created_at, \
              updated_at, deleted_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (id) DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, name = EXCLUDED.name, \
               project = EXCLUDED.project, payload = EXCLUDED.payload, \
               updated_at = EXCLUDED.updated_at, deleted_at = EXCLUDED.deleted_at",
        )
        .bind(view.schema_version)
        .bind(view.id)
        .bind(view.org_id)
        .bind(view.owner_user_id)
        .bind(&view.name)
        .bind(&view.project)
        .bind(&view.payload)
        .bind(view.created_at)
        .bind(view.updated_at)
        .bind(view.deleted_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_workspace_view", err))?;
        Ok(())
    }

    pub async fn insert_workspace_view_with_capacity(
        &self,
        view: &WorkspaceViewRow,
        live_user_cap: i64,
        live_org_cap: i64,
    ) -> AppResult<()> {
        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|err| internal("insert_workspace_view_with_capacity begin", err))?;

        // Saved views are low-volume control-plane rows. A short table lock keeps
        // user/org live caps exact across Cloud Run instances without a broader
        // quota subsystem.
        sqlx::query("LOCK TABLE workspace_views IN SHARE ROW EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .map_err(|err| internal("insert_workspace_view_with_capacity lock", err))?;

        let (org_live_count, user_live_count): (i64, i64) = sqlx::query_as(
            "SELECT \
               COUNT(*) FILTER (WHERE deleted_at IS NULL) AS org_live_count, \
               COUNT(*) FILTER (WHERE deleted_at IS NULL AND owner_user_id IS NOT DISTINCT FROM $2) AS user_live_count \
             FROM workspace_views \
             WHERE org_id = $1",
        )
        .bind(view.org_id)
        .bind(view.owner_user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|err| internal("insert_workspace_view_with_capacity count", err))?;

        if org_live_count >= live_org_cap {
            return Err(AppError::validation(format!(
                "workspace cannot have more than {live_org_cap} saved views"
            )));
        }
        if user_live_count >= live_user_cap {
            return Err(AppError::validation(format!(
                "user cannot have more than {live_user_cap} saved views"
            )));
        }

        sqlx::query(
            "INSERT INTO workspace_views \
             (schema_version, id, org_id, owner_user_id, name, project, payload, created_at, \
              updated_at, deleted_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(view.schema_version)
        .bind(view.id)
        .bind(view.org_id)
        .bind(view.owner_user_id)
        .bind(&view.name)
        .bind(&view.project)
        .bind(&view.payload)
        .bind(view.created_at)
        .bind(view.updated_at)
        .bind(view.deleted_at)
        .execute(&mut *tx)
        .await
        .map_err(|err| internal("insert_workspace_view_with_capacity insert", err))?;

        tx.commit()
            .await
            .map_err(|err| internal("insert_workspace_view_with_capacity commit", err))?;
        Ok(())
    }

    pub async fn update_workspace_view_if_current(
        &self,
        view: &WorkspaceViewRow,
        expected_updated_at: DateTime<Utc>,
    ) -> AppResult<bool> {
        let result = sqlx::query(
            "UPDATE workspace_views SET \
               schema_version = $1, name = $2, project = $3, payload = $4, \
               updated_at = $5, deleted_at = $6 \
             WHERE id = $7 \
               AND org_id = $8 \
               AND owner_user_id IS NOT DISTINCT FROM $9 \
               AND updated_at = $10 \
               AND deleted_at IS NULL",
        )
        .bind(view.schema_version)
        .bind(&view.name)
        .bind(&view.project)
        .bind(&view.payload)
        .bind(view.updated_at)
        .bind(view.deleted_at)
        .bind(view.id)
        .bind(view.org_id)
        .bind(view.owner_user_id)
        .bind(expected_updated_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("update_workspace_view_if_current", err))?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn prune_workspace_view_tombstones(
        &self,
        org_id: Uuid,
        owner_user_id: Option<Uuid>,
        keep: i64,
    ) -> AppResult<()> {
        sqlx::query(
            "DELETE FROM workspace_views \
             WHERE id IN ( \
               SELECT id FROM workspace_views \
               WHERE org_id = $1 \
                 AND owner_user_id IS NOT DISTINCT FROM $2 \
                 AND deleted_at IS NOT NULL \
               ORDER BY deleted_at DESC, updated_at DESC, id DESC \
               OFFSET $3 \
             )",
        )
        .bind(org_id)
        .bind(owner_user_id)
        .bind(keep)
        .execute(self.pool())
        .await
        .map_err(|err| internal("prune_workspace_view_tombstones", err))?;
        Ok(())
    }

    pub async fn upsert_tenant_route(
        &self,
        route: &TenantRouteRecord,
    ) -> AppResult<TenantRouteRecord> {
        self.upsert_tenant_route_with_placement(route, None).await
    }

    pub async fn upsert_tenant_route_with_placement(
        &self,
        route: &TenantRouteRecord,
        placement: Option<&TenantRoutePlacement>,
    ) -> AppResult<TenantRouteRecord> {
        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|err| internal("upsert_tenant_route begin", err))?;
        lock_tenant_route_org(&mut tx, route.org_id).await?;
        let existing = select_tenant_route_for_update(&mut tx, route.org_id).await?;
        if placement.is_none() && explicit_cell_assignment_changed(existing.as_ref(), route) {
            return Err(AppError::validation(
                "tenant route cell_id changes require placement context",
            ));
        }
        let mut effective = route.clone();
        let mut applied_placement = false;
        if let Some(existing) = &existing {
            effective.cell_id = route.cell_id.clone().or_else(|| existing.cell_id.clone());
            effective.placement_reason = route
                .placement_reason
                .clone()
                .or_else(|| existing.placement_reason.clone());
            effective.assigned_at = route.assigned_at.or(existing.assigned_at);
        }
        if effective.cell_id.is_none() {
            if let Some(placement) = placement {
                if route_is_managed_cell_candidate(&effective) {
                    ensure_eligible_cell(
                        &mut tx,
                        placement,
                        route.org_id,
                        self.require_data_cell_backup_evidence(),
                    )
                    .await?;
                    effective.cell_id = Some(placement.cell_id.clone());
                    effective.placement_reason = Some(placement.reason.clone());
                    effective.assigned_at = Some(Utc::now());
                    applied_placement = true;
                }
            }
        }
        let material_change = tenant_route_material_change(existing.as_ref(), &effective);
        effective.route_version = match existing.as_ref() {
            None => effective.route_version.max(1),
            Some(existing) if material_change => existing.route_version.max(1) + 1,
            Some(existing) => existing.route_version.max(1),
        };
        upsert_tenant_route_tx(&mut tx, &effective).await?;
        if material_change {
            insert_tenant_route_event_tx(
                &mut tx,
                TenantRouteEventRow {
                    id: Uuid::new_v4(),
                    org_id: effective.org_id,
                    old_cell_id: existing.as_ref().and_then(|route| route.cell_id.clone()),
                    new_cell_id: effective.cell_id.clone(),
                    old_status: existing.as_ref().map(|route| route.status.clone()),
                    new_status: effective.status.clone(),
                    route_version: effective.route_version,
                    actor: placement
                        .filter(|_| applied_placement)
                        .map(|placement| placement.actor.clone())
                        .unwrap_or_else(|| "system".to_string()),
                    reason: placement
                        .filter(|_| applied_placement)
                        .map(|placement| placement.reason.clone())
                        .unwrap_or_else(|| "tenant_route_upsert".to_string()),
                    created_at: Utc::now(),
                },
            )
            .await?;
        }
        tx.commit()
            .await
            .map_err(|err| internal("upsert_tenant_route commit", err))?;
        Ok(effective)
    }

    pub async fn heartbeat_data_cell(&self, cell: &DataCellRow) -> AppResult<DataCellRow> {
        let row = sqlx::query_as::<_, DataCellRowDb>(
            "INSERT INTO data_cells \
             (cell_id, environment, region, tier, status, service_name, public_api_base, internal_api_base, \
              clickhouse_endpoint_secret_ref, clickhouse_username_secret_ref, clickhouse_password_secret_ref, \
              clickhouse_database_mode, max_orgs, max_metric_points_monthly, max_api_requests_monthly, \
              max_retained_bytes, max_disk_usage_pct, reserved_headroom_pct, last_health_at, last_backup_at, \
              notes, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NULL, $20, $21, $22) \
             ON CONFLICT (cell_id) DO UPDATE SET \
               last_health_at = EXCLUDED.last_health_at, \
               updated_at = EXCLUDED.updated_at \
             RETURNING cell_id, environment, region, tier, status, service_name, public_api_base, internal_api_base, \
               clickhouse_endpoint_secret_ref, clickhouse_username_secret_ref, clickhouse_password_secret_ref, \
               clickhouse_database_mode, max_orgs, max_metric_points_monthly, max_api_requests_monthly, \
               max_retained_bytes, max_disk_usage_pct, reserved_headroom_pct, last_health_at, last_backup_at, \
               notes, created_at, updated_at",
        )
        .bind(&cell.cell_id)
        .bind(&cell.environment)
        .bind(&cell.region)
        .bind(&cell.tier)
        .bind(&cell.status)
        .bind(&cell.service_name)
        .bind(&cell.public_api_base)
        .bind(&cell.internal_api_base)
        .bind(&cell.clickhouse_endpoint_secret_ref)
        .bind(&cell.clickhouse_username_secret_ref)
        .bind(&cell.clickhouse_password_secret_ref)
        .bind(&cell.clickhouse_database_mode)
        .bind(cell.max_orgs)
        .bind(cell.max_metric_points_monthly)
        .bind(cell.max_api_requests_monthly)
        .bind(cell.max_retained_bytes)
        .bind(cell.max_disk_usage_pct)
        .bind(cell.reserved_headroom_pct)
        .bind(cell.last_health_at)
        .bind(&cell.notes)
        .bind(cell.created_at)
        .bind(cell.updated_at)
        .fetch_one(self.pool())
        .await
        .map_err(|err| internal("heartbeat_data_cell", err))?;
        Ok(row.into())
    }

    pub async fn upsert_data_cell(&self, cell: &DataCellRow) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO data_cells \
             (cell_id, environment, region, tier, status, service_name, public_api_base, internal_api_base, \
              clickhouse_endpoint_secret_ref, clickhouse_username_secret_ref, clickhouse_password_secret_ref, \
              clickhouse_database_mode, max_orgs, max_metric_points_monthly, max_api_requests_monthly, \
              max_retained_bytes, max_disk_usage_pct, reserved_headroom_pct, last_health_at, last_backup_at, \
              notes, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) \
             ON CONFLICT (cell_id) DO UPDATE SET \
               environment = EXCLUDED.environment, region = EXCLUDED.region, tier = EXCLUDED.tier, \
               status = EXCLUDED.status, service_name = EXCLUDED.service_name, \
               public_api_base = EXCLUDED.public_api_base, internal_api_base = EXCLUDED.internal_api_base, \
               clickhouse_endpoint_secret_ref = EXCLUDED.clickhouse_endpoint_secret_ref, \
               clickhouse_username_secret_ref = EXCLUDED.clickhouse_username_secret_ref, \
               clickhouse_password_secret_ref = EXCLUDED.clickhouse_password_secret_ref, \
               clickhouse_database_mode = EXCLUDED.clickhouse_database_mode, \
               max_orgs = EXCLUDED.max_orgs, max_metric_points_monthly = EXCLUDED.max_metric_points_monthly, \
               max_api_requests_monthly = EXCLUDED.max_api_requests_monthly, \
               max_retained_bytes = EXCLUDED.max_retained_bytes, max_disk_usage_pct = EXCLUDED.max_disk_usage_pct, \
               reserved_headroom_pct = EXCLUDED.reserved_headroom_pct, last_health_at = EXCLUDED.last_health_at, \
               last_backup_at = EXCLUDED.last_backup_at, notes = EXCLUDED.notes, updated_at = EXCLUDED.updated_at",
        )
        .bind(&cell.cell_id)
        .bind(&cell.environment)
        .bind(&cell.region)
        .bind(&cell.tier)
        .bind(&cell.status)
        .bind(&cell.service_name)
        .bind(&cell.public_api_base)
        .bind(&cell.internal_api_base)
        .bind(&cell.clickhouse_endpoint_secret_ref)
        .bind(&cell.clickhouse_username_secret_ref)
        .bind(&cell.clickhouse_password_secret_ref)
        .bind(&cell.clickhouse_database_mode)
        .bind(cell.max_orgs)
        .bind(cell.max_metric_points_monthly)
        .bind(cell.max_api_requests_monthly)
        .bind(cell.max_retained_bytes)
        .bind(cell.max_disk_usage_pct)
        .bind(cell.reserved_headroom_pct)
        .bind(cell.last_health_at)
        .bind(cell.last_backup_at)
        .bind(&cell.notes)
        .bind(cell.created_at)
        .bind(cell.updated_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_data_cell", err))?;
        Ok(())
    }

    /// Record operator-owned backup evidence for an existing data cell. The
    /// auto-registration heartbeat never marks backups fresh, so placement
    /// fails closed until an operator confirms a backup ran. Returns `None`
    /// when no matching cell row exists.
    pub async fn record_data_cell_backup(
        &self,
        environment: &str,
        cell_id: &str,
        observed_at: DateTime<Utc>,
    ) -> AppResult<Option<DataCellRow>> {
        let row = sqlx::query_as::<_, DataCellRowDb>(
            "UPDATE data_cells SET last_backup_at = $3, updated_at = $3 \
             WHERE environment = $1 AND cell_id = $2 \
             RETURNING cell_id, environment, region, tier, status, service_name, public_api_base, \
               internal_api_base, clickhouse_endpoint_secret_ref, clickhouse_username_secret_ref, \
               clickhouse_password_secret_ref, clickhouse_database_mode, max_orgs, \
               max_metric_points_monthly, max_api_requests_monthly, max_retained_bytes, \
               max_disk_usage_pct, reserved_headroom_pct, last_health_at, last_backup_at, \
               notes, created_at, updated_at",
        )
        .bind(environment)
        .bind(cell_id)
        .bind(observed_at)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("record_data_cell_backup", err))?;
        Ok(row.map(DataCellRow::from))
    }

    pub async fn load_org_invitations(&self) -> AppResult<Vec<OrgInvitationRow>> {
        let rows = sqlx::query_as::<_, OrgInvitationRowDb>(
            "SELECT id, org_id, email, role, status, token_hash, previous_token_hashes, \
             invited_by_user_id, created_at, expires_at, last_sent_at, accepted_at, \
             accepted_by_user_id, revoked_at, revoked_by_user_id, delivery_status, email_provider, \
             provider_message_id FROM org_invitations",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_org_invitations", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_email_deliveries(&self) -> AppResult<Vec<EmailDeliveryRow>> {
        let rows = sqlx::query_as::<_, EmailDeliveryRowDb>(
            "SELECT id, org_id, invitation_id, recipient_email, provider, status, \
             provider_message_id, error_code, created_at FROM email_deliveries",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_email_deliveries", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_dashboard_preferences(&self) -> AppResult<Vec<DashboardPreferenceRow>> {
        let rows = sqlx::query_as::<_, DashboardPreferenceRowDb>(
            "SELECT schema_version, org_id, user_id, selected_project, updated_at \
             FROM dashboard_preferences",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_dashboard_preferences", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_workspace_views(&self) -> AppResult<Vec<WorkspaceViewRow>> {
        let rows = sqlx::query_as::<_, WorkspaceViewRowDb>(
            "SELECT schema_version, id, org_id, owner_user_id, name, project, payload, created_at, \
             updated_at, deleted_at FROM workspace_views",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_workspace_views", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_tenant_routes(&self) -> AppResult<Vec<TenantRouteRecord>> {
        let rows = sqlx::query_as::<_, TenantRouteRowDb>(
            "SELECT org_id, status, provisioner, cell_id, route_version, placement_reason, assigned_at, \
             plan_tier, warehouse_kind, \
             requested_min_replica_memory_gb, requested_max_replica_memory_gb, requested_num_replicas, \
             applied_min_replica_memory_gb, applied_max_replica_memory_gb, applied_num_replicas, \
             endpoint, database, username, password_secret_ref, password_ciphertext, schema_version, \
             service_id, created_at, updated_at, error FROM tenant_routes",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_tenant_routes", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_tenant_route(&self, org_id: Uuid) -> AppResult<Option<TenantRouteRecord>> {
        let row = sqlx::query_as::<_, TenantRouteRowDb>(
            "SELECT org_id, status, provisioner, cell_id, route_version, placement_reason, assigned_at, \
             plan_tier, warehouse_kind, \
             requested_min_replica_memory_gb, requested_max_replica_memory_gb, requested_num_replicas, \
             applied_min_replica_memory_gb, applied_max_replica_memory_gb, applied_num_replicas, \
             endpoint, database, username, password_secret_ref, password_ciphertext, schema_version, \
             service_id, created_at, updated_at, error FROM tenant_routes WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("load_tenant_route", err))?;
        Ok(row.map(Into::into))
    }

    pub async fn load_data_cells(&self) -> AppResult<Vec<DataCellRow>> {
        let rows = sqlx::query_as::<_, DataCellRowDb>(
            "SELECT cell_id, environment, region, tier, status, service_name, public_api_base, internal_api_base, \
             clickhouse_endpoint_secret_ref, clickhouse_username_secret_ref, clickhouse_password_secret_ref, \
             clickhouse_database_mode, max_orgs, max_metric_points_monthly, max_api_requests_monthly, \
             max_retained_bytes, max_disk_usage_pct, reserved_headroom_pct, last_health_at, last_backup_at, \
             notes, created_at, updated_at FROM data_cells ORDER BY environment, tier, cell_id",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_data_cells", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_data_cell_writer_lease(
        &self,
        cell_id: &str,
    ) -> AppResult<Option<DataCellWriterLeaseRow>> {
        let row = sqlx::query_as::<_, DataCellWriterLeaseRowDb>(
            "SELECT cell_id, fence_token, holder_instance_id, service_name, revision, \
             acquired_at, heartbeat_at, expires_at \
             FROM data_cell_writer_leases WHERE cell_id = $1",
        )
        .bind(cell_id)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("load_data_cell_writer_lease", err))?;
        Ok(row.map(Into::into))
    }

    pub async fn acquire_data_cell_writer_lease(
        &self,
        acquire: &DataCellWriterLeaseAcquire,
    ) -> AppResult<DataCellWriterLeaseRow> {
        let ttl_seconds = writer_lease_ttl_seconds(acquire.ttl)?;
        let row = sqlx::query_as::<_, DataCellWriterLeaseRowDb>(
            "WITH ts AS (SELECT clock_timestamp() AS now), \
             cell AS ( \
               SELECT cell_id FROM data_cells \
               WHERE cell_id = $1 AND status IN ('open', 'full', 'draining') \
             ) \
             INSERT INTO data_cell_writer_leases \
               (cell_id, fence_token, holder_instance_id, service_name, revision, acquired_at, heartbeat_at, expires_at) \
             SELECT cell.cell_id, 1, $2, $3, $4, ts.now, ts.now, ts.now + ($5::bigint * interval '1 second') \
             FROM cell CROSS JOIN ts \
             ON CONFLICT (cell_id) DO UPDATE SET \
               fence_token = data_cell_writer_leases.fence_token + 1, \
               holder_instance_id = EXCLUDED.holder_instance_id, \
               service_name = EXCLUDED.service_name, \
               revision = EXCLUDED.revision, \
               acquired_at = (SELECT now FROM ts), \
               heartbeat_at = (SELECT now FROM ts), \
               expires_at = (SELECT now FROM ts) + ($5::bigint * interval '1 second') \
             WHERE data_cell_writer_leases.expires_at <= (SELECT now FROM ts) \
             RETURNING cell_id, fence_token, holder_instance_id, service_name, revision, \
               acquired_at, heartbeat_at, expires_at",
        )
        .bind(&acquire.cell_id)
        .bind(&acquire.holder_instance_id)
        .bind(&acquire.service_name)
        .bind(&acquire.revision)
        .bind(ttl_seconds)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("acquire_data_cell_writer_lease", err))?;
        match row {
            Some(row) => Ok(row.into()),
            None => Err(self.writer_lease_unavailable_error(&acquire.cell_id).await),
        }
    }

    pub async fn renew_data_cell_writer_lease(
        &self,
        renewal: &DataCellWriterLeaseRenewal,
    ) -> AppResult<DataCellWriterLeaseRow> {
        let ttl_seconds = writer_lease_ttl_seconds(renewal.ttl)?;
        let row = sqlx::query_as::<_, DataCellWriterLeaseRowDb>(
            "WITH ts AS (SELECT clock_timestamp() AS now) \
             UPDATE data_cell_writer_leases AS lease \
             SET heartbeat_at = ts.now, expires_at = ts.now + ($4::bigint * interval '1 second') \
             FROM ts, data_cells AS cell \
             WHERE lease.cell_id = $1 \
               AND cell.cell_id = lease.cell_id \
               AND cell.status IN ('open', 'full', 'draining') \
               AND lease.holder_instance_id = $2 \
               AND lease.fence_token = $3 \
               AND lease.expires_at > ts.now \
             RETURNING lease.cell_id, lease.fence_token, lease.holder_instance_id, lease.service_name, lease.revision, \
               lease.acquired_at, lease.heartbeat_at, lease.expires_at",
        )
        .bind(&renewal.cell_id)
        .bind(&renewal.holder_instance_id)
        .bind(renewal.fence_token)
        .bind(ttl_seconds)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("renew_data_cell_writer_lease", err))?;
        row.map(Into::into).ok_or_else(|| {
            AppError::cell_writer_unavailable(format!(
                "data cell {} writer lease is no longer held by this instance",
                renewal.cell_id
            ))
        })
    }

    pub async fn observe_data_cell_writer_lease(
        &self,
        observation: &DataCellWriterLeaseObservation,
    ) -> AppResult<Option<DataCellWriterLeaseRow>> {
        let row = sqlx::query_as::<_, DataCellWriterLeaseRowDb>(
            "WITH ts AS (SELECT clock_timestamp() AS now) \
             SELECT lease.cell_id, lease.fence_token, lease.holder_instance_id, lease.service_name, lease.revision, \
               lease.acquired_at, lease.heartbeat_at, lease.expires_at \
             FROM data_cell_writer_leases AS lease \
             JOIN data_cells AS cell ON cell.cell_id = lease.cell_id \
             CROSS JOIN ts \
             WHERE lease.cell_id = $1 \
               AND lease.holder_instance_id = $2 \
               AND lease.fence_token = $3 \
               AND lease.expires_at > ts.now \
               AND cell.status IN ('open', 'full', 'draining')",
        )
        .bind(&observation.cell_id)
        .bind(&observation.holder_instance_id)
        .bind(observation.fence_token)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("observe_data_cell_writer_lease", err))?;
        Ok(row.map(Into::into))
    }

    pub async fn release_data_cell_writer_lease(
        &self,
        release: &DataCellWriterLeaseRelease,
    ) -> AppResult<DataCellWriterLeaseRow> {
        let row = sqlx::query_as::<_, DataCellWriterLeaseRowDb>(
            "WITH ts AS (SELECT clock_timestamp() AS now) \
             UPDATE data_cell_writer_leases \
             SET heartbeat_at = ts.now, expires_at = LEAST(expires_at, ts.now) \
             FROM ts \
             WHERE cell_id = $1 \
               AND holder_instance_id = $2 \
               AND fence_token = $3 \
               AND expires_at > ts.now \
             RETURNING cell_id, fence_token, holder_instance_id, service_name, revision, \
               acquired_at, heartbeat_at, expires_at",
        )
        .bind(&release.cell_id)
        .bind(&release.holder_instance_id)
        .bind(release.fence_token)
        .fetch_optional(self.pool())
        .await
        .map_err(|err| internal("release_data_cell_writer_lease", err))?;
        row.map(Into::into).ok_or_else(|| {
            AppError::cell_writer_unavailable(format!(
                "data cell {} writer lease is no longer held by this instance",
                release.cell_id
            ))
        })
    }

    pub async fn load_tenant_route_events(&self) -> AppResult<Vec<TenantRouteEventRow>> {
        let rows = sqlx::query_as::<_, TenantRouteEventRowDb>(
            "SELECT id, org_id, old_cell_id, new_cell_id, old_status, new_status, \
             route_version, actor, reason, created_at FROM tenant_route_events \
             ORDER BY created_at, id",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_tenant_route_events", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn writer_lease_unavailable_error(&self, cell_id: &str) -> AppError {
        let status: Result<Option<String>, sqlx::Error> =
            sqlx::query_scalar("SELECT status FROM data_cells WHERE cell_id = $1")
                .bind(cell_id)
                .fetch_optional(self.pool())
                .await;
        match status {
            Ok(None) => AppError::cell_writer_unavailable(format!(
                "data cell {cell_id} is not registered for writer leases"
            )),
            Ok(Some(status)) if !matches!(status.as_str(), "open" | "full" | "draining") => {
                AppError::cell_writer_unavailable(format!(
                    "data cell {cell_id} is not write-enabled"
                ))
            }
            Ok(Some(_)) => AppError::cell_writer_unavailable(format!(
                "data cell {cell_id} writer lease is held by another instance"
            )),
            Err(err) => internal("writer_lease_unavailable_error", err),
        }
    }
}

async fn select_tenant_route_for_update(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
) -> AppResult<Option<TenantRouteRecord>> {
    let row = sqlx::query_as::<_, TenantRouteRowDb>(
        "SELECT org_id, status, provisioner, cell_id, route_version, placement_reason, assigned_at, \
         plan_tier, warehouse_kind, requested_min_replica_memory_gb, requested_max_replica_memory_gb, \
         requested_num_replicas, applied_min_replica_memory_gb, applied_max_replica_memory_gb, \
         applied_num_replicas, endpoint, database, username, password_secret_ref, password_ciphertext, \
         schema_version, service_id, created_at, updated_at, error \
         FROM tenant_routes WHERE org_id = $1 FOR UPDATE",
    )
    .bind(org_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|err| internal("select_tenant_route_for_update", err))?;
    Ok(row.map(Into::into))
}

async fn lock_tenant_route_org(tx: &mut Transaction<'_, Postgres>, org_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(org_id.to_string())
        .execute(&mut **tx)
        .await
        .map_err(|err| internal("lock_tenant_route_org", err))?;
    Ok(())
}

fn explicit_cell_assignment_changed(
    existing: Option<&TenantRouteRecord>,
    route: &TenantRouteRecord,
) -> bool {
    let Some(requested_cell) = route.cell_id.as_ref() else {
        return false;
    };
    existing.and_then(|route| route.cell_id.as_ref()) != Some(requested_cell)
}

async fn ensure_eligible_cell(
    tx: &mut Transaction<'_, Postgres>,
    placement: &TenantRoutePlacement,
    org_id: Uuid,
    require_backup_evidence: bool,
) -> AppResult<()> {
    let Some(cell) = sqlx::query_as::<_, DataCellRowDb>(
        "SELECT cell_id, environment, region, tier, status, service_name, public_api_base, internal_api_base, \
         clickhouse_endpoint_secret_ref, clickhouse_username_secret_ref, clickhouse_password_secret_ref, \
         clickhouse_database_mode, max_orgs, max_metric_points_monthly, max_api_requests_monthly, \
         max_retained_bytes, max_disk_usage_pct, reserved_headroom_pct, last_health_at, last_backup_at, \
         notes, created_at, updated_at FROM data_cells \
         WHERE environment = $1 AND cell_id = $2 FOR UPDATE",
    )
    .bind(&placement.environment)
    .bind(&placement.cell_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|err| internal("select_data_cell_for_update", err))?
    .map(DataCellRow::from) else {
        return Err(AppError::service_unavailable(format!(
            "data cell {} is not registered for placement",
            placement.cell_id
        )));
    };
    if cell.status != "open" {
        return Err(AppError::service_unavailable(format!(
            "data cell {} is not open for placement",
            cell.cell_id
        )));
    }
    let now = Utc::now();
    if data_cell_timestamp_is_not_fresh(now, cell.last_health_at, DATA_CELL_HEALTH_MAX_AGE_SECS) {
        return Err(AppError::service_unavailable(format!(
            "data cell {} has no recent health check",
            cell.cell_id
        )));
    }
    if require_backup_evidence
        && data_cell_timestamp_is_not_fresh(now, cell.last_backup_at, DATA_CELL_BACKUP_MAX_AGE_SECS)
    {
        return Err(AppError::service_unavailable(format!(
            "data cell {} has no recent backup",
            cell.cell_id
        )));
    }
    if let Some(max_orgs) = cell.max_orgs {
        let assigned: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM tenant_routes \
             WHERE cell_id = $1 AND org_id <> $2 AND status IN ('ready', 'provisioning')",
        )
        .bind(&cell.cell_id)
        .bind(org_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(|err| internal("count_data_cell_routes", err))?;
        if assigned >= i64::from(max_orgs) {
            return Err(AppError::service_unavailable(format!(
                "data cell {} has no remaining org capacity",
                cell.cell_id
            )));
        }
    }
    Ok(())
}

fn route_is_managed_cell_candidate(route: &TenantRouteRecord) -> bool {
    matches!(route.status.as_str(), "ready" | "provisioning")
        && route.provisioner != CUSTOMER_CLICKHOUSE_PROVISIONER
}

fn tenant_route_material_change(
    existing: Option<&TenantRouteRecord>,
    effective: &TenantRouteRecord,
) -> bool {
    let Some(existing) = existing else {
        return true;
    };
    existing.status != effective.status
        || existing.provisioner != effective.provisioner
        || existing.cell_id != effective.cell_id
        || existing.endpoint != effective.endpoint
        || existing.database != effective.database
        || existing.username != effective.username
        || existing.password_secret_ref != effective.password_secret_ref
        || existing.password_ciphertext != effective.password_ciphertext
        || existing.schema_version != effective.schema_version
        || existing.service_id != effective.service_id
        || existing.plan_tier != effective.plan_tier
        || existing.warehouse_kind != effective.warehouse_kind
        || existing.placement_reason != effective.placement_reason
        || existing.assigned_at != effective.assigned_at
}

async fn upsert_tenant_route_tx(
    tx: &mut Transaction<'_, Postgres>,
    route: &TenantRouteRecord,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO tenant_routes \
         (org_id, status, provisioner, cell_id, route_version, placement_reason, assigned_at, \
          plan_tier, warehouse_kind, requested_min_replica_memory_gb, requested_max_replica_memory_gb, \
          requested_num_replicas, applied_min_replica_memory_gb, applied_max_replica_memory_gb, \
          applied_num_replicas, endpoint, database, username, password_secret_ref, password_ciphertext, \
          schema_version, service_id, created_at, updated_at, error) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25) \
         ON CONFLICT (org_id) DO UPDATE SET \
           status = EXCLUDED.status, provisioner = EXCLUDED.provisioner, \
           cell_id = EXCLUDED.cell_id, route_version = EXCLUDED.route_version, \
           placement_reason = EXCLUDED.placement_reason, assigned_at = EXCLUDED.assigned_at, \
           plan_tier = EXCLUDED.plan_tier, warehouse_kind = EXCLUDED.warehouse_kind, \
           requested_min_replica_memory_gb = EXCLUDED.requested_min_replica_memory_gb, \
           requested_max_replica_memory_gb = EXCLUDED.requested_max_replica_memory_gb, \
           requested_num_replicas = EXCLUDED.requested_num_replicas, \
           applied_min_replica_memory_gb = EXCLUDED.applied_min_replica_memory_gb, \
           applied_max_replica_memory_gb = EXCLUDED.applied_max_replica_memory_gb, \
           applied_num_replicas = EXCLUDED.applied_num_replicas, endpoint = EXCLUDED.endpoint, \
           database = EXCLUDED.database, username = EXCLUDED.username, \
           password_secret_ref = EXCLUDED.password_secret_ref, password_ciphertext = EXCLUDED.password_ciphertext, \
           schema_version = EXCLUDED.schema_version, service_id = EXCLUDED.service_id, \
           updated_at = EXCLUDED.updated_at, error = EXCLUDED.error",
    )
    .bind(route.org_id)
    .bind(&route.status)
    .bind(&route.provisioner)
    .bind(&route.cell_id)
    .bind(route.route_version)
    .bind(&route.placement_reason)
    .bind(route.assigned_at)
    .bind(&route.plan_tier)
    .bind(&route.warehouse_kind)
    .bind(opt_u32_to_i32(route.requested_min_replica_memory_gb))
    .bind(opt_u32_to_i32(route.requested_max_replica_memory_gb))
    .bind(opt_u32_to_i32(route.requested_num_replicas))
    .bind(opt_u32_to_i32(route.applied_min_replica_memory_gb))
    .bind(opt_u32_to_i32(route.applied_max_replica_memory_gb))
    .bind(opt_u32_to_i32(route.applied_num_replicas))
    .bind(&route.endpoint)
    .bind(&route.database)
    .bind(&route.username)
    .bind(&route.password_secret_ref)
    .bind(&route.password_ciphertext)
    .bind(opt_u32_to_i32(route.schema_version))
    .bind(&route.service_id)
    .bind(route.created_at)
    .bind(route.updated_at)
    .bind(&route.error)
    .execute(&mut **tx)
    .await
    .map_err(|err| internal("upsert_tenant_route_tx", err))?;
    Ok(())
}

async fn insert_tenant_route_event_tx(
    tx: &mut Transaction<'_, Postgres>,
    event: TenantRouteEventRow,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO tenant_route_events \
         (id, org_id, old_cell_id, new_cell_id, old_status, new_status, route_version, actor, reason, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(event.id)
    .bind(event.org_id)
    .bind(&event.old_cell_id)
    .bind(&event.new_cell_id)
    .bind(&event.old_status)
    .bind(&event.new_status)
    .bind(event.route_version)
    .bind(&event.actor)
    .bind(&event.reason)
    .bind(event.created_at)
    .execute(&mut **tx)
    .await
    .map_err(|err| internal("insert_tenant_route_event", err))?;
    Ok(())
}

// === Billing ===============================================================

impl ControlDb {
    pub async fn upsert_billing_account(
        &self,
        account: &BillingAccountProjection,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO billing_accounts \
             (schema_version, org_id, access_state, plan_tier, effective_plan_tier, \
              requested_plan_tier, paid_extra_seats, stripe_customer_id, stripe_subscription_id, \
              subscription_status, current_period_start, current_period_end, cancel_at_period_end, \
              grace_until, pending_intent_id, message, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) \
             ON CONFLICT (org_id) DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, access_state = EXCLUDED.access_state, \
               plan_tier = EXCLUDED.plan_tier, effective_plan_tier = EXCLUDED.effective_plan_tier, \
               requested_plan_tier = EXCLUDED.requested_plan_tier, \
               paid_extra_seats = EXCLUDED.paid_extra_seats, \
               stripe_customer_id = EXCLUDED.stripe_customer_id, \
               stripe_subscription_id = EXCLUDED.stripe_subscription_id, \
               subscription_status = EXCLUDED.subscription_status, \
               current_period_start = EXCLUDED.current_period_start, \
               current_period_end = EXCLUDED.current_period_end, \
               cancel_at_period_end = EXCLUDED.cancel_at_period_end, \
               grace_until = EXCLUDED.grace_until, pending_intent_id = EXCLUDED.pending_intent_id, \
               message = EXCLUDED.message, updated_at = EXCLUDED.updated_at",
        )
        .bind(account.schema_version)
        .bind(account.org_id)
        .bind(&account.access_state)
        .bind(&account.plan_tier)
        .bind(&account.effective_plan_tier)
        .bind(&account.requested_plan_tier)
        .bind(account.paid_extra_seats)
        .bind(&account.stripe_customer_id)
        .bind(&account.stripe_subscription_id)
        .bind(&account.subscription_status)
        .bind(account.current_period_start)
        .bind(account.current_period_end)
        .bind(account.cancel_at_period_end)
        .bind(account.grace_until)
        .bind(account.pending_intent_id)
        .bind(&account.message)
        .bind(account.updated_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_billing_account", err))?;
        Ok(())
    }

    pub async fn upsert_billing_checkout_intent(
        &self,
        intent: &BillingCheckoutIntent,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO billing_checkout_intents \
             (schema_version, id, org_id, user_id, action, target_plan_tier, pending_seat_emails, \
              stripe_checkout_session_id, stripe_customer_id, stripe_subscription_id, status, url, \
              created_at, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) \
             ON CONFLICT (id) DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, action = EXCLUDED.action, \
               target_plan_tier = EXCLUDED.target_plan_tier, \
               pending_seat_emails = EXCLUDED.pending_seat_emails, \
               stripe_checkout_session_id = EXCLUDED.stripe_checkout_session_id, \
               stripe_customer_id = EXCLUDED.stripe_customer_id, \
               stripe_subscription_id = EXCLUDED.stripe_subscription_id, \
               status = EXCLUDED.status, url = EXCLUDED.url, expires_at = EXCLUDED.expires_at",
        )
        .bind(intent.schema_version)
        .bind(intent.id)
        .bind(intent.org_id)
        .bind(intent.user_id)
        .bind(&intent.action)
        .bind(&intent.target_plan_tier)
        .bind(&intent.pending_seat_emails)
        .bind(&intent.stripe_checkout_session_id)
        .bind(&intent.stripe_customer_id)
        .bind(&intent.stripe_subscription_id)
        .bind(&intent.status)
        .bind(&intent.url)
        .bind(intent.created_at)
        .bind(intent.expires_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_billing_checkout_intent", err))?;
        Ok(())
    }

    pub async fn upsert_billing_change_intent(
        &self,
        intent: &BillingChangeIntent,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO billing_change_intents \
             (schema_version, id, org_id, user_id, action, target_plan_tier, target_extra_seats, \
              pending_seat_email, pending_seat_role, stripe_invoice_id, stripe_subscription_id, \
              status, created_at, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) \
             ON CONFLICT (id) DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, action = EXCLUDED.action, \
               target_plan_tier = EXCLUDED.target_plan_tier, \
               target_extra_seats = EXCLUDED.target_extra_seats, \
               pending_seat_email = EXCLUDED.pending_seat_email, \
               pending_seat_role = EXCLUDED.pending_seat_role, \
               stripe_invoice_id = EXCLUDED.stripe_invoice_id, \
               stripe_subscription_id = EXCLUDED.stripe_subscription_id, \
               status = EXCLUDED.status, expires_at = EXCLUDED.expires_at",
        )
        .bind(intent.schema_version)
        .bind(intent.id)
        .bind(intent.org_id)
        .bind(intent.user_id)
        .bind(&intent.action)
        .bind(&intent.target_plan_tier)
        .bind(intent.target_extra_seats)
        .bind(&intent.pending_seat_email)
        .bind(&intent.pending_seat_role)
        .bind(&intent.stripe_invoice_id)
        .bind(&intent.stripe_subscription_id)
        .bind(&intent.status)
        .bind(intent.created_at)
        .bind(intent.expires_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_billing_change_intent", err))?;
        Ok(())
    }

    pub async fn upsert_billing_subscription(
        &self,
        sub: &BillingSubscriptionRecord,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO billing_subscriptions \
             (schema_version, stripe_subscription_id, org_id, stripe_customer_id, status, plan_tier, \
              paid_extra_seats, current_period_start, current_period_end, cancel_at_period_end, \
              metadata, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             ON CONFLICT (stripe_subscription_id) DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, org_id = EXCLUDED.org_id, \
               stripe_customer_id = EXCLUDED.stripe_customer_id, status = EXCLUDED.status, \
               plan_tier = EXCLUDED.plan_tier, paid_extra_seats = EXCLUDED.paid_extra_seats, \
               current_period_start = EXCLUDED.current_period_start, \
               current_period_end = EXCLUDED.current_period_end, \
               cancel_at_period_end = EXCLUDED.cancel_at_period_end, metadata = EXCLUDED.metadata, \
               updated_at = EXCLUDED.updated_at",
        )
        .bind(sub.schema_version)
        .bind(&sub.stripe_subscription_id)
        .bind(sub.org_id)
        .bind(&sub.stripe_customer_id)
        .bind(&sub.status)
        .bind(&sub.plan_tier)
        .bind(sub.paid_extra_seats)
        .bind(sub.current_period_start)
        .bind(sub.current_period_end)
        .bind(sub.cancel_at_period_end)
        .bind(&sub.metadata)
        .bind(sub.updated_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_billing_subscription", err))?;
        Ok(())
    }

    pub async fn upsert_billing_event(&self, event: &BillingEventRecord) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO billing_events \
             (schema_version, stripe_event_id, event_type, org_id, stripe_object_id, processed_at) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (stripe_event_id) DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, event_type = EXCLUDED.event_type, \
               org_id = EXCLUDED.org_id, stripe_object_id = EXCLUDED.stripe_object_id, \
               processed_at = EXCLUDED.processed_at",
        )
        .bind(event.schema_version)
        .bind(&event.stripe_event_id)
        .bind(&event.event_type)
        .bind(event.org_id)
        .bind(&event.stripe_object_id)
        .bind(event.processed_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_billing_event", err))?;
        Ok(())
    }

    pub async fn upsert_billing_usage_report(
        &self,
        report: &BillingUsageReportRecord,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO billing_usage_reports \
             (schema_version, id, org_id, usage_period_start, usage_period_end, \
              billable_storage_bytes, reported_gib, reported_storage_gib_delta, \
              billable_api_requests, reported_api_requests, reported_api_requests_delta, \
              stripe_event_id, stripe_storage_event_id, stripe_api_request_event_id, status, \
              created_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) \
             ON CONFLICT (id) DO UPDATE SET \
               schema_version = EXCLUDED.schema_version, usage_period_start = EXCLUDED.usage_period_start, \
               usage_period_end = EXCLUDED.usage_period_end, \
               billable_storage_bytes = EXCLUDED.billable_storage_bytes, \
               reported_gib = EXCLUDED.reported_gib, \
               reported_storage_gib_delta = EXCLUDED.reported_storage_gib_delta, \
               billable_api_requests = EXCLUDED.billable_api_requests, \
               reported_api_requests = EXCLUDED.reported_api_requests, \
               reported_api_requests_delta = EXCLUDED.reported_api_requests_delta, \
               stripe_event_id = EXCLUDED.stripe_event_id, \
               stripe_storage_event_id = EXCLUDED.stripe_storage_event_id, \
               stripe_api_request_event_id = EXCLUDED.stripe_api_request_event_id, \
               status = EXCLUDED.status, created_at = EXCLUDED.created_at",
        )
        .bind(report.schema_version)
        .bind(report.id)
        .bind(report.org_id)
        .bind(report.usage_period_start)
        .bind(report.usage_period_end)
        .bind(report.billable_storage_bytes)
        .bind(report.reported_gib)
        .bind(report.reported_storage_gib_delta)
        .bind(report.billable_api_requests)
        .bind(report.reported_api_requests)
        .bind(report.reported_api_requests_delta)
        .bind(&report.stripe_event_id)
        .bind(&report.stripe_storage_event_id)
        .bind(&report.stripe_api_request_event_id)
        .bind(&report.status)
        .bind(report.created_at)
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_billing_usage_report", err))?;
        Ok(())
    }

    pub async fn load_billing_accounts(&self) -> AppResult<Vec<BillingAccountProjection>> {
        let rows = sqlx::query_as::<_, BillingAccountRowDb>(
            "SELECT schema_version, org_id, access_state, plan_tier, effective_plan_tier, \
             requested_plan_tier, paid_extra_seats, stripe_customer_id, stripe_subscription_id, \
             subscription_status, current_period_start, current_period_end, cancel_at_period_end, \
             grace_until, pending_intent_id, message, updated_at FROM billing_accounts",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_billing_accounts", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_billing_checkout_intents(&self) -> AppResult<Vec<BillingCheckoutIntent>> {
        let rows = sqlx::query_as::<_, BillingCheckoutIntentRowDb>(
            "SELECT schema_version, id, org_id, user_id, action, target_plan_tier, \
             pending_seat_emails, stripe_checkout_session_id, stripe_customer_id, \
             stripe_subscription_id, status, url, created_at, expires_at \
             FROM billing_checkout_intents",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_billing_checkout_intents", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_billing_change_intents(&self) -> AppResult<Vec<BillingChangeIntent>> {
        let rows = sqlx::query_as::<_, BillingChangeIntentRowDb>(
            "SELECT schema_version, id, org_id, user_id, action, target_plan_tier, \
             target_extra_seats, pending_seat_email, pending_seat_role, stripe_invoice_id, \
             stripe_subscription_id, status, created_at, expires_at FROM billing_change_intents",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_billing_change_intents", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_billing_subscriptions(&self) -> AppResult<Vec<BillingSubscriptionRecord>> {
        let rows = sqlx::query_as::<_, BillingSubscriptionRowDb>(
            "SELECT schema_version, org_id, stripe_subscription_id, stripe_customer_id, status, \
             plan_tier, paid_extra_seats, current_period_start, current_period_end, \
             cancel_at_period_end, metadata, updated_at FROM billing_subscriptions",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_billing_subscriptions", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_billing_events(&self) -> AppResult<Vec<BillingEventRecord>> {
        let rows = sqlx::query_as::<_, BillingEventRowDb>(
            "SELECT schema_version, stripe_event_id, event_type, org_id, stripe_object_id, \
             processed_at FROM billing_events",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_billing_events", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn load_billing_usage_reports(&self) -> AppResult<Vec<BillingUsageReportRecord>> {
        let rows = sqlx::query_as::<_, BillingUsageReportRowDb>(
            "SELECT schema_version, id, org_id, usage_period_start, usage_period_end, \
             billable_storage_bytes, reported_gib, reported_storage_gib_delta, \
             billable_api_requests, reported_api_requests, reported_api_requests_delta, \
             stripe_event_id, stripe_storage_event_id, stripe_api_request_event_id, status, \
             created_at FROM billing_usage_reports",
        )
        .fetch_all(self.pool())
        .await
        .map_err(|err| internal("load_billing_usage_reports", err))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

mod rows;
use rows::*;

#[cfg(test)]
mod tests;
