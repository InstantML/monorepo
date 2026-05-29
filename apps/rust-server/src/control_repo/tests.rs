//! Postgres-backed tests for the control repository. `#[sqlx::test]` provisions
//! a fresh isolated database per test and applies `./migrations` first.

use super::*;
use chrono::Utc;
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
