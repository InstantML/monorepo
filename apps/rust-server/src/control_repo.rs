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

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    control_db::ControlDb,
    domain::{
        BillingAccountProjection, BillingChangeIntent, BillingCheckoutIntent, BillingEventRecord,
        BillingSubscriptionRecord, BillingUsageReportRecord, DashboardPreferenceRow,
        EmailDeliveryRow, MembershipRow, OrgInvitationRow, OrganizationRow, PublicApiKeyRow,
        ServiceAccountRow, UserRow, UserSessionRow, WorkspaceViewRow,
    },
    errors::{AppError, AppResult},
    store::TenantRouteRecord,
};

/// Postgres SQLSTATE for a unique-constraint violation.
const PG_UNIQUE_VIOLATION: &str = "23505";

fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error()
        .and_then(|db| db.code())
        .map(|code| code == PG_UNIQUE_VIOLATION)
        .unwrap_or(false)
}

fn internal(context: &str, err: sqlx::Error) -> AppError {
    AppError::internal(format!("control-plane query failed ({context}): {err}"))
}

// --- Row mappers ----------------------------------------------------------

#[derive(FromRow)]
struct UserRowDb {
    id: Uuid,
    primary_email: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    created_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
}

impl From<UserRowDb> for UserRow {
    fn from(row: UserRowDb) -> Self {
        UserRow {
            id: row.id,
            primary_email: row.primary_email,
            display_name: row.display_name,
            avatar_url: row.avatar_url,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
        }
    }
}

#[derive(FromRow)]
struct OrganizationRowDb {
    id: Uuid,
    slug: String,
    name: String,
    plan_tier: String,
    account_type: String,
    seat_limit: i32,
    created_by_user_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    tenant_routing_tier: String,
    storage_choice: String,
    storage_state: String,
}

impl From<OrganizationRowDb> for OrganizationRow {
    fn from(row: OrganizationRowDb) -> Self {
        OrganizationRow {
            id: row.id,
            slug: row.slug,
            name: row.name,
            plan_tier: row.plan_tier,
            account_type: row.account_type,
            seat_limit: row.seat_limit,
            created_by_user_id: row.created_by_user_id,
            created_at: row.created_at,
            tenant_routing_tier: row.tenant_routing_tier,
            storage_choice: row.storage_choice,
            storage_state: row.storage_state,
        }
    }
}

#[derive(FromRow)]
struct MembershipRowDb {
    id: Uuid,
    org_id: Uuid,
    user_id: Uuid,
    role: String,
    status: String,
    created_at: DateTime<Utc>,
}

impl From<MembershipRowDb> for MembershipRow {
    fn from(row: MembershipRowDb) -> Self {
        MembershipRow {
            id: row.id,
            org_id: row.org_id,
            user_id: row.user_id,
            role: row.role,
            status: row.status,
            created_at: row.created_at,
        }
    }
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

#[derive(FromRow)]
struct ServiceAccountRowDb {
    id: Uuid,
    org_id: Uuid,
    name: String,
    created_by_user_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    disabled_at: Option<DateTime<Utc>>,
}

impl From<ServiceAccountRowDb> for ServiceAccountRow {
    fn from(row: ServiceAccountRowDb) -> Self {
        ServiceAccountRow {
            id: row.id,
            org_id: row.org_id,
            name: row.name,
            created_by_user_id: row.created_by_user_id,
            created_at: row.created_at,
            disabled_at: row.disabled_at,
        }
    }
}

#[derive(FromRow)]
struct SessionRowDb {
    id: Uuid,
    user_id: Uuid,
    org_id: Uuid,
    token_hash: Vec<u8>,
    metadata: Value,
    created_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}

impl From<SessionRowDb> for NewSession {
    fn from(row: SessionRowDb) -> Self {
        NewSession {
            row: UserSessionRow {
                id: row.id,
                user_id: row.user_id,
                org_id: row.org_id,
                metadata: row.metadata,
                created_at: row.created_at,
                last_seen_at: row.last_seen_at,
                expires_at: row.expires_at,
                revoked_at: row.revoked_at,
            },
            token_hash: row.token_hash,
        }
    }
}

#[derive(FromRow)]
struct ApiKeyRowDb {
    id: Uuid,
    org_id: Uuid,
    service_account_id: Uuid,
    name: String,
    key_prefix: String,
    key_hash: Vec<u8>,
    scopes: Vec<String>,
    project_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

impl From<ApiKeyRowDb> for ApiKeyWithHash {
    fn from(row: ApiKeyRowDb) -> Self {
        ApiKeyWithHash {
            row: PublicApiKeyRow {
                id: row.id,
                org_id: row.org_id,
                service_account_id: row.service_account_id,
                name: row.name,
                key_prefix: row.key_prefix,
                scopes: row.scopes,
                project_id: row.project_id,
                created_at: row.created_at,
                expires_at: row.expires_at,
                last_used_at: row.last_used_at,
                revoked_at: row.revoked_at,
            },
            key_hash: row.key_hash,
        }
    }
}

#[derive(FromRow)]
struct IdentityRowDb {
    provider: String,
    provider_subject: String,
    user_id: Uuid,
}

impl From<IdentityRowDb> for LoadedIdentity {
    fn from(row: IdentityRowDb) -> Self {
        LoadedIdentity {
            provider: row.provider,
            provider_subject: row.provider_subject,
            user_id: row.user_id,
        }
    }
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

#[derive(FromRow)]
struct OrgInvitationRowDb {
    id: Uuid,
    org_id: Uuid,
    email: String,
    role: String,
    status: String,
    token_hash: Vec<u8>,
    previous_token_hashes: Vec<Vec<u8>>,
    invited_by_user_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    last_sent_at: Option<DateTime<Utc>>,
    accepted_at: Option<DateTime<Utc>>,
    accepted_by_user_id: Option<Uuid>,
    revoked_at: Option<DateTime<Utc>>,
    revoked_by_user_id: Option<Uuid>,
    delivery_status: String,
    email_provider: Option<String>,
    provider_message_id: Option<String>,
}

impl From<OrgInvitationRowDb> for OrgInvitationRow {
    fn from(row: OrgInvitationRowDb) -> Self {
        OrgInvitationRow {
            id: row.id,
            org_id: row.org_id,
            email: row.email,
            role: row.role,
            status: row.status,
            token_hash: row.token_hash,
            previous_token_hashes: row.previous_token_hashes,
            invited_by_user_id: row.invited_by_user_id,
            created_at: row.created_at,
            expires_at: row.expires_at,
            last_sent_at: row.last_sent_at,
            accepted_at: row.accepted_at,
            accepted_by_user_id: row.accepted_by_user_id,
            revoked_at: row.revoked_at,
            revoked_by_user_id: row.revoked_by_user_id,
            delivery_status: row.delivery_status,
            email_provider: row.email_provider,
            provider_message_id: row.provider_message_id,
        }
    }
}

#[derive(FromRow)]
struct EmailDeliveryRowDb {
    id: Uuid,
    org_id: Uuid,
    invitation_id: Uuid,
    recipient_email: String,
    provider: String,
    status: String,
    provider_message_id: Option<String>,
    error_code: Option<String>,
    created_at: DateTime<Utc>,
}

impl From<EmailDeliveryRowDb> for EmailDeliveryRow {
    fn from(row: EmailDeliveryRowDb) -> Self {
        EmailDeliveryRow {
            id: row.id,
            org_id: row.org_id,
            invitation_id: row.invitation_id,
            recipient_email: row.recipient_email,
            provider: row.provider,
            status: row.status,
            provider_message_id: row.provider_message_id,
            error_code: row.error_code,
            created_at: row.created_at,
        }
    }
}

#[derive(FromRow)]
struct DashboardPreferenceRowDb {
    schema_version: i32,
    org_id: Uuid,
    user_id: Option<Uuid>,
    selected_project: Option<String>,
    updated_at: DateTime<Utc>,
}

impl From<DashboardPreferenceRowDb> for DashboardPreferenceRow {
    fn from(row: DashboardPreferenceRowDb) -> Self {
        DashboardPreferenceRow {
            schema_version: row.schema_version,
            org_id: row.org_id,
            user_id: row.user_id,
            selected_project: row.selected_project,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow)]
struct WorkspaceViewRowDb {
    schema_version: i32,
    id: Uuid,
    org_id: Uuid,
    owner_user_id: Option<Uuid>,
    name: String,
    project: Option<String>,
    payload: Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
}

impl From<WorkspaceViewRowDb> for WorkspaceViewRow {
    fn from(row: WorkspaceViewRowDb) -> Self {
        WorkspaceViewRow {
            schema_version: row.schema_version,
            id: row.id,
            org_id: row.org_id,
            owner_user_id: row.owner_user_id,
            name: row.name,
            project: row.project,
            payload: row.payload,
            created_at: row.created_at,
            updated_at: row.updated_at,
            deleted_at: row.deleted_at,
        }
    }
}

/// Postgres stores replica sizing as signed `integer`; the domain type uses
/// `u32`. These are small positive counts, so the cast is lossless in practice.
fn opt_u32_to_i32(value: Option<u32>) -> Option<i32> {
    value.map(|v| v as i32)
}

fn opt_i32_to_u32(value: Option<i32>) -> Option<u32> {
    value.map(|v| v as u32)
}

#[derive(FromRow)]
struct TenantRouteRowDb {
    org_id: Uuid,
    status: String,
    provisioner: String,
    plan_tier: Option<String>,
    warehouse_kind: Option<String>,
    requested_min_replica_memory_gb: Option<i32>,
    requested_max_replica_memory_gb: Option<i32>,
    requested_num_replicas: Option<i32>,
    applied_min_replica_memory_gb: Option<i32>,
    applied_max_replica_memory_gb: Option<i32>,
    applied_num_replicas: Option<i32>,
    endpoint: String,
    database: String,
    username: String,
    password_secret_ref: Option<String>,
    password_ciphertext: Option<String>,
    schema_version: Option<i32>,
    service_id: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    error: Option<String>,
}

impl From<TenantRouteRowDb> for TenantRouteRecord {
    fn from(row: TenantRouteRowDb) -> Self {
        TenantRouteRecord {
            org_id: row.org_id,
            status: row.status,
            provisioner: row.provisioner,
            plan_tier: row.plan_tier,
            warehouse_kind: row.warehouse_kind,
            requested_min_replica_memory_gb: opt_i32_to_u32(row.requested_min_replica_memory_gb),
            requested_max_replica_memory_gb: opt_i32_to_u32(row.requested_max_replica_memory_gb),
            requested_num_replicas: opt_i32_to_u32(row.requested_num_replicas),
            applied_min_replica_memory_gb: opt_i32_to_u32(row.applied_min_replica_memory_gb),
            applied_max_replica_memory_gb: opt_i32_to_u32(row.applied_max_replica_memory_gb),
            applied_num_replicas: opt_i32_to_u32(row.applied_num_replicas),
            endpoint: row.endpoint,
            database: row.database,
            username: row.username,
            password_secret_ref: row.password_secret_ref,
            password_ciphertext: row.password_ciphertext,
            schema_version: opt_i32_to_u32(row.schema_version),
            service_id: row.service_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            error: row.error,
        }
    }
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

    pub async fn upsert_tenant_route(&self, route: &TenantRouteRecord) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO tenant_routes \
             (org_id, status, provisioner, plan_tier, warehouse_kind, \
              requested_min_replica_memory_gb, requested_max_replica_memory_gb, requested_num_replicas, \
              applied_min_replica_memory_gb, applied_max_replica_memory_gb, applied_num_replicas, \
              endpoint, database, username, password_secret_ref, password_ciphertext, \
              schema_version, service_id, created_at, updated_at, error) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) \
             ON CONFLICT (org_id) DO UPDATE SET \
               status = EXCLUDED.status, provisioner = EXCLUDED.provisioner, \
               plan_tier = EXCLUDED.plan_tier, warehouse_kind = EXCLUDED.warehouse_kind, \
               requested_min_replica_memory_gb = EXCLUDED.requested_min_replica_memory_gb, \
               requested_max_replica_memory_gb = EXCLUDED.requested_max_replica_memory_gb, \
               requested_num_replicas = EXCLUDED.requested_num_replicas, \
               applied_min_replica_memory_gb = EXCLUDED.applied_min_replica_memory_gb, \
               applied_max_replica_memory_gb = EXCLUDED.applied_max_replica_memory_gb, \
               applied_num_replicas = EXCLUDED.applied_num_replicas, \
               endpoint = EXCLUDED.endpoint, database = EXCLUDED.database, username = EXCLUDED.username, \
               password_secret_ref = EXCLUDED.password_secret_ref, \
               password_ciphertext = EXCLUDED.password_ciphertext, \
               schema_version = EXCLUDED.schema_version, service_id = EXCLUDED.service_id, \
               updated_at = EXCLUDED.updated_at, error = EXCLUDED.error",
        )
        .bind(route.org_id)
        .bind(&route.status)
        .bind(&route.provisioner)
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
        .execute(self.pool())
        .await
        .map_err(|err| internal("upsert_tenant_route", err))?;
        Ok(())
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
            "SELECT org_id, status, provisioner, plan_tier, warehouse_kind, \
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
}

// === Billing ===============================================================

#[derive(FromRow)]
struct BillingAccountRowDb {
    schema_version: i32,
    org_id: Uuid,
    access_state: String,
    plan_tier: String,
    effective_plan_tier: String,
    requested_plan_tier: Option<String>,
    paid_extra_seats: i32,
    stripe_customer_id: Option<String>,
    stripe_subscription_id: Option<String>,
    subscription_status: Option<String>,
    current_period_start: Option<DateTime<Utc>>,
    current_period_end: Option<DateTime<Utc>>,
    cancel_at_period_end: bool,
    grace_until: Option<DateTime<Utc>>,
    pending_intent_id: Option<Uuid>,
    message: Option<String>,
    updated_at: DateTime<Utc>,
}

impl From<BillingAccountRowDb> for BillingAccountProjection {
    fn from(row: BillingAccountRowDb) -> Self {
        BillingAccountProjection {
            schema_version: row.schema_version,
            org_id: row.org_id,
            access_state: row.access_state,
            plan_tier: row.plan_tier,
            effective_plan_tier: row.effective_plan_tier,
            requested_plan_tier: row.requested_plan_tier,
            paid_extra_seats: row.paid_extra_seats,
            stripe_customer_id: row.stripe_customer_id,
            stripe_subscription_id: row.stripe_subscription_id,
            subscription_status: row.subscription_status,
            current_period_start: row.current_period_start,
            current_period_end: row.current_period_end,
            cancel_at_period_end: row.cancel_at_period_end,
            grace_until: row.grace_until,
            pending_intent_id: row.pending_intent_id,
            message: row.message,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow)]
struct BillingCheckoutIntentRowDb {
    schema_version: i32,
    id: Uuid,
    org_id: Uuid,
    user_id: Uuid,
    action: String,
    target_plan_tier: String,
    pending_seat_emails: Vec<String>,
    stripe_checkout_session_id: Option<String>,
    stripe_customer_id: Option<String>,
    stripe_subscription_id: Option<String>,
    status: String,
    url: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
}

impl From<BillingCheckoutIntentRowDb> for BillingCheckoutIntent {
    fn from(row: BillingCheckoutIntentRowDb) -> Self {
        BillingCheckoutIntent {
            schema_version: row.schema_version,
            id: row.id,
            org_id: row.org_id,
            user_id: row.user_id,
            action: row.action,
            target_plan_tier: row.target_plan_tier,
            pending_seat_emails: row.pending_seat_emails,
            stripe_checkout_session_id: row.stripe_checkout_session_id,
            stripe_customer_id: row.stripe_customer_id,
            stripe_subscription_id: row.stripe_subscription_id,
            status: row.status,
            url: row.url,
            created_at: row.created_at,
            expires_at: row.expires_at,
        }
    }
}

#[derive(FromRow)]
struct BillingChangeIntentRowDb {
    schema_version: i32,
    id: Uuid,
    org_id: Uuid,
    user_id: Uuid,
    action: String,
    target_plan_tier: Option<String>,
    target_extra_seats: Option<i32>,
    pending_seat_email: Option<String>,
    pending_seat_role: Option<String>,
    stripe_invoice_id: Option<String>,
    stripe_subscription_id: Option<String>,
    status: String,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
}

impl From<BillingChangeIntentRowDb> for BillingChangeIntent {
    fn from(row: BillingChangeIntentRowDb) -> Self {
        BillingChangeIntent {
            schema_version: row.schema_version,
            id: row.id,
            org_id: row.org_id,
            user_id: row.user_id,
            action: row.action,
            target_plan_tier: row.target_plan_tier,
            target_extra_seats: row.target_extra_seats,
            pending_seat_email: row.pending_seat_email,
            pending_seat_role: row.pending_seat_role,
            stripe_invoice_id: row.stripe_invoice_id,
            stripe_subscription_id: row.stripe_subscription_id,
            status: row.status,
            created_at: row.created_at,
            expires_at: row.expires_at,
        }
    }
}

#[derive(FromRow)]
struct BillingSubscriptionRowDb {
    schema_version: i32,
    org_id: Uuid,
    stripe_subscription_id: String,
    stripe_customer_id: Option<String>,
    status: String,
    plan_tier: String,
    paid_extra_seats: i32,
    current_period_start: Option<DateTime<Utc>>,
    current_period_end: Option<DateTime<Utc>>,
    cancel_at_period_end: bool,
    metadata: Value,
    updated_at: DateTime<Utc>,
}

impl From<BillingSubscriptionRowDb> for BillingSubscriptionRecord {
    fn from(row: BillingSubscriptionRowDb) -> Self {
        BillingSubscriptionRecord {
            schema_version: row.schema_version,
            org_id: row.org_id,
            stripe_subscription_id: row.stripe_subscription_id,
            stripe_customer_id: row.stripe_customer_id,
            status: row.status,
            plan_tier: row.plan_tier,
            paid_extra_seats: row.paid_extra_seats,
            current_period_start: row.current_period_start,
            current_period_end: row.current_period_end,
            cancel_at_period_end: row.cancel_at_period_end,
            metadata: row.metadata,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow)]
struct BillingEventRowDb {
    schema_version: i32,
    stripe_event_id: String,
    event_type: String,
    org_id: Option<Uuid>,
    stripe_object_id: Option<String>,
    processed_at: DateTime<Utc>,
}

impl From<BillingEventRowDb> for BillingEventRecord {
    fn from(row: BillingEventRowDb) -> Self {
        BillingEventRecord {
            schema_version: row.schema_version,
            stripe_event_id: row.stripe_event_id,
            event_type: row.event_type,
            org_id: row.org_id,
            stripe_object_id: row.stripe_object_id,
            processed_at: row.processed_at,
        }
    }
}

#[derive(FromRow)]
struct BillingUsageReportRowDb {
    schema_version: i32,
    id: Uuid,
    org_id: Uuid,
    usage_period_start: DateTime<Utc>,
    usage_period_end: DateTime<Utc>,
    billable_storage_bytes: i64,
    reported_gib: i64,
    reported_storage_gib_delta: i64,
    billable_api_requests: i64,
    reported_api_requests: i64,
    reported_api_requests_delta: i64,
    stripe_event_id: Option<String>,
    stripe_storage_event_id: Option<String>,
    stripe_api_request_event_id: Option<String>,
    status: String,
    created_at: DateTime<Utc>,
}

impl From<BillingUsageReportRowDb> for BillingUsageReportRecord {
    fn from(row: BillingUsageReportRowDb) -> Self {
        BillingUsageReportRecord {
            schema_version: row.schema_version,
            id: row.id,
            org_id: row.org_id,
            usage_period_start: row.usage_period_start,
            usage_period_end: row.usage_period_end,
            billable_storage_bytes: row.billable_storage_bytes,
            reported_gib: row.reported_gib,
            reported_storage_gib_delta: row.reported_storage_gib_delta,
            billable_api_requests: row.billable_api_requests,
            reported_api_requests: row.reported_api_requests,
            reported_api_requests_delta: row.reported_api_requests_delta,
            stripe_event_id: row.stripe_event_id,
            stripe_storage_event_id: row.stripe_storage_event_id,
            stripe_api_request_event_id: row.stripe_api_request_event_id,
            status: row.status,
            created_at: row.created_at,
        }
    }
}

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

#[cfg(test)]
mod tests {
    //! These tests run against a real Postgres. `#[sqlx::test]` provisions a
    //! fresh, isolated database per test and applies `./migrations` first, so
    //! they exercise the actual `UNIQUE` constraints and transaction semantics
    //! — the whole point of the migration. They require a reachable server via
    //! `DATABASE_URL` (e.g. the `postgres` service in docker-compose).
    use super::*;
    use sqlx::PgPool;

    fn user(email: &str) -> UserRow {
        UserRow {
            id: Uuid::new_v4(),
            primary_email: email.to_string(),
            display_name: None,
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        }
    }

    fn identity(subject: &str) -> NewIdentity {
        NewIdentity {
            provider: "test".to_string(),
            provider_subject: subject.to_string(),
        }
    }

    fn org(slug: &str, owner: Option<Uuid>) -> OrganizationRow {
        OrganizationRow {
            id: Uuid::new_v4(),
            slug: slug.to_string(),
            name: slug.to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 5,
            created_by_user_id: owner,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: "hosted".to_string(),
            storage_state: "ready".to_string(),
        }
    }

    fn membership(org_id: Uuid, user_id: Uuid) -> MembershipRow {
        MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id,
            role: "owner".to_string(),
            status: "active".to_string(),
            created_at: Utc::now(),
        }
    }

    #[sqlx::test]
    async fn create_user_is_idempotent_on_identity_and_email(pool: PgPool) {
        let db = ControlDb::from_pool(pool);
        let u = user("a@example.com");
        let created = db
            .create_user_with_identity(&u, &identity("subj-1"))
            .await
            .unwrap();
        assert_eq!(created.id, u.id);

        // Same identity → same user, no duplicate.
        let again = db
            .create_user_with_identity(&user("a@example.com"), &identity("subj-1"))
            .await
            .unwrap();
        assert_eq!(again.id, u.id);

        // Same email via a different identity → still resolves to the original.
        let by_email = db
            .create_user_with_identity(&user("a@example.com"), &identity("subj-2"))
            .await
            .unwrap();
        assert_eq!(by_email.id, u.id);

        assert_eq!(db.list_users().await.unwrap().len(), 1);
    }

    #[sqlx::test]
    async fn duplicate_org_slug_is_rejected(pool: PgPool) {
        let db = ControlDb::from_pool(pool);
        let owner = user("owner@example.com");
        db.create_user_with_identity(&owner, &identity("owner"))
            .await
            .unwrap();

        let first = org("acme", Some(owner.id));
        db.create_org_with_owner(&first, Some(&membership(first.id, owner.id)))
            .await
            .unwrap();

        // Second signup for the same slug must conflict — the bug the old
        // in-memory model allowed to silently succeed.
        let second = org("acme", Some(owner.id));
        let err = db
            .create_org_with_owner(&second, Some(&membership(second.id, owner.id)))
            .await
            .unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::CONFLICT);

        // The rejected org left no partial state behind.
        assert!(db.get_org(second.id).await.unwrap().is_none());
    }

    #[sqlx::test]
    async fn org_and_owner_membership_commit_atomically(pool: PgPool) {
        let db = ControlDb::from_pool(pool);
        let owner = user("owner@example.com");
        db.create_user_with_identity(&owner, &identity("owner"))
            .await
            .unwrap();

        let o = org("beta", Some(owner.id));
        db.create_org_with_owner(&o, Some(&membership(o.id, owner.id)))
            .await
            .unwrap();

        // Org exists *and* has an owner membership — never one without the other.
        assert!(db.get_org(o.id).await.unwrap().is_some());
        let m = db.membership_for(o.id, owner.id).await.unwrap().unwrap();
        assert_eq!(m.role, "owner");
    }

    #[sqlx::test]
    async fn upsert_org_is_idempotent_by_id_but_rejects_slug_steal(pool: PgPool) {
        let db = ControlDb::from_pool(pool);
        let mut acme = org("acme", None);
        db.upsert_org(&acme).await.unwrap();

        // Re-upserting the same id updates in place — no duplicate, no conflict.
        acme.name = "Acme Renamed".to_string();
        db.upsert_org(&acme).await.unwrap();
        assert_eq!(
            db.get_org(acme.id).await.unwrap().unwrap().name,
            "Acme Renamed"
        );
        assert_eq!(db.load_orgs().await.unwrap().len(), 1);

        // A *different* org claiming the same slug must conflict — the race the
        // old in-memory model lost.
        let impostor = org("acme", None);
        let err = db.upsert_org(&impostor).await.unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::CONFLICT);
        assert_eq!(db.load_orgs().await.unwrap().len(), 1);
    }

    #[sqlx::test]
    async fn upsert_user_round_trips_through_load(pool: PgPool) {
        let db = ControlDb::from_pool(pool);
        let mut u = user("rt@example.com");
        db.upsert_user(&u).await.unwrap();
        db.upsert_identity("test", "subj", u.id).await.unwrap();

        // Updating last_seen_at via upsert is in-place.
        u.last_seen_at = Some(Utc::now());
        db.upsert_user(&u).await.unwrap();

        let loaded = db.list_users().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].primary_email, "rt@example.com");
        assert!(loaded[0].last_seen_at.is_some());

        let identities = db.load_identities().await.unwrap();
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].user_id, u.id);
    }

    #[sqlx::test]
    async fn org_insert_rolls_back_when_membership_violates_constraint(pool: PgPool) {
        let db = ControlDb::from_pool(pool);
        let owner = user("owner@example.com");
        db.create_user_with_identity(&owner, &identity("owner"))
            .await
            .unwrap();

        // Owner membership references a non-existent user → FK violation aborts
        // the transaction, so the org must not be left behind.
        let o = org("gamma", Some(owner.id));
        let mut bad = membership(o.id, Uuid::new_v4());
        bad.user_id = Uuid::new_v4();
        let result = db.create_org_with_owner(&o, Some(&bad)).await;
        assert!(result.is_err());
        assert!(db.get_org(o.id).await.unwrap().is_none());
    }
}
