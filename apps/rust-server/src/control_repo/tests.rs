//! Postgres-backed tests for the control repository. `#[sqlx::test]` provisions
//! a fresh isolated database per test and applies `./migrations` first.

use super::*;
use crate::{domain::DataCellRow, store::TenantRouteRecord};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sqlx::PgPool;

fn db_time_now() -> DateTime<Utc> {
    postgres_timestamp(Utc::now())
}

fn postgres_timestamp(value: DateTime<Utc>) -> DateTime<Utc> {
    value - ChronoDuration::nanoseconds(i64::from(value.timestamp_subsec_nanos() % 1_000))
}

fn user(email: &str) -> UserRow {
    UserRow {
        id: Uuid::new_v4(),
        primary_email: email.to_string(),
        display_name: None,
        avatar_url: None,
        created_at: db_time_now(),
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
        created_at: db_time_now(),
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
        created_at: db_time_now(),
    }
}

fn data_cell(cell_id: &str, max_orgs: Option<i32>) -> DataCellRow {
    let now = db_time_now();
    DataCellRow {
        cell_id: cell_id.to_string(),
        environment: "test".to_string(),
        region: "us-central1".to_string(),
        tier: "free".to_string(),
        status: "open".to_string(),
        service_name: format!("instantml-data-{cell_id}"),
        public_api_base: Some(format!("https://{cell_id}.api.example.test")),
        internal_api_base: Some(format!("https://{cell_id}.internal.example.test")),
        clickhouse_endpoint_secret_ref: Some(format!("{cell_id}-endpoint")),
        clickhouse_username_secret_ref: Some(format!("{cell_id}-username")),
        clickhouse_password_secret_ref: Some(format!("{cell_id}-password")),
        clickhouse_database_mode: Some("shared-database".to_string()),
        max_orgs,
        max_metric_points_monthly: Some(10_000_000),
        max_api_requests_monthly: Some(1_000_000),
        max_retained_bytes: Some(1024 * 1024 * 1024),
        max_disk_usage_pct: Some(70),
        reserved_headroom_pct: Some(20),
        last_health_at: Some(now),
        last_backup_at: Some(now),
        notes: Some("operator note".to_string()),
        created_at: now,
        updated_at: now,
    }
}

fn writer_lease_acquire(cell_id: &str, holder: &str) -> DataCellWriterLeaseAcquire {
    DataCellWriterLeaseAcquire {
        cell_id: cell_id.to_string(),
        holder_instance_id: holder.to_string(),
        service_name: "instantml-data-test".to_string(),
        revision: "test-revision".to_string(),
        ttl: ChronoDuration::seconds(30),
    }
}

fn writer_lease_renewal(
    lease: &crate::domain::DataCellWriterLeaseRow,
) -> DataCellWriterLeaseRenewal {
    DataCellWriterLeaseRenewal {
        cell_id: lease.cell_id.clone(),
        holder_instance_id: lease.holder_instance_id.clone(),
        fence_token: lease.fence_token,
        ttl: ChronoDuration::seconds(30),
    }
}

fn route(org_id: Uuid, status: &str, endpoint: &str) -> TenantRouteRecord {
    let now = db_time_now();
    TenantRouteRecord {
        org_id,
        status: status.to_string(),
        provisioner: "database".to_string(),
        cell_id: None,
        route_version: 1,
        placement_reason: None,
        assigned_at: None,
        plan_tier: Some("free".to_string()),
        warehouse_kind: Some("shared".to_string()),
        requested_min_replica_memory_gb: Some(8),
        requested_max_replica_memory_gb: Some(8),
        requested_num_replicas: Some(1),
        applied_min_replica_memory_gb: Some(8),
        applied_max_replica_memory_gb: Some(8),
        applied_num_replicas: Some(1),
        endpoint: endpoint.to_string(),
        database: "instantml_shared".to_string(),
        username: "tenant".to_string(),
        password_secret_ref: Some("secret://tenant".to_string()),
        password_ciphertext: None,
        schema_version: Some(crate::metric_store::METRIC_SCHEMA_VERSION),
        service_id: None,
        created_at: now,
        updated_at: now,
        error: None,
    }
}

fn placement(cell_id: &str) -> TenantRoutePlacement {
    TenantRoutePlacement {
        environment: "test".to_string(),
        cell_id: cell_id.to_string(),
        actor: "test-operator".to_string(),
        reason: "current_data_cell".to_string(),
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
    u.last_seen_at = Some(db_time_now());
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

#[sqlx::test]
async fn data_cells_round_trip_with_capacity_and_secret_refs(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    let mut cell = data_cell("free-us-central1-a", Some(10));
    db.upsert_data_cell(&cell).await.unwrap();

    let loaded = db.load_data_cells().await.unwrap();
    assert_eq!(loaded, vec![cell.clone()]);

    cell.status = "draining".to_string();
    cell.max_orgs = Some(8);
    cell.updated_at = db_time_now();
    db.upsert_data_cell(&cell).await.unwrap();

    let loaded = db.load_data_cells().await.unwrap();
    assert_eq!(loaded, vec![cell]);
}

#[sqlx::test]
async fn data_cell_heartbeat_registers_missing_cell_and_preserves_operator_fields(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    let mut heartbeat = data_cell("free-us-central1-a", None);
    heartbeat.service_name = "auto-seeded".to_string();
    heartbeat.notes = Some("heartbeat".to_string());
    heartbeat.last_backup_at = Some(db_time_now());
    let registered = db.heartbeat_data_cell(&heartbeat).await.unwrap();
    assert_eq!(registered.cell_id, heartbeat.cell_id);
    assert_eq!(registered.service_name, "auto-seeded");
    assert_eq!(registered.last_backup_at, None);

    let mut operator_row = registered.clone();
    operator_row.status = "draining".to_string();
    operator_row.service_name = "operator-owned".to_string();
    operator_row.max_orgs = Some(5);
    operator_row.notes = Some("operator metadata".to_string());
    operator_row.last_backup_at = Some(db_time_now());
    db.upsert_data_cell(&operator_row).await.unwrap();

    heartbeat.updated_at = db_time_now() + ChronoDuration::seconds(1);
    heartbeat.last_health_at = Some(heartbeat.updated_at);
    heartbeat.last_backup_at = Some(heartbeat.updated_at);
    let refreshed = db.heartbeat_data_cell(&heartbeat).await.unwrap();
    assert_eq!(refreshed.status, "draining");
    assert_eq!(refreshed.service_name, "operator-owned");
    assert_eq!(refreshed.max_orgs, Some(5));
    assert_eq!(refreshed.notes.as_deref(), Some("operator metadata"));
    assert_eq!(refreshed.last_health_at, heartbeat.last_health_at);
    assert_eq!(refreshed.last_backup_at, operator_row.last_backup_at);
}

#[sqlx::test]
async fn data_cell_writer_lease_acquires_renews_and_releases_by_fence_token(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    db.upsert_data_cell(&data_cell("free-us-central1-a", None))
        .await
        .unwrap();

    let lease = db
        .acquire_data_cell_writer_lease(&writer_lease_acquire("free-us-central1-a", "holder-a"))
        .await
        .unwrap();
    assert_eq!(lease.cell_id, "free-us-central1-a");
    assert_eq!(lease.fence_token, 1);
    assert_eq!(lease.holder_instance_id, "holder-a");

    let renewed = db
        .renew_data_cell_writer_lease(&writer_lease_renewal(&lease))
        .await
        .unwrap();
    assert_eq!(renewed.fence_token, lease.fence_token);
    assert_eq!(renewed.holder_instance_id, lease.holder_instance_id);
    assert!(renewed.expires_at >= renewed.heartbeat_at);

    let released = db
        .release_data_cell_writer_lease(&DataCellWriterLeaseRelease {
            cell_id: renewed.cell_id.clone(),
            holder_instance_id: renewed.holder_instance_id.clone(),
            fence_token: renewed.fence_token,
        })
        .await
        .unwrap();
    assert_eq!(released.fence_token, renewed.fence_token);
    assert_eq!(released.holder_instance_id, renewed.holder_instance_id);

    let err = db
        .renew_data_cell_writer_lease(&writer_lease_renewal(&renewed))
        .await
        .unwrap_err();
    assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(err.safe_code(), "cell_writer_unavailable");
}

#[sqlx::test]
async fn concurrent_data_cell_writer_lease_acquire_allows_one_holder(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    db.upsert_data_cell(&data_cell("free-us-central1-a", None))
        .await
        .unwrap();

    let first_db = db.clone();
    let second_db = db.clone();
    let (first, second) = tokio::join!(
        async move {
            first_db
                .acquire_data_cell_writer_lease(&writer_lease_acquire(
                    "free-us-central1-a",
                    "holder-a",
                ))
                .await
        },
        async move {
            second_db
                .acquire_data_cell_writer_lease(&writer_lease_acquire(
                    "free-us-central1-a",
                    "holder-b",
                ))
                .await
        }
    );

    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let loser = first.err().or_else(|| second.err()).unwrap();
    assert_eq!(loser.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(loser.safe_code(), "cell_writer_unavailable");

    let stored = db
        .load_data_cell_writer_lease("free-us-central1-a")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.fence_token, 1);
    assert!(matches!(
        stored.holder_instance_id.as_str(),
        "holder-a" | "holder-b"
    ));
}

#[sqlx::test]
async fn expired_data_cell_writer_lease_takeover_increments_token(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    db.upsert_data_cell(&data_cell("free-us-central1-a", None))
        .await
        .unwrap();

    let first = db
        .acquire_data_cell_writer_lease(&writer_lease_acquire("free-us-central1-a", "holder-a"))
        .await
        .unwrap();
    sqlx::query(
        "UPDATE data_cell_writer_leases \
         SET heartbeat_at = clock_timestamp() - interval '2 seconds', \
             expires_at = clock_timestamp() - interval '1 second' \
         WHERE cell_id = $1",
    )
    .bind("free-us-central1-a")
    .execute(db.pool())
    .await
    .unwrap();

    let second = db
        .acquire_data_cell_writer_lease(&writer_lease_acquire("free-us-central1-a", "holder-b"))
        .await
        .unwrap();
    assert_eq!(second.fence_token, first.fence_token + 1);
    assert_eq!(second.holder_instance_id, "holder-b");

    let err = db
        .renew_data_cell_writer_lease(&writer_lease_renewal(&first))
        .await
        .unwrap_err();
    assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(err.safe_code(), "cell_writer_unavailable");
}

#[sqlx::test]
async fn data_cell_writer_lease_requires_registered_write_enabled_cell(pool: PgPool) {
    let db = ControlDb::from_pool(pool);

    let missing = db
        .acquire_data_cell_writer_lease(&writer_lease_acquire("missing-cell", "holder-a"))
        .await
        .unwrap_err();
    assert_eq!(
        missing.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(missing.safe_code(), "cell_writer_unavailable");

    for status in ["open", "full", "draining"] {
        let cell_id = format!("{status}-us-central1-a");
        let mut cell = data_cell(&cell_id, None);
        cell.status = status.to_string();
        db.upsert_data_cell(&cell).await.unwrap();
        let lease = db
            .acquire_data_cell_writer_lease(&writer_lease_acquire(&cell_id, "holder-a"))
            .await
            .unwrap();
        assert_eq!(lease.cell_id, cell_id);
    }

    for status in ["disabled", "failed"] {
        let cell_id = format!("{status}-us-central1-a");
        let mut cell = data_cell(&cell_id, None);
        cell.status = status.to_string();
        db.upsert_data_cell(&cell).await.unwrap();
        let err = db
            .acquire_data_cell_writer_lease(&writer_lease_acquire(&cell_id, "holder-a"))
            .await
            .unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.safe_code(), "cell_writer_unavailable");
    }
}

#[sqlx::test]
async fn data_cell_writer_lease_renewal_stops_when_cell_is_disabled(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    let mut cell = data_cell("free-us-central1-a", None);
    db.upsert_data_cell(&cell).await.unwrap();
    let lease = db
        .acquire_data_cell_writer_lease(&writer_lease_acquire("free-us-central1-a", "holder-a"))
        .await
        .unwrap();
    assert!(db
        .observe_data_cell_writer_lease(&DataCellWriterLeaseObservation {
            cell_id: lease.cell_id.clone(),
            holder_instance_id: lease.holder_instance_id.clone(),
            fence_token: lease.fence_token,
        })
        .await
        .unwrap()
        .is_some());

    cell.status = "disabled".to_string();
    cell.updated_at = db_time_now();
    db.upsert_data_cell(&cell).await.unwrap();

    let err = db
        .renew_data_cell_writer_lease(&writer_lease_renewal(&lease))
        .await
        .unwrap_err();
    assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(err.safe_code(), "cell_writer_unavailable");
    assert!(db
        .observe_data_cell_writer_lease(&DataCellWriterLeaseObservation {
            cell_id: lease.cell_id.clone(),
            holder_instance_id: lease.holder_instance_id.clone(),
            fence_token: lease.fence_token,
        })
        .await
        .unwrap()
        .is_none());
}

#[sqlx::test]
async fn tenant_route_without_placement_remains_backwards_compatible(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    let o = org("legacy-route", None);
    db.upsert_org(&o).await.unwrap();

    let stored = db
        .upsert_tenant_route(&route(o.id, "ready", "https://legacy.example.test"))
        .await
        .unwrap();
    assert_eq!(stored.cell_id, None);
    assert_eq!(stored.route_version, 1);
    assert_eq!(stored.placement_reason, None);
    assert_eq!(stored.assigned_at, None);

    let loaded = db.load_tenant_routes().await.unwrap();
    assert_eq!(loaded, vec![stored]);

    let events = db.load_tenant_route_events().await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].new_cell_id, None);
    assert_eq!(events[0].reason, "tenant_route_upsert");
}

#[sqlx::test]
async fn tenant_route_rejects_explicit_cell_assignment_without_placement(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    db.upsert_data_cell(&data_cell("free-us-central1-a", Some(2)))
        .await
        .unwrap();
    let o = org("explicit-cell", None);
    db.upsert_org(&o).await.unwrap();

    let mut explicit = route(o.id, "ready", "https://free-us-central1-a.example.test");
    explicit.cell_id = Some("free-us-central1-a".to_string());
    let err = db.upsert_tenant_route(&explicit).await.unwrap_err();
    assert_eq!(err.status(), axum::http::StatusCode::BAD_REQUEST);
    assert!(db.load_tenant_routes().await.unwrap().is_empty());
    assert!(db.load_tenant_route_events().await.unwrap().is_empty());
}

#[sqlx::test]
async fn tenant_route_placement_is_versioned_and_audited(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    db.upsert_data_cell(&data_cell("free-us-central1-a", Some(2)))
        .await
        .unwrap();
    let o = org("placed-route", None);
    db.upsert_org(&o).await.unwrap();

    let placed = db
        .upsert_tenant_route_with_placement(
            &route(
                o.id,
                "provisioning",
                "https://free-us-central1-a.example.test",
            ),
            Some(&placement("free-us-central1-a")),
        )
        .await
        .unwrap();
    assert_eq!(placed.cell_id.as_deref(), Some("free-us-central1-a"));
    assert_eq!(placed.route_version, 1);
    assert_eq!(
        placed.placement_reason.as_deref(),
        Some("current_data_cell")
    );
    assert!(placed.assigned_at.is_some());

    let mut ready = placed.clone();
    ready.status = "ready".to_string();
    ready.updated_at = db_time_now();
    let ready = db
        .upsert_tenant_route_with_placement(&ready, Some(&placement("free-us-central1-a")))
        .await
        .unwrap();
    assert_eq!(ready.cell_id.as_deref(), Some("free-us-central1-a"));
    assert_eq!(ready.route_version, 2);
    assert_eq!(ready.assigned_at, placed.assigned_at);

    let events = db.load_tenant_route_events().await.unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].old_cell_id, None);
    assert_eq!(events[0].new_cell_id.as_deref(), Some("free-us-central1-a"));
    assert_eq!(events[0].route_version, 1);
    assert_eq!(events[0].actor, "test-operator");
    assert_eq!(events[0].reason, "current_data_cell");
    assert_eq!(events[1].old_status.as_deref(), Some("provisioning"));
    assert_eq!(events[1].new_status, "ready");
    assert_eq!(events[1].route_version, 2);
}

#[sqlx::test]
async fn concurrent_initial_tenant_route_upserts_are_serialized(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    db.upsert_data_cell(&data_cell("free-us-central1-a", Some(2)))
        .await
        .unwrap();
    let o = org("concurrent-route", None);
    db.upsert_org(&o).await.unwrap();
    let org_id = o.id;

    let first_db = db.clone();
    let second_db = db.clone();
    let (first, second) = tokio::join!(
        async move {
            first_db
                .upsert_tenant_route_with_placement(
                    &route(org_id, "provisioning", "https://first.example.test"),
                    Some(&placement("free-us-central1-a")),
                )
                .await
        },
        async move {
            second_db
                .upsert_tenant_route_with_placement(
                    &route(org_id, "ready", "https://second.example.test"),
                    Some(&placement("free-us-central1-a")),
                )
                .await
        }
    );
    first.unwrap();
    second.unwrap();

    let routes = db.load_tenant_routes().await.unwrap();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].route_version, 2);
    assert_eq!(routes[0].cell_id.as_deref(), Some("free-us-central1-a"));
    let events = db.load_tenant_route_events().await.unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events
            .iter()
            .map(|event| event.route_version)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[sqlx::test]
async fn tenant_route_capacity_rejection_rolls_back_route_and_event(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    db.upsert_data_cell(&data_cell("free-us-central1-a", Some(1)))
        .await
        .unwrap();
    let first = org("first-org", None);
    let second = org("second-org", None);
    db.upsert_org(&first).await.unwrap();
    db.upsert_org(&second).await.unwrap();

    db.upsert_tenant_route_with_placement(
        &route(first.id, "ready", "https://free-us-central1-a.example.test"),
        Some(&placement("free-us-central1-a")),
    )
    .await
    .unwrap();

    let err = db
        .upsert_tenant_route_with_placement(
            &route(
                second.id,
                "provisioning",
                "https://free-us-central1-a.example.test",
            ),
            Some(&placement("free-us-central1-a")),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);

    let routes = db.load_tenant_routes().await.unwrap();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].org_id, first.id);
    let events = db.load_tenant_route_events().await.unwrap();
    assert_eq!(events.len(), 1);
}

#[sqlx::test]
async fn tenant_route_placement_requires_registered_cell(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    let o = org("missing-cell", None);
    db.upsert_org(&o).await.unwrap();

    let err = db
        .upsert_tenant_route_with_placement(
            &route(o.id, "ready", "https://free-us-central1-a.example.test"),
            Some(&placement("free-us-central1-a")),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    assert!(db.load_tenant_routes().await.unwrap().is_empty());
    assert!(db.load_tenant_route_events().await.unwrap().is_empty());
}

#[sqlx::test]
async fn customer_clickhouse_routes_are_not_assigned_to_managed_cells(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    let o = org("customer-clickhouse", None);
    db.upsert_org(&o).await.unwrap();

    let mut customer_route = route(o.id, "ready", "https://customer-clickhouse.example.test");
    customer_route.provisioner = "customer-clickhouse".to_string();
    customer_route.warehouse_kind = Some("customer-owned".to_string());
    let stored = db
        .upsert_tenant_route_with_placement(&customer_route, Some(&placement("free-us-central1-a")))
        .await
        .unwrap();
    assert_eq!(stored.cell_id, None);
    assert_eq!(stored.placement_reason, None);
}

#[sqlx::test]
async fn stale_cell_health_blocks_placement(pool: PgPool) {
    let db = ControlDb::from_pool(pool);
    let mut cell = data_cell("free-us-central1-a", Some(1));
    cell.last_health_at =
        Some(db_time_now() - ChronoDuration::seconds(DATA_CELL_HEALTH_MAX_AGE_SECS + 1));
    db.upsert_data_cell(&cell).await.unwrap();
    let o = org("stale-cell", None);
    db.upsert_org(&o).await.unwrap();

    let err = db
        .upsert_tenant_route_with_placement(
            &route(o.id, "ready", "https://free-us-central1-a.example.test"),
            Some(&placement("free-us-central1-a")),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    assert!(db.load_tenant_routes().await.unwrap().is_empty());
    assert!(db.load_tenant_route_events().await.unwrap().is_empty());
}

#[sqlx::test]
async fn placement_ignores_missing_or_stale_backup(pool: PgPool) {
    // Backups are owned outside the app (e.g. disk snapshots), so placement no
    // longer gates on backup evidence: a cell with a null backup is eligible.
    let db = ControlDb::from_pool(pool);
    let mut cell = data_cell("free-us-central1-a", Some(1));
    cell.last_backup_at = None;
    db.upsert_data_cell(&cell).await.unwrap();
    let o = org("null-backup-cell", None);
    db.upsert_org(&o).await.unwrap();

    let stored = db
        .upsert_tenant_route_with_placement(
            &route(o.id, "ready", "https://free-us-central1-a.example.test"),
            Some(&placement("free-us-central1-a")),
        )
        .await
        .unwrap();
    assert_eq!(stored.cell_id.as_deref(), Some("free-us-central1-a"));
    assert_eq!(db.load_tenant_routes().await.unwrap().len(), 1);
}
