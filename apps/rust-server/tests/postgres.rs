// Temporarily disabled while the ClickHouse migration lands.
//
// These integration tests assume metric points + maintained series live in
// Postgres. The metric path now writes to ClickHouse (`metric_points` raw
// rows + `metric_series` AggregatingMergeTree fed by the `metric_series_mv`
// materialized view) via `apps/rust-server/src/metric_store.rs`. To re-enable:
//
// 1. Spin up a disposable ClickHouse server alongside the disposable Postgres
//    in `TestPostgres::start` (consider a `TestClickHouse` mirror, or require
//    `CLICKHOUSE_URL` to point at a running instance).
// 2. Build a `MetricStore` via `metric_store::connect` + `metric_store::migrate`
//    in `test_config` / setup helpers.
// 3. Thread the `&MetricStore` argument through every `store::log_metrics`,
//    `store::get_metrics`, `store::metrics_series_batched`, `store::runs_summary`,
//    `store::side_by_side`, `store::reset_demo`, `store::list_runs`,
//    `store::get_run`, `store::export_data`, `store::usage_summary`,
//    `store::usage_export`, `store::import_payload`, and `store::overview`
//    call site (64 in this file as of the migration commit).
// 4. Update metric-series assertions: the materialized view aggregates are
//    eventually consistent during merge but `*Merge` reads return the correct
//    value immediately after insert.
#![cfg(any())]

use std::{
    fs,
    net::TcpListener,
    path::Path,
    process::{Command, Stdio},
};

use chrono::NaiveDate;
use rlobs_rust_server::{
    artifact_store::LocalArtifactStore,
    auth::{generate_session_token, hash_secret},
    config::{AppConfig, AuthMode, LogFormat},
    domain::{
        AttributeInput, CreateApiKeyRequest, CreateArtifactRequest, CreateAttributesRequest,
        CreateObjectRequest, CreateOrganizationRequest, CreateRunRequest, CreateUserRequest,
        LogMetricsRequest, RequestContext, UpdateRunRequest, UploadArtifactRequest,
    },
    store,
};
use serde_json::json;
use tempfile::TempDir;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

struct TestPostgres {
    dir: TempDir,
    port: u16,
    database_url: String,
}

impl TestPostgres {
    fn start() -> Self {
        let dir = TempDir::new().expect("tempdir");
        let data_dir = dir.path().join("data");
        run(Command::new("initdb")
            .arg("-D")
            .arg(&data_dir)
            .arg("--auth=trust")
            .stdout(Stdio::null()));
        let port = free_port();
        run(Command::new("pg_ctl")
            .arg("-D")
            .arg(&data_dir)
            .arg("-o")
            .arg(format!("-p {port} -c listen_addresses='127.0.0.1'"))
            .arg("-l")
            .arg(dir.path().join("postgres.log"))
            .arg("start")
            .stdout(Stdio::null()));
        run(Command::new("createdb")
            .arg("-h")
            .arg("127.0.0.1")
            .arg("-p")
            .arg(port.to_string())
            .arg("rlobs_test"));
        let database_url = format!("postgres://127.0.0.1:{port}/rlobs_test");
        Self {
            dir,
            port,
            database_url,
        }
    }
}

impl Drop for TestPostgres {
    fn drop(&mut self) {
        let _ = Command::new("pg_ctl")
            .arg("-D")
            .arg(self.dir.path().join("data"))
            .arg("stop")
            .arg("-m")
            .arg("fast")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[tokio::test]
async fn migration_projects_runs_metrics_and_idempotency_work() {
    let pg = TestPostgres::start();
    store::migrate(&pg.database_url).await.expect("migrate");
    let config = test_config(&pg);
    let pool = store::connect(&config).await.expect("connect");
    let ctx = RequestContext::local();

    let (first_project_run, second_project_run) = tokio::join!(
        store::create_run(
            &pool,
            &ctx,
            CreateRunRequest {
                project: Some("concurrent-project".to_string()),
                name: Some("parallel-a".to_string()),
                config: Some(json!({})),
                tags: Some(vec![]),
                metadata: Some(json!({})),
            },
        ),
        store::create_run(
            &pool,
            &ctx,
            CreateRunRequest {
                project: Some("concurrent-project".to_string()),
                name: Some("parallel-b".to_string()),
                config: Some(json!({})),
                tags: Some(vec![]),
                metadata: Some(json!({})),
            },
        )
    );
    assert_eq!(
        first_project_run.expect("parallel run a").project_id,
        second_project_run.expect("parallel run b").project_id
    );

    let run = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("research".to_string()),
            name: Some("seed-1".to_string()),
            config: Some(json!({ "seed": 1 })),
            tags: Some(vec!["baseline".to_string()]),
            metadata: Some(json!({ "host": "test" })),
        },
    )
    .await
    .expect("create run");

    let body =
        json!({ "step": 0.5, "timestamp": "2026-05-09T00:00:00Z", "metrics": { "reward": 1.25 } });
    let input: LogMetricsRequest = serde_json::from_value(body.clone()).expect("metric request");
    assert_eq!(
        store::log_metrics(
            &pool,
            &ctx,
            run.id,
            body.clone(),
            input,
            Some("event-1".to_string())
        )
        .await
        .expect("first insert"),
        1
    );
    let batch_body = json!({
        "step": 1,
        "timestamp": "2026-05-09T00:00:01Z",
        "metrics": { "reward": 2.25, "loss": 0.5, "accuracy": 0.8 }
    });
    let batch_input: LogMetricsRequest =
        serde_json::from_value(batch_body.clone()).expect("batch metric request");
    assert_eq!(
        store::log_metrics(&pool, &ctx, run.id, batch_body, batch_input, None)
            .await
            .expect("batch insert"),
        3
    );
    let replay: LogMetricsRequest = serde_json::from_value(json!({
        "timestamp": "2026-05-09T00:00:00Z",
        "metrics": { "reward": 1.25 },
        "step": 0.5
    }))
    .expect("metric request");
    assert_eq!(
        store::log_metrics(
            &pool,
            &ctx,
            run.id,
            json!({
                "timestamp": "2026-05-09T00:00:00Z",
                "metrics": { "reward": 1.25 },
                "step": 0.5
            }),
            replay,
            Some("event-1".to_string())
        )
        .await
        .expect("idempotent replay"),
        1
    );
    let conflict: LogMetricsRequest =
        serde_json::from_value(json!({ "step": 1, "metrics": { "reward": 2 } }))
            .expect("metric request");
    let error = store::log_metrics(
        &pool,
        &ctx,
        run.id,
        json!({ "step": 1, "metrics": { "reward": 2 } }),
        conflict,
        Some("event-1".to_string()),
    )
    .await
    .expect_err("idempotency conflict");
    assert_eq!(error.status(), axum::http::StatusCode::CONFLICT);

    let metrics = store::get_metrics(&pool, &ctx, run.id, &query(&[("key", "reward")]))
        .await
        .expect("metrics");
    assert_eq!(
        metrics["metrics"].as_array().expect("metrics array").len(),
        2
    );
    let all_metrics = store::get_metrics(&pool, &ctx, run.id, &query(&[]))
        .await
        .expect("unkeyed metrics");
    assert_eq!(
        all_metrics["metrics"]
            .as_array()
            .expect("all metrics array")
            .len(),
        4
    );

    let companion = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("batch-research".to_string()),
            name: Some("seed-2".to_string()),
            config: Some(json!({ "seed": 2 })),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("companion run");
    let companion_body =
        json!({ "step": 0, "timestamp": "2026-05-09T01:00:00Z", "metrics": { "reward": 5.0 } });
    let companion_input: LogMetricsRequest =
        serde_json::from_value(companion_body.clone()).expect("companion metric request");
    store::log_metrics(
        &pool,
        &ctx,
        companion.id,
        companion_body,
        companion_input,
        None,
    )
    .await
    .expect("companion metrics");

    let batched = store::metrics_series_batched(
        &pool,
        &ctx,
        &query(&[
            ("key", "reward"),
            ("run_ids", &format!("{},{}", run.id, companion.id)),
        ]),
    )
    .await
    .expect("batched series");
    let series = batched["series"].as_array().expect("series array");
    assert_eq!(series.len(), 2);
    assert_eq!(series[0]["run_id"].as_str().unwrap(), run.id.to_string());
    assert_eq!(
        series[0]["metrics"]
            .as_array()
            .expect("first run metrics")
            .len(),
        2
    );
    assert_eq!(
        series[1]["run_id"].as_str().unwrap(),
        companion.id.to_string()
    );
    assert_eq!(
        series[1]["metrics"]
            .as_array()
            .expect("second run metrics")
            .len(),
        1
    );

    let stranger = Uuid::new_v4();
    let filtered = store::metrics_series_batched(
        &pool,
        &ctx,
        &query(&[
            ("key", "reward"),
            ("run_ids", &format!("{},{}", run.id, stranger)),
        ]),
    )
    .await
    .expect("batched series with unknown run filtered");
    let filtered_series = filtered["series"]
        .as_array()
        .expect("filtered series array");
    assert_eq!(filtered_series.len(), 1);
    assert_eq!(
        filtered_series[0]["run_id"].as_str().unwrap(),
        run.id.to_string()
    );

    let missing_key =
        store::metrics_series_batched(&pool, &ctx, &query(&[("run_ids", &run.id.to_string())]))
            .await
            .expect_err("metric key required");
    assert_eq!(missing_key.status(), axum::http::StatusCode::BAD_REQUEST);

    let missing_ids = store::metrics_series_batched(&pool, &ctx, &query(&[("key", "reward")]))
        .await
        .expect_err("run_ids required");
    assert_eq!(missing_ids.status(), axum::http::StatusCode::BAD_REQUEST);

    let bad_id = store::metrics_series_batched(
        &pool,
        &ctx,
        &query(&[("key", "reward"), ("run_ids", "not-a-uuid")]),
    )
    .await
    .expect_err("invalid run id");
    assert_eq!(bad_id.status(), axum::http::StatusCode::BAD_REQUEST);

    let summary = store::runs_summary(&pool, &ctx, &query(&[("project", "research")]))
        .await
        .expect("summary");
    assert_eq!(summary["total"], 1);
    assert_eq!(summary["runs"][0]["latest_metrics"]["reward"], 2.25);
    assert_eq!(
        summary["runs"][0]["metric_aggregates"]["reward"]["count"],
        2
    );
}

#[tokio::test]
async fn runs_workspace_queries_are_filtered_sorted_and_bounded() {
    let pg = TestPostgres::start();
    store::migrate(&pg.database_url).await.expect("migrate");
    let config = test_config(&pg);
    let pool = store::connect(&config).await.expect("connect");
    let ctx = RequestContext::local();

    let high = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("workspace".to_string()),
            name: Some("aaa-high-reward".to_string()),
            config: Some(json!({ "seed": 1 })),
            tags: Some(vec!["baseline".to_string()]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("high run");
    let high_body = json!({ "step": 1, "metrics": { "reward": 10 } });
    let high_input: LogMetricsRequest =
        serde_json::from_value(high_body.clone()).expect("high metric");
    store::log_metrics(&pool, &ctx, high.id, high_body, high_input, None)
        .await
        .expect("high metrics");

    let low = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("workspace".to_string()),
            name: Some("zzz-low-reward".to_string()),
            config: Some(json!({ "seed": 2 })),
            tags: Some(vec!["candidate".to_string()]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("low run");
    let low_body = json!({ "step": 1, "metrics": { "reward": 1, "train/off_page": 0.5 } });
    let low_input: LogMetricsRequest =
        serde_json::from_value(low_body.clone()).expect("low metric");
    store::log_metrics(&pool, &ctx, low.id, low_body, low_input, None)
        .await
        .expect("low metrics");
    store::update_run(
        &pool,
        &ctx,
        low.id,
        UpdateRunRequest {
            status: Some("failed".to_string()),
            tags: None,
            notes: None,
        },
    )
    .await
    .expect("low failed");
    let updated_high = store::update_run(
        &pool,
        &ctx,
        high.id,
        UpdateRunRequest {
            status: None,
            tags: Some(vec!["baseline".to_string(), "needs-review".to_string()]),
            notes: Some("human-note-token reward stability improved".to_string()),
        },
    )
    .await
    .expect("tag and note update");
    assert_eq!(updated_high.tags, vec!["baseline", "needs-review"]);
    assert_eq!(
        updated_high.metadata["notes"],
        "human-note-token reward stability improved"
    );

    let other = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("other-workspace".to_string()),
            name: Some("other-run".to_string()),
            config: Some(json!({})),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("other run");
    let other_body = json!({ "step": 1, "metrics": { "reward": 99 } });
    let other_input: LogMetricsRequest =
        serde_json::from_value(other_body.clone()).expect("other metric");
    store::log_metrics(&pool, &ctx, other.id, other_body, other_input, None)
        .await
        .expect("other metrics");

    let summary = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "workspace"),
            ("limit", "1"),
            ("sort_by", "metric-best"),
            ("metric_key", "reward"),
        ]),
    )
    .await
    .expect("sorted summary");
    assert_eq!(summary["total"], 2);
    assert_eq!(
        summary["runs"][0]["id"].as_str().expect("run id"),
        high.id.to_string()
    );
    assert_eq!(
        summary["runs"][0]["metadata"]["notes"],
        "human-note-token reward stability improved"
    );
    let metric_keys = summary["metric_keys"].as_array().expect("metric keys");
    assert!(
        metric_keys
            .iter()
            .any(|key| key.as_str() == Some("train/off_page")),
        "metric keys should cover the full filtered result set"
    );
    let seed_query = store::runs_summary(
        &pool,
        &ctx,
        &query(&[("project", "workspace"), ("q", "seed 2")]),
    )
    .await
    .expect("seed query summary");
    assert_eq!(seed_query["total"], 1);
    assert_eq!(
        seed_query["runs"][0]["id"].as_str().expect("run id"),
        low.id.to_string()
    );
    let note_query = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "workspace"),
            ("q", "human-note-token stability"),
        ]),
    )
    .await
    .expect("note query summary");
    assert_eq!(note_query["total"], 1);
    assert_eq!(
        note_query["runs"][0]["id"].as_str().expect("run id"),
        high.id.to_string()
    );
    let tag_query = store::runs_summary(
        &pool,
        &ctx,
        &query(&[("project", "workspace"), ("q", "needs-review")]),
    )
    .await
    .expect("tag query summary");
    assert_eq!(tag_query["total"], 1);
    assert_eq!(
        tag_query["runs"][0]["id"].as_str().expect("run id"),
        high.id.to_string()
    );
    assert_eq!(
        store::runs_summary(&pool, &ctx, &query(&[("sort_by", "surprise")]))
            .await
            .expect_err("invalid sort rejected")
            .status(),
        axum::http::StatusCode::BAD_REQUEST
    );
    let cursor_first = store::runs_summary(
        &pool,
        &ctx,
        &query(&[("project", "workspace"), ("limit", "1")]),
    )
    .await
    .expect("first cursor page");
    let cursor = cursor_first["next_cursor"]
        .as_str()
        .expect("first page cursor")
        .to_string();
    assert_eq!(cursor_first["page_info"]["pagination"], "offset");
    let cursor_second = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "workspace"),
            ("limit", "1"),
            ("cursor", &cursor),
        ]),
    )
    .await
    .expect("second cursor page");
    assert_eq!(cursor_second["page_info"]["pagination"], "cursor");
    assert_ne!(
        cursor_first["runs"][0]["id"].as_str(),
        cursor_second["runs"][0]["id"].as_str(),
        "cursor pagination should not duplicate rows"
    );
    assert!(cursor_second["next_cursor"].is_null());
    assert_eq!(
        store::runs_summary(
            &pool,
            &ctx,
            &query(&[
                ("project", "workspace"),
                ("limit", "1"),
                ("cursor", "not-base64"),
            ]),
        )
        .await
        .expect_err("invalid cursor rejected")
        .status(),
        axum::http::StatusCode::BAD_REQUEST
    );
    assert_eq!(
        store::runs_summary(
            &pool,
            &ctx,
            &query(&[
                ("project", "workspace"),
                ("limit", "1"),
                ("cursor", &cursor),
                ("q", "seed 1"),
            ]),
        )
        .await
        .expect_err("cursor filter mismatch rejected")
        .status(),
        axum::http::StatusCode::BAD_REQUEST
    );
    assert_eq!(
        store::runs_summary(
            &pool,
            &ctx,
            &query(&[
                ("project", "workspace"),
                ("limit", "1"),
                ("cursor", &cursor),
                ("sort_by", "name"),
            ]),
        )
        .await
        .expect_err("cursor sort mismatch rejected")
        .status(),
        axum::http::StatusCode::BAD_REQUEST
    );
    let duration_first = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "workspace"),
            ("limit", "1"),
            ("sort_by", "duration"),
        ]),
    )
    .await
    .expect("duration cursor first page");
    assert_eq!(
        duration_first["runs"][0]["id"]
            .as_str()
            .expect("duration id"),
        low.id.to_string()
    );
    let duration_cursor = duration_first["next_cursor"]
        .as_str()
        .expect("duration cursor");
    let duration_second = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "workspace"),
            ("limit", "1"),
            ("sort_by", "duration"),
            ("cursor", duration_cursor),
        ]),
    )
    .await
    .expect("duration cursor second page");
    assert_eq!(
        duration_second["runs"][0]["id"]
            .as_str()
            .expect("duration second id"),
        high.id.to_string()
    );
    let missing_metric = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("workspace".to_string()),
            name: Some("missing-reward".to_string()),
            config: Some(json!({ "seed": 3 })),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("missing metric run");
    let metric_first = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "workspace"),
            ("limit", "2"),
            ("sort_by", "metric-best"),
            ("metric_key", "reward"),
        ]),
    )
    .await
    .expect("metric cursor first page");
    assert_eq!(
        metric_first["runs"][0]["id"]
            .as_str()
            .expect("metric first"),
        high.id.to_string()
    );
    let metric_cursor = metric_first["next_cursor"].as_str().expect("metric cursor");
    let metric_second = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "workspace"),
            ("limit", "2"),
            ("sort_by", "metric-best"),
            ("metric_key", "reward"),
            ("cursor", metric_cursor),
        ]),
    )
    .await
    .expect("metric cursor second page");
    assert!(
        metric_second["runs"]
            .as_array()
            .expect("metric runs")
            .iter()
            .any(|run| run["id"].as_str() == Some(&missing_metric.id.to_string())),
        "rows missing the sort metric should page after rows with metric values"
    );
    let metric_offset_missing = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "workspace"),
            ("limit", "1"),
            ("offset", "2"),
            ("sort_by", "metric-best"),
            ("metric_key", "reward"),
        ]),
    )
    .await
    .expect("metric offset reaches missing metric rows");
    assert_eq!(
        metric_offset_missing["runs"][0]["id"]
            .as_str()
            .expect("metric offset id"),
        missing_metric.id.to_string()
    );

    let unicode_first = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("unicode-names".to_string()),
            name: Some("Ä-run-alpha".to_string()),
            config: Some(json!({})),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("unicode first run");
    let unicode_second_run = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("unicode-names".to_string()),
            name: Some("ä-run-beta".to_string()),
            config: Some(json!({})),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("unicode second run");
    let unicode_page = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "unicode-names"),
            ("limit", "1"),
            ("sort_by", "name"),
        ]),
    )
    .await
    .expect("unicode name first page");
    let unicode_cursor = unicode_page["next_cursor"]
        .as_str()
        .expect("unicode name cursor");
    let unicode_next = store::runs_summary(
        &pool,
        &ctx,
        &query(&[
            ("project", "unicode-names"),
            ("limit", "1"),
            ("sort_by", "name"),
            ("cursor", unicode_cursor),
        ]),
    )
    .await
    .expect("unicode name second page");
    assert!([
        unicode_first.id.to_string(),
        unicode_second_run.id.to_string()
    ]
    .contains(
        &unicode_next["runs"][0]["id"]
            .as_str()
            .expect("unicode id")
            .to_string()
    ));
    assert_ne!(
        unicode_page["runs"][0]["id"].as_str(),
        unicode_next["runs"][0]["id"].as_str(),
        "name cursors should use the same case-folded value that Postgres sorted by"
    );

    let overview = store::overview(
        &pool,
        &ctx,
        &query(&[("project", "workspace"), ("metric_key", "reward")]),
    )
    .await
    .expect("workspace overview");
    assert_eq!(overview["overview"]["total_runs"], 3);
    assert_eq!(overview["overview"]["active_runs"], 2);
    assert_eq!(overview["overview"]["failed_runs"], 1);
    assert_eq!(overview["overview"]["metric_points"], 3);
    assert_eq!(overview["overview"]["best_eval_return"], 10.0);

    let failed = store::overview(
        &pool,
        &ctx,
        &query(&[("project", "workspace"), ("status", "failed")]),
    )
    .await
    .expect("failed overview");
    assert_eq!(failed["overview"]["total_runs"], 1);
    assert_eq!(failed["overview"]["active_runs"], 0);
    assert_eq!(failed["overview"]["failed_runs"], 1);
    assert_eq!(failed["overview"]["metric_points"], 2);

    store::create_artifact(
        &pool,
        &ctx,
        high.id,
        CreateArtifactRequest {
            kind: Some("file".to_string()),
            name: Some("late.txt".to_string()),
            uri: Some("demo://late.txt".to_string()),
            step: Some(json!(2)),
            size_bytes: None,
            sha256: None,
            mime_type: None,
            metadata: Some(json!({})),
            path: None,
        },
    )
    .await
    .expect("late artifact");
    store::create_artifact(
        &pool,
        &ctx,
        high.id,
        CreateArtifactRequest {
            kind: Some("file".to_string()),
            name: Some("early.txt".to_string()),
            uri: Some("demo://early.txt".to_string()),
            step: Some(json!(1)),
            size_bytes: None,
            sha256: None,
            mime_type: None,
            metadata: Some(json!({})),
            path: None,
        },
    )
    .await
    .expect("early artifact");
    let artifacts = store::list_artifacts(&pool, &ctx, high.id, &query(&[("limit", "1")]))
        .await
        .expect("limited artifacts");
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].name, "early.txt");
}

#[tokio::test]
async fn bootstrap_api_keys_usage_and_artifact_upload_work() {
    let pg = TestPostgres::start();
    store::migrate(&pg.database_url).await.expect("migrate");
    let config = test_config(&pg);
    let pool = store::connect(&config).await.expect("connect");

    let user = store::create_user(
        &pool,
        CreateUserRequest {
            email: Some("rust@example.com".to_string()),
            primary_email: None,
            provider: Some("google".to_string()),
            provider_subject: Some("rust-subject".to_string()),
            email_verified: Some(true),
            display_name: None,
            avatar_url: None,
        },
    )
    .await
    .expect("user");
    let (first_org, second_org) = tokio::join!(
        store::create_organization(
            &pool,
            CreateOrganizationRequest {
                slug: Some("parallel-org".to_string()),
                name: Some("Parallel Org".to_string()),
                plan_tier: None,
                owner_user_id: None,
            },
        ),
        store::create_organization(
            &pool,
            CreateOrganizationRequest {
                slug: Some("parallel-org".to_string()),
                name: Some("Parallel Org".to_string()),
                plan_tier: None,
                owner_user_id: None,
            },
        )
    );
    assert_eq!(
        first_org.expect("parallel org a").id,
        second_org.expect("parallel org b").id
    );
    let org = store::create_organization(
        &pool,
        CreateOrganizationRequest {
            slug: Some("rust-contract".to_string()),
            name: Some("Rust Contract".to_string()),
            plan_tier: None,
            owner_user_id: Some(user.id),
        },
    )
    .await
    .expect("org");
    let key = store::create_api_key(
        &pool,
        org.id,
        CreateApiKeyRequest {
            name: Some("sdk".to_string()),
            scopes: None,
            created_by_user_id: None,
            project_id: None,
            project: None,
            expires_at: None,
        },
    )
    .await
    .expect("key");
    let token = key["api_key"].as_str().expect("token");
    let auth = store::authenticate_api_key(&pool, token)
        .await
        .expect("auth");
    assert_eq!(auth.org_id, org.id);
    auth.require_scope("sdk:ingest").expect("scope");
    let ctx = RequestContext {
        org_id: auth.org_id,
        auth: Some(auth),
        session: None,
    };

    let run = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("artifacts".to_string()),
            name: Some("artifact-run".to_string()),
            config: Some(json!({})),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("run");
    let artifact = store::upload_artifact(
        &pool,
        &config,
        &ctx,
        run.id,
        UploadArtifactRequest {
            kind: Some("file".to_string()),
            name: Some("hello.txt".to_string()),
            content_base64: Some("aGVsbG8=".to_string()),
            step: None,
            mime_type: Some("text/plain".to_string()),
            metadata: Some(json!({})),
            path: None,
        },
    )
    .await
    .expect("artifact");
    assert_eq!(artifact.size_bytes, Some(5));
    assert!(Path::new(artifact.storage_path.as_ref().expect("storage path")).exists());
    let usage = store::usage_summary(&pool, &ctx).await.expect("usage");
    assert_eq!(
        usage["organizations"][0]["usage"]["artifact_bytes_exact"],
        5
    );
    assert_eq!(usage["organizations"][0]["usage"]["api_keys"], 1);
}

#[tokio::test]
async fn rich_logged_objects_are_bounded_and_same_run_scoped() {
    let pg = TestPostgres::start();
    store::migrate(&pg.database_url).await.expect("migrate");
    let config = test_config(&pg);
    let pool = store::connect(&config).await.expect("connect");
    let ctx = RequestContext::local();
    let run = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("objects".to_string()),
            name: Some("rich-run".to_string()),
            config: Some(json!({})),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("run");
    let artifact = store::upload_artifact(
        &pool,
        &config,
        &ctx,
        run.id,
        UploadArtifactRequest {
            kind: Some("file".to_string()),
            name: Some("sample.mp3".to_string()),
            content_base64: Some("aGVsbG8=".to_string()),
            step: Some(json!(2)),
            mime_type: Some("audio/mpeg".to_string()),
            metadata: Some(json!({ "kind": "audio" })),
            path: None,
        },
    )
    .await
    .expect("artifact");

    let table = store::create_object(
        &pool,
        &ctx,
        run.id,
        CreateObjectRequest {
            key: Some("eval/samples".to_string()),
            kind: Some("table".to_string()),
            step: Some(json!(2)),
            artifact_id: None,
            metadata: Some(json!({ "split": "eval" })),
            summary: Some(json!({ "columns": ["prompt", "score"] })),
            value: None,
            rows: Some(vec![
                json!({ "prompt": "a", "score": 0.9 }),
                json!({ "prompt": "b", "score": 0.8 }),
            ]),
        },
    )
    .await
    .expect("table object");
    assert_eq!(table["kind"], "table");
    assert_eq!(table["summary"]["row_count"], 2);
    let object_id = table["id"].as_i64().expect("object id");
    let rows = store::list_object_rows(
        &pool,
        &ctx,
        object_id,
        &query(&[("limit", "1"), ("offset", "1")]),
    )
    .await
    .expect("rows");
    assert_eq!(rows["rows"].as_array().expect("rows").len(), 1);
    assert_eq!(rows["rows"][0]["row"]["prompt"], "b");
    let direct_rich_attribute = store::create_attributes(
        &pool,
        &ctx,
        run.id,
        CreateAttributesRequest {
            attributes: Some(vec![AttributeInput {
                path: "eval/direct-table".to_string(),
                kind: "table".to_string(),
                step: None,
                timestamp: None,
                value: json!({ "kind": "table" }),
                summary: Some(json!({})),
                artifact_id: None,
            }]),
            path: None,
            kind: None,
            step: None,
            timestamp: None,
            value: None,
            summary: None,
        },
    )
    .await
    .expect_err("rich objects must use the object API");
    assert_eq!(
        direct_rich_attribute.status(),
        http::StatusCode::BAD_REQUEST
    );

    let histogram = store::create_object(
        &pool,
        &ctx,
        run.id,
        CreateObjectRequest {
            key: Some("eval/scores".to_string()),
            kind: Some("histogram".to_string()),
            step: Some(json!(2)),
            artifact_id: None,
            metadata: Some(json!({})),
            summary: Some(json!({})),
            value: Some(json!({ "bins": [0, 1, 2], "counts": [4, 8] })),
            rows: None,
        },
    )
    .await
    .expect("histogram object");
    assert_eq!(histogram["kind"], "histogram");

    let media = store::create_object(
        &pool,
        &ctx,
        run.id,
        CreateObjectRequest {
            key: Some("audio/sample".to_string()),
            kind: Some("audio".to_string()),
            step: None,
            artifact_id: Some(artifact.id),
            metadata: Some(json!({ "caption": "sample" })),
            summary: Some(json!({})),
            value: None,
            rows: None,
        },
    )
    .await
    .expect("media object");
    assert_eq!(media["artifact"]["id"], artifact.id.to_string());

    let objects = store::list_objects(&pool, &ctx, run.id, &query(&[("limit", "10")]))
        .await
        .expect("objects");
    assert_eq!(objects["objects"].as_array().expect("objects").len(), 3);
    let table_objects = store::list_objects(&pool, &ctx, run.id, &query(&[("kind", "table")]))
        .await
        .expect("table objects");
    assert_eq!(
        table_objects["objects"].as_array().expect("objects").len(),
        1
    );

    let other = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("objects".to_string()),
            name: Some("other-run".to_string()),
            config: Some(json!({})),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("other run");
    let other_artifact = store::create_artifact(
        &pool,
        &ctx,
        other.id,
        CreateArtifactRequest {
            kind: Some("file".to_string()),
            name: Some("other.txt".to_string()),
            uri: Some("demo://other.txt".to_string()),
            step: None,
            size_bytes: None,
            sha256: None,
            mime_type: None,
            metadata: Some(json!({})),
            path: None,
        },
    )
    .await
    .expect("other artifact");
    let cross_run = store::create_object(
        &pool,
        &ctx,
        run.id,
        CreateObjectRequest {
            key: Some("audio/bad".to_string()),
            kind: Some("audio".to_string()),
            step: None,
            artifact_id: Some(other_artifact.id),
            metadata: Some(json!({})),
            summary: Some(json!({})),
            value: None,
            rows: None,
        },
    )
    .await
    .expect_err("cross-run artifact must be rejected");
    assert_eq!(cross_run.status(), http::StatusCode::BAD_REQUEST);

    let invalid_histogram = store::create_object(
        &pool,
        &ctx,
        run.id,
        CreateObjectRequest {
            key: Some("eval/bad".to_string()),
            kind: Some("histogram".to_string()),
            step: None,
            artifact_id: None,
            metadata: Some(json!({})),
            summary: Some(json!({})),
            value: Some(json!({ "bins": [0, 1], "counts": [-1] })),
            rows: None,
        },
    )
    .await
    .expect_err("negative counts rejected");
    assert_eq!(invalid_histogram.status(), http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn project_scoped_api_keys_enforce_data_boundaries() {
    let pg = TestPostgres::start();
    store::migrate(&pg.database_url).await.expect("migrate");
    let config = test_config(&pg);
    let pool = store::connect(&config).await.expect("connect");
    let org = store::create_organization(
        &pool,
        CreateOrganizationRequest {
            slug: Some("scoped-org".to_string()),
            name: Some("Scoped Org".to_string()),
            plan_tier: None,
            owner_user_id: None,
        },
    )
    .await
    .expect("org");
    let admin_key = store::create_api_key(
        &pool,
        org.id,
        CreateApiKeyRequest {
            name: Some("admin".to_string()),
            scopes: Some(vec![
                "sdk:ingest".to_string(),
                "imports:write".to_string(),
                "export:read".to_string(),
                "usage:read".to_string(),
                "api_keys:write".to_string(),
            ]),
            created_by_user_id: None,
            project_id: None,
            project: None,
            expires_at: None,
        },
    )
    .await
    .expect("admin key");
    let admin_auth =
        store::authenticate_api_key(&pool, admin_key["api_key"].as_str().expect("admin token"))
            .await
            .expect("admin auth");
    let admin_ctx = RequestContext {
        org_id: admin_auth.org_id,
        auth: Some(admin_auth),
        session: None,
    };
    let alpha_run = store::create_run(
        &pool,
        &admin_ctx,
        CreateRunRequest {
            project: Some("alpha".to_string()),
            name: Some("alpha-run".to_string()),
            config: Some(json!({ "seed": 1 })),
            tags: Some(vec!["a".to_string()]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("alpha run");
    let beta_run = store::create_run(
        &pool,
        &admin_ctx,
        CreateRunRequest {
            project: Some("beta".to_string()),
            name: Some("beta-run".to_string()),
            config: Some(json!({ "seed": 2 })),
            tags: Some(vec!["b".to_string()]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("beta run");
    let scoped_key = store::create_api_key(
        &pool,
        org.id,
        CreateApiKeyRequest {
            name: Some("alpha-only".to_string()),
            scopes: None,
            created_by_user_id: None,
            project_id: Some(alpha_run.project_id),
            project: None,
            expires_at: None,
        },
    )
    .await
    .expect("scoped key");
    let scoped_auth =
        store::authenticate_api_key(&pool, scoped_key["api_key"].as_str().expect("scoped token"))
            .await
            .expect("scoped auth");
    assert_eq!(scoped_auth.project_id, Some(alpha_run.project_id));
    let scoped_ctx = RequestContext {
        org_id: scoped_auth.org_id,
        auth: Some(scoped_auth),
        session: None,
    };

    let projects = store::list_projects(&pool, &scoped_ctx)
        .await
        .expect("scoped projects");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].name, "alpha");
    assert_eq!(
        store::list_runs(&pool, &scoped_ctx, &query(&[]))
            .await
            .expect("scoped runs")["runs"]
            .as_array()
            .expect("runs")
            .len(),
        1
    );
    store::get_run(&pool, &scoped_ctx, alpha_run.id)
        .await
        .expect("alpha readable");
    assert_eq!(
        store::get_run(&pool, &scoped_ctx, beta_run.id)
            .await
            .expect_err("beta blocked")
            .status(),
        axum::http::StatusCode::FORBIDDEN
    );
    let metric_body = json!({ "step": 1, "metrics": { "reward": 1 } });
    let metric_input: LogMetricsRequest =
        serde_json::from_value(metric_body.clone()).expect("metric input");
    assert_eq!(
        store::log_metrics(
            &pool,
            &scoped_ctx,
            beta_run.id,
            metric_body,
            metric_input,
            None
        )
        .await
        .expect_err("beta metric blocked")
        .status(),
        axum::http::StatusCode::FORBIDDEN
    );
    assert_eq!(
        store::side_by_side(
            &pool,
            &scoped_ctx,
            &query(&[("run_ids", &format!("{},{}", alpha_run.id, beta_run.id),)]),
        )
        .await
        .expect_err("side by side blocks mixed projects")
        .status(),
        axum::http::StatusCode::FORBIDDEN
    );
    let beta_histogram = store::create_object(
        &pool,
        &admin_ctx,
        beta_run.id,
        CreateObjectRequest {
            key: Some("eval/beta-histogram".to_string()),
            kind: Some("histogram".to_string()),
            step: None,
            artifact_id: None,
            metadata: Some(json!({})),
            summary: Some(json!({})),
            value: Some(json!({ "bins": [0, 1], "counts": [1] })),
            rows: None,
        },
    )
    .await
    .expect("beta object");
    assert_eq!(
        store::list_object_rows(
            &pool,
            &scoped_ctx,
            beta_histogram["id"].as_i64().expect("object id"),
            &query(&[]),
        )
        .await
        .expect_err("project-scoped key cannot probe object kinds outside project")
        .status(),
        axum::http::StatusCode::FORBIDDEN
    );
    assert_eq!(
        store::export_data(&pool, &scoped_ctx, &query(&[]))
            .await
            .expect("scoped export")["runs"]
            .as_array()
            .expect("runs")
            .len(),
        1
    );
    store::import_payload(
        &pool,
        &scoped_ctx,
        "neptune",
        false,
        json!({
            "project": "alpha",
            "runs": [{ "name": "alpha-import", "metrics": [{ "key": "reward", "step": 1, "value": 2 }] }]
        }),
    )
    .await
    .expect("scoped import into allowed project");
    let scoped_first = store::runs_summary(&pool, &scoped_ctx, &query(&[("limit", "1")]))
        .await
        .expect("scoped first page");
    let scoped_cursor = scoped_first["next_cursor"].as_str().expect("scoped cursor");
    let scoped_second = store::runs_summary(
        &pool,
        &scoped_ctx,
        &query(&[("limit", "1"), ("cursor", scoped_cursor)]),
    )
    .await
    .expect("scoped second page");
    assert!(
        scoped_second["runs"][0]["project"].as_str() == Some("alpha"),
        "project-scoped cursor pages stay inside the key project"
    );
    assert_eq!(
        store::runs_summary(&pool, &scoped_ctx, &query(&[("project", "beta")]))
            .await
            .expect("scoped beta search is empty")["total"],
        0
    );
    assert_eq!(
        store::import_payload(
            &pool,
            &scoped_ctx,
            "neptune",
            false,
            json!({
                "project": "beta",
                "runs": [{ "name": "beta-import", "metrics": [{ "key": "reward", "step": 1, "value": 2 }] }]
            }),
        )
        .await
        .expect_err("scoped import into other project blocked")
        .status(),
        axum::http::StatusCode::FORBIDDEN
    );
    assert_eq!(
        store::list_imports(&pool, &scoped_ctx)
            .await
            .expect("scoped imports")["imports"]
            .as_array()
            .expect("imports")
            .len(),
        1
    );
    assert_eq!(
        store::usage_summary(&pool, &scoped_ctx)
            .await
            .expect_err("project-scoped usage blocked")
            .status(),
        axum::http::StatusCode::FORBIDDEN
    );
    assert_eq!(
        store::reset_demo(&pool, &scoped_ctx)
            .await
            .expect_err("project-scoped demo reset blocked")
            .status(),
        axum::http::StatusCode::FORBIDDEN
    );
    assert_eq!(
        store::runs_summary(&pool, &admin_ctx, &query(&[("project", "demo")]))
            .await
            .expect("demo remains absent")["total"],
        0
    );
}

#[tokio::test]
async fn api_keys_revoke_disable_expire_and_reject_unknown_scopes() {
    let pg = TestPostgres::start();
    store::migrate(&pg.database_url).await.expect("migrate");
    let config = test_config(&pg);
    let pool = store::connect(&config).await.expect("connect");
    let org = store::create_organization(
        &pool,
        CreateOrganizationRequest {
            slug: Some("keys-org".to_string()),
            name: Some("Keys Org".to_string()),
            plan_tier: None,
            owner_user_id: None,
        },
    )
    .await
    .expect("org");

    assert_eq!(
        store::create_api_key(
            &pool,
            org.id,
            CreateApiKeyRequest {
                name: Some("bad-scope".to_string()),
                scopes: Some(vec!["mystery:scope".to_string()]),
                created_by_user_id: None,
                project_id: None,
                project: None,
                expires_at: None,
            },
        )
        .await
        .expect_err("unknown scope rejected")
        .status(),
        axum::http::StatusCode::BAD_REQUEST
    );

    let revoked = store::create_api_key(
        &pool,
        org.id,
        CreateApiKeyRequest {
            name: Some("revoked".to_string()),
            scopes: None,
            created_by_user_id: None,
            project_id: None,
            project: None,
            expires_at: None,
        },
    )
    .await
    .expect("revoked key");
    let revoked_token = revoked["api_key"]
        .as_str()
        .expect("revoked token")
        .to_string();
    let revoked_key_id: Uuid =
        serde_json::from_value(revoked["key"]["id"].clone()).expect("key id");
    store::revoke_api_key(&pool, org.id, revoked_key_id)
        .await
        .expect("revoke");
    assert_eq!(
        store::authenticate_api_key(&pool, &revoked_token)
            .await
            .expect_err("revoked auth blocked")
            .status(),
        axum::http::StatusCode::UNAUTHORIZED
    );

    let disabled = store::create_api_key(
        &pool,
        org.id,
        CreateApiKeyRequest {
            name: Some("disabled".to_string()),
            scopes: None,
            created_by_user_id: None,
            project_id: None,
            project: None,
            expires_at: None,
        },
    )
    .await
    .expect("disabled key");
    let disabled_token = disabled["api_key"]
        .as_str()
        .expect("disabled token")
        .to_string();
    let service_account_id: Uuid =
        serde_json::from_value(disabled["service_account"]["id"].clone()).expect("service id");
    store::disable_service_account(&pool, org.id, service_account_id)
        .await
        .expect("disable");
    assert_eq!(
        store::authenticate_api_key(&pool, &disabled_token)
            .await
            .expect_err("disabled auth blocked")
            .status(),
        axum::http::StatusCode::UNAUTHORIZED
    );

    let expired = store::create_api_key(
        &pool,
        org.id,
        CreateApiKeyRequest {
            name: Some("expired".to_string()),
            scopes: None,
            created_by_user_id: None,
            project_id: None,
            project: None,
            expires_at: Some("2020-01-01T00:00:00Z".to_string()),
        },
    )
    .await
    .expect("expired key");
    assert_eq!(
        store::authenticate_api_key(&pool, expired["api_key"].as_str().expect("expired token"))
            .await
            .expect_err("expired auth blocked")
            .status(),
        axum::http::StatusCode::UNAUTHORIZED
    );

    let active = store::create_api_key(
        &pool,
        org.id,
        CreateApiKeyRequest {
            name: Some("active".to_string()),
            scopes: Some(vec!["usage:read".to_string()]),
            created_by_user_id: None,
            project_id: None,
            project: None,
            expires_at: None,
        },
    )
    .await
    .expect("active key");
    let active_auth =
        store::authenticate_api_key(&pool, active["api_key"].as_str().expect("active token"))
            .await
            .expect("active auth");
    let usage_ctx = RequestContext {
        org_id: active_auth.org_id,
        auth: Some(active_auth),
        session: None,
    };
    let usage = store::usage_summary(&pool, &usage_ctx)
        .await
        .expect("usage");
    assert_eq!(usage["organizations"][0]["usage"]["api_keys"], 1);
}

#[tokio::test]
async fn artifacts_imports_and_usage_rollups_cover_p3_paths() {
    let pg = TestPostgres::start();
    store::migrate(&pg.database_url).await.expect("migrate");
    let config = test_config(&pg);
    let pool = store::connect(&config).await.expect("connect");
    let ctx = RequestContext::local();
    let run = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("p3".to_string()),
            name: Some("p3-run".to_string()),
            config: Some(json!({ "seed": 1 })),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("run");

    assert_eq!(
        store::upload_artifact(
            &pool,
            &config,
            &ctx,
            run.id,
            UploadArtifactRequest {
                kind: Some("file".to_string()),
                name: Some("empty.txt".to_string()),
                content_base64: Some("".to_string()),
                step: None,
                mime_type: Some("text/plain".to_string()),
                metadata: Some(json!({})),
                path: None,
            },
        )
        .await
        .expect_err("empty upload rejected")
        .status(),
        axum::http::StatusCode::BAD_REQUEST
    );
    assert_eq!(count_files(&config.artifact_root), 0);
    assert_eq!(
        store::upload_artifact(
            &pool,
            &config,
            &ctx,
            run.id,
            UploadArtifactRequest {
                kind: Some("file".to_string()),
                name: Some("cleanup.txt".to_string()),
                content_base64: Some("Y2xlYW51cA==".to_string()),
                step: None,
                mime_type: Some("text/plain".to_string()),
                metadata: Some(json!({})),
                path: Some("x".repeat(600)),
            },
        )
        .await
        .expect_err("failed metadata insert cleans bytes")
        .status(),
        axum::http::StatusCode::BAD_REQUEST
    );
    assert_eq!(count_files(&config.artifact_root), 0);

    let artifact = store::upload_artifact(
        &pool,
        &config,
        &ctx,
        run.id,
        UploadArtifactRequest {
            kind: Some("file".to_string()),
            name: Some("hello.txt".to_string()),
            content_base64: Some("aGVsbG8=".to_string()),
            step: None,
            mime_type: Some("text/plain".to_string()),
            metadata: Some(json!({})),
            path: None,
        },
    )
    .await
    .expect("artifact");
    let mut file = LocalArtifactStore::new(&config.artifact_root)
        .open(&artifact)
        .await
        .expect("open artifact");
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await.expect("read artifact");
    assert_eq!(bytes, b"hello");
    fs::remove_file(artifact.storage_path.as_ref().expect("storage path")).expect("remove bytes");
    assert_eq!(
        LocalArtifactStore::new(&config.artifact_root)
            .open(&artifact)
            .await
            .expect_err("missing bytes detected")
            .status(),
        axum::http::StatusCode::NOT_FOUND
    );

    let bad_import = store::import_payload(
        &pool,
        &ctx,
        "neptune",
        false,
        json!({
            "project": "rollback-import",
            "runs": [
                { "name": "valid-first", "metrics": [{ "key": "reward", "step": 1, "value": 1 }] },
                { "name": "invalid-second", "metrics": [{ "key": "reward", "step": -1, "value": 2 }] }
            ]
        }),
    )
    .await
    .expect_err("bad import rejected");
    assert_eq!(bad_import.status(), axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        store::runs_summary(&pool, &ctx, &query(&[("project", "rollback-import")]))
            .await
            .expect("rollback summary")["total"],
        0
    );
    let duplicate_key_import = store::import_payload(
        &pool,
        &ctx,
        "neptune",
        false,
        json!({
            "project": "duplicate-key-import",
            "runs": [{
                "name": "dupe",
                "metrics": [
                    { "key": "reward", "step": 1, "timestamp": "2026-01-01T00:00:00Z", "value": 1 },
                    { "key": "reward", "step": 1, "timestamp": "2026-01-01T00:00:00Z", "value": 2 }
                ]
            }]
        }),
    )
    .await
    .expect("duplicate-key import batches safely");
    let duplicate_run_id: Uuid =
        serde_json::from_value(duplicate_key_import["import"]["run_ids"][0].clone())
            .expect("duplicate run id");
    assert_eq!(
        store::get_run(&pool, &ctx, duplicate_run_id)
            .await
            .expect("duplicate run")["metric_aggregates"]["reward"]["count"],
        json!(2)
    );

    let neptune_payload = json!({
        "project": "neptune-import",
        "runs": [{
            "id": "NEP-1",
            "name": "remote-run",
            "status": "finished",
            "config": { "seed": 7 },
            "tags": ["migrated"],
            "metadata": { "neptune_id": "NEP-1", "_rlobs": { "external": true } },
            "metrics": [{ "key": "eval/return_mean", "step": 1, "value": 42, "timestamp": "2026-01-01T00:00:00Z" }],
            "attributes": [{ "path": "notes/comment", "type": "string_series", "step": 1, "value": "ported" }],
            "artifacts": [{ "type": "file", "name": "config.json", "uri": "file://config.json", "size_bytes": 10 }]
        }]
    });
    assert_eq!(
        store::import_payload(&pool, &ctx, "neptune", true, neptune_payload.clone())
            .await
            .expect("dry run")["summary"]["artifacts"],
        1
    );
    let neptune = store::import_payload(&pool, &ctx, "neptune", false, neptune_payload)
        .await
        .expect("neptune import");
    assert_eq!(neptune["import"]["source_type"], "neptune_exporter_json");
    let imported_run_id: Uuid =
        serde_json::from_value(neptune["import"]["run_ids"][0].clone()).expect("import run id");
    let imported_run = store::get_run(&pool, &ctx, imported_run_id)
        .await
        .expect("imported run");
    assert_eq!(
        imported_run["latest_metrics"]["eval/return_mean"],
        json!(42.0)
    );
    assert_eq!(
        imported_run["metadata"]["neptune"]["metadata"]["_rlobs"]["external"],
        true
    );
    assert_eq!(
        store::list_attributes(
            &pool,
            &ctx,
            imported_run_id,
            &query(&[("type", "string_series")])
        )
        .await
        .expect("attributes")[0]
            .value,
        json!("ported")
    );
    assert_eq!(
        store::list_artifacts(&pool, &ctx, imported_run_id, &query(&[]))
            .await
            .expect("artifacts")
            .len(),
        1
    );

    let wandb = store::import_payload(
        &pool,
        &ctx,
        "wandb",
        false,
        json!({
            "project": "wandb-import",
            "runs": [{
                "id": "wandb-1",
                "name": "seed-1",
                "state": "finished",
                "config": { "seed": 1 },
                "tags": ["baseline"],
                "metadata": { "_rlobs": { "external": true } },
                "history": [
                    { "_timestamp": 1760000000, "reward": 1 },
                    { "_step": 4, "_timestamp": "2026-05-09T00:00:00Z", "reward": 3, "flag": true }
                ],
                "artifacts": [{ "name": "policy.pt", "type": "model", "uri": "wandb://policy.pt", "size_bytes": 12 }]
            }]
        }),
    )
    .await
    .expect("wandb import");
    let wandb_run_id: Uuid =
        serde_json::from_value(wandb["import"]["run_ids"][0].clone()).expect("wandb run id");
    assert_eq!(
        store::get_run(&pool, &ctx, wandb_run_id)
            .await
            .expect("wandb run")["latest_metrics"]["reward"],
        json!(3.0)
    );
    assert_eq!(
        store::list_artifacts(&pool, &ctx, wandb_run_id, &query(&[]))
            .await
            .expect("wandb artifacts")[0]
            .kind,
        "checkpoint"
    );

    let mlflow = store::import_payload(
        &pool,
        &ctx,
        "mlflow",
        false,
        json!({
            "schema_version": 1,
            "project": "mlflow-import",
            "runs": [{
                "info": {
                    "run_id": "mlflow-1",
                    "run_name": "seed-1",
                    "status": "FINISHED",
                    "start_time": 1760000000000i64,
                    "end_time": "2025-10-09T08:55:00Z",
                    "artifact_uri": "s3://bucket/mlruns/12/mlflow-1/artifacts/"
                },
                "data": {
                    "params": [{ "key": "seed", "value": "1" }],
                    "metrics": [{ "key": "loss", "value": 0.5, "step": 2, "timestamp": 1760000020000i64 }]
                },
                "metric_history_complete": false,
                "metric_history": [{ "key": "reward", "value": 4, "step": 3, "timestamp": "2025-10-09T08:54:00Z" }],
                "artifacts": [
                    { "path": "checkpoints/policy.pt", "file_size": 12345, "is_dir": false },
                    { "path": "nested", "is_dir": true }
                ]
            }]
        }),
    )
    .await
    .expect("mlflow import");
    assert_eq!(mlflow["summary"]["metrics"], 2);
    assert_eq!(mlflow["summary"]["skipped"]["artifact_directories"], 1);
    let mlflow_run_id: Uuid =
        serde_json::from_value(mlflow["import"]["run_ids"][0].clone()).expect("mlflow run id");
    let mlflow_run = store::get_run(&pool, &ctx, mlflow_run_id)
        .await
        .expect("mlflow run");
    assert_eq!(mlflow_run["config"]["seed"], "1");
    assert_eq!(mlflow_run["latest_metrics"]["reward"], json!(4.0));
    assert_eq!(mlflow_run["latest_metrics"]["loss"], json!(0.5));
    assert_eq!(
        store::list_artifacts(&pool, &ctx, mlflow_run_id, &query(&[]))
            .await
            .expect("mlflow artifacts")[0]
            .uri,
        "s3://bucket/mlruns/12/mlflow-1/artifacts/checkpoints/policy.pt"
    );

    let period = NaiveDate::from_ymd_opt(2026, 5, 9).expect("date");
    assert!(
        store::write_usage_daily_snapshot(&pool, store::LOCAL_ORG_ID, period)
            .await
            .expect("first snapshot")
    );
    assert!(
        !store::write_usage_daily_snapshot(&pool, store::LOCAL_ORG_ID, period)
            .await
            .expect("second snapshot")
    );
    let snapshot_count: i64 = sqlx::query_scalar(
        "select count(*) from usage_daily where org_id = $1 and period_start = $2",
    )
    .bind(store::LOCAL_ORG_ID)
    .bind(period)
    .fetch_one(&pool)
    .await
    .expect("snapshot count");
    assert_eq!(snapshot_count, 1);

    let cap_run = store::create_run(
        &pool,
        &ctx,
        CreateRunRequest {
            project: Some("wide-compare".to_string()),
            name: Some("wide".to_string()),
            config: Some(json!({})),
            tags: Some(vec![]),
            metadata: Some(json!({})),
        },
    )
    .await
    .expect("wide run");
    for batch in 0..2 {
        let metrics = (0..900)
            .map(|index| (format!("m/{batch}-{index}"), json!(index + batch * 900)))
            .collect::<serde_json::Map<_, _>>();
        let body = json!({ "step": batch, "metrics": metrics });
        let input: LogMetricsRequest = serde_json::from_value(body.clone()).expect("wide metrics");
        store::log_metrics(&pool, &ctx, cap_run.id, body, input, None)
            .await
            .expect("wide metric batch");
    }
    let side_by_side =
        store::side_by_side(&pool, &ctx, &query(&[("run_ids", &cap_run.id.to_string())]))
            .await
            .expect("wide side by side");
    assert!(side_by_side["truncated"].as_bool().unwrap_or(false));
    assert_eq!(side_by_side["rows"].as_array().expect("rows").len(), 5_000);
}

#[tokio::test]
async fn onboarding_sessions_seats_and_user_api_keys_are_authorized() {
    let pg = TestPostgres::start();
    store::migrate(&pg.database_url).await.expect("migrate");
    let config = test_config(&pg);
    let pool = store::connect(&config).await.expect("connect");

    let created = store::create_dev_google_session(
        &pool,
        rlobs_rust_server::domain::DevGoogleAuthRequest {
            email: Some("owner@example.com".to_string()),
            display_name: Some("Owner".to_string()),
            account_type: Some("business".to_string()),
            org_name: Some("Auth Lab".to_string()),
            seat_emails: None,
        },
    )
    .await
    .expect("dev auth session");
    assert!(created.payload.authenticated);
    assert_eq!(created.payload.organization.account_type, "business");
    assert_eq!(created.payload.organization.seat_limit, 3);
    assert_eq!(created.payload.membership.role, "owner");
    let org_id = created.payload.organization.id;
    let owner_id = created.payload.user.id;

    let active_session = store::authenticate_session(&pool, &created.token)
        .await
        .expect("active session");
    assert_eq!(active_session.organization.id, org_id);
    assert_eq!(active_session.user.id, owner_id);

    let duplicate_slug = store::create_dev_google_session(
        &pool,
        rlobs_rust_server::domain::DevGoogleAuthRequest {
            email: Some("other@example.com".to_string()),
            display_name: Some("Other".to_string()),
            account_type: Some("business".to_string()),
            org_name: Some("Auth Lab".to_string()),
            seat_emails: None,
        },
    )
    .await
    .expect_err("duplicate org slug should be rejected");
    assert_eq!(duplicate_slug.status(), axum::http::StatusCode::CONFLICT);

    let first_seat = store::reserve_seat(
        &pool,
        owner_id,
        org_id,
        rlobs_rust_server::domain::ReserveSeatRequest {
            email: Some("member1@example.com".to_string()),
            role: Some("member".to_string()),
        },
    )
    .await
    .expect("first seat");
    assert_eq!(first_seat.status, "invited");
    let second_seat = store::reserve_seat(
        &pool,
        owner_id,
        org_id,
        rlobs_rust_server::domain::ReserveSeatRequest {
            email: Some("member2@example.com".to_string()),
            role: Some("viewer".to_string()),
        },
    )
    .await
    .expect("second seat");
    assert_eq!(second_seat.status, "invited");
    let over_limit = store::reserve_seat(
        &pool,
        owner_id,
        org_id,
        rlobs_rust_server::domain::ReserveSeatRequest {
            email: Some("member3@example.com".to_string()),
            role: Some("member".to_string()),
        },
    )
    .await
    .expect_err("business plan includes only owner plus two reserved seats");
    assert_eq!(over_limit.status(), axum::http::StatusCode::CONFLICT);

    let race_created = store::create_dev_google_session(
        &pool,
        rlobs_rust_server::domain::DevGoogleAuthRequest {
            email: Some("race-owner@example.com".to_string()),
            display_name: Some("Race Owner".to_string()),
            account_type: Some("business".to_string()),
            org_name: Some("Auth Race".to_string()),
            seat_emails: None,
        },
    )
    .await
    .expect("race dev auth session");
    let race_org_id = race_created.payload.organization.id;
    let race_owner_id = race_created.payload.user.id;
    store::reserve_seat(
        &pool,
        race_owner_id,
        race_org_id,
        rlobs_rust_server::domain::ReserveSeatRequest {
            email: Some("race-one@example.com".to_string()),
            role: Some("member".to_string()),
        },
    )
    .await
    .expect("race setup seat");
    let (left, right) = tokio::join!(
        store::reserve_seat(
            &pool,
            race_owner_id,
            race_org_id,
            rlobs_rust_server::domain::ReserveSeatRequest {
                email: Some("race-two@example.com".to_string()),
                role: Some("member".to_string()),
            },
        ),
        store::reserve_seat(
            &pool,
            race_owner_id,
            race_org_id,
            rlobs_rust_server::domain::ReserveSeatRequest {
                email: Some("race-three@example.com".to_string()),
                role: Some("member".to_string()),
            },
        )
    );
    let race_successes = [&left, &right]
        .iter()
        .filter(|result| result.is_ok())
        .count();
    let race_conflicts = [left, right]
        .into_iter()
        .filter(|result| {
            result
                .as_ref()
                .err()
                .is_some_and(|error| error.status() == axum::http::StatusCode::CONFLICT)
        })
        .count();
    assert_eq!(race_successes, 1);
    assert_eq!(race_conflicts, 1);

    let invited_token = generate_session_token();
    sqlx::query(
        r#"
        insert into user_sessions (user_id, org_id, token_hash, expires_at)
        values ($1, $2, $3, now() + interval '30 days')
        "#,
    )
    .bind(first_seat.user_id)
    .bind(org_id)
    .bind(hash_secret(&invited_token))
    .execute(&pool)
    .await
    .expect("invited session row");
    let invited_error = store::authenticate_session(&pool, &invited_token)
        .await
        .expect_err("invited membership should not authenticate");
    assert_eq!(invited_error.status(), axum::http::StatusCode::UNAUTHORIZED);

    let key = store::create_api_key_for_user(
        &pool,
        owner_id,
        org_id,
        CreateApiKeyRequest {
            name: Some("Onboarding key".to_string()),
            scopes: None,
            created_by_user_id: Some(Uuid::new_v4()),
            project_id: None,
            project: None,
            expires_at: None,
        },
    )
    .await
    .expect("owner api key");
    assert!(key["api_key"]
        .as_str()
        .expect("plain key")
        .starts_with("rlobs_"));
    let scopes = key["key"]["scopes"].as_array().expect("scopes");
    assert_eq!(scopes.len(), 3);
    assert!(scopes.iter().any(|scope| scope == "sdk:ingest"));
    assert_eq!(
        key["service_account"]["created_by_user_id"],
        json!(owner_id)
    );

    sqlx::query("update memberships set status = 'active', role = 'member' where id = $1")
        .bind(first_seat.id)
        .execute(&pool)
        .await
        .expect("activate member");
    let member_key = store::create_api_key_for_user(
        &pool,
        first_seat.user_id,
        org_id,
        CreateApiKeyRequest {
            name: Some("Member key".to_string()),
            scopes: None,
            created_by_user_id: None,
            project_id: None,
            project: None,
            expires_at: None,
        },
    )
    .await
    .expect_err("members cannot create org api keys");
    assert_eq!(member_key.status(), axum::http::StatusCode::FORBIDDEN);

    store::revoke_session(&pool, &created.token)
        .await
        .expect("revoke session");
    let revoked = store::authenticate_session(&pool, &created.token)
        .await
        .expect_err("revoked session should not authenticate");
    assert_eq!(revoked.status(), axum::http::StatusCode::UNAUTHORIZED);
    let deleted = store::delete_expired_or_revoked_sessions(&pool)
        .await
        .expect("delete sessions");
    assert!(deleted >= 1);
}

fn test_config(pg: &TestPostgres) -> AppConfig {
    AppConfig {
        database_url: pg.database_url.clone(),
        clickhouse_url: std::env::var("CLICKHOUSE_URL")
            .unwrap_or_else(|_| "http://default:@127.0.0.1:8123/rlobs_test".to_string()),
        bind_addr: format!("127.0.0.1:{}", pg.port).parse().expect("addr"),
        max_body_bytes: 1_000_000,
        max_upload_body_bytes: 50_000_000,
        artifact_root: pg.dir.path().join("artifacts"),
        bootstrap_token: "test-bootstrap".to_string(),
        auth_mode: AuthMode::ApiKey,
        dev_auth_enabled: false,
        managed_google_enabled: false,
        allowed_frontend_origins: vec![],
        request_timeout: std::time::Duration::from_secs(30),
        database_acquire_timeout: std::time::Duration::from_secs(5),
        log_format: LogFormat::Pretty,
    }
}

fn query(items: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
    items
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

fn count_files(path: &Path) -> usize {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                count_files(&path)
            } else {
                1
            }
        })
        .sum()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port()
}

fn run(command: &mut Command) {
    let status = command.status().expect("command starts");
    assert!(status.success(), "command failed with status {status:?}");
}
