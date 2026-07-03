use super::*;

pub async fn reset_demo(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    ensure_billing_write_allowed(store, ctx.org_id, "reset the demo dataset").await?;
    let demo_project_exists = {
        let data = store.data.lock().await;
        data.projects_by_org_name
            .contains_key(&(ctx.org_id, "demo".to_string()))
    };
    enforce_plan_capacity(
        store,
        ctx.org_id,
        demo_usage_delta(demo_project_exists),
        "reset the demo dataset",
    )
    .await?;
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let mut data = store.data.lock().await;
    let delete = ProjectDeleteRecord {
        org_id: ctx.org_id,
        project_name: "demo".to_string(),
    };
    store
        .persist_locked("project_delete", ctx.org_id, "demo", &delete)
        .await?;
    data.apply_project_delete(delete);
    let project = ensure_project_locked(store, &mut data, ctx.org_id, "demo").await?;
    let mut points = Vec::new();
    let mut log_rows = Vec::new();
    for index in 0..DEMO_RUN_COUNT {
        let seed = 7 + ((index as i64 * 37) % 100_000);
        let workload = if index % 10 < 6 { "llm" } else { "rl" };
        let run_id = Uuid::new_v4();
        let status = if index % 97 == 0 {
            "failed"
        } else if index % 89 == 0 {
            "running"
        } else {
            "finished"
        };
        let run = RunRow {
            id: run_id,
            org_id: ctx.org_id,
            project_id: project.id,
            project: "demo".to_string(),
            name: demo_run_name(workload, index, seed),
            status: status.to_string(),
            config: demo_config(workload, index, seed),
            tags: demo_tags(workload, index, seed),
            metadata: demo_metadata(workload, index, seed),
            created_at: Utc::now() - ChronoDuration::seconds((DEMO_RUN_COUNT - index) as i64),
            started_at: Utc::now() - ChronoDuration::minutes(20),
            finished_at: (status != "running").then(Utc::now),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        };
        store
            .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
            .await?;
        data.insert_run(run.clone());
        let mut run_artifacts = Vec::new();
        for mut artifact in demo_artifacts(workload, seed) {
            artifact.org_id = ctx.org_id;
            artifact.run_id = run_id;
            artifact.mime_type = artifact.mime_type.or_else(|| {
                mime_guess::from_path(&artifact.name)
                    .first_raw()
                    .map(str::to_string)
            });
            run_artifacts.push(artifact.clone());
            store
                .persist_locked("artifact", ctx.org_id, &artifact.id.to_string(), &artifact)
                .await?;
            data.insert_artifact(artifact);
        }
        if index < 40 || index % 50 == 0 {
            let table = demo_object(
                &mut data,
                ctx.org_id,
                run_id,
                "eval/samples",
                "table",
                json!({"kind":"table"}),
                json!({"columns":["prompt","prediction","target","score"],"row_count":5}),
            );
            store
                .persist_locked("attribute", ctx.org_id, &table.id.to_string(), &table)
                .await?;
            data.insert_attribute(table.clone());
            let rows = TableRowsRecord {
                attribute_id: table.id,
                rows: (0..5).map(|row| TableObjectRow {
                    row_index: row,
                    row: json!({"prompt": format!("episode {row}"), "prediction": format!("seed {seed}"), "target": "stable", "score": 0.7 + row as f64 * 0.03}),
                    created_at: Utc::now(),
                }).collect(),
            };
            store
                .persist_locked("table_rows", ctx.org_id, &table.id.to_string(), &rows)
                .await?;
            data.table_rows.insert((ctx.org_id, table.id), rows.rows);
            let hist = demo_object(
                &mut data,
                ctx.org_id,
                run_id,
                "eval/score_distribution",
                "histogram_series",
                json!({"bins":[0,0.5,1],"counts":[2,5]}),
                json!({"bins":3}),
            );
            store
                .persist_locked("attribute", ctx.org_id, &hist.id.to_string(), &hist)
                .await?;
            data.insert_attribute(hist);
            let mut media = demo_object(
                &mut data,
                ctx.org_id,
                run_id,
                "media/demo",
                if workload == "llm" { "audio" } else { "video" },
                json!({"kind": if workload == "llm" { "audio" } else { "video" }}),
                json!({"source":"demo"}),
            );
            media.artifact_id = run_artifacts
                .iter()
                .find(|artifact| {
                    if workload == "llm" {
                        artifact.name.ends_with(".mp3")
                    } else {
                        artifact.kind == "rollout"
                    }
                })
                .map(|artifact| artifact.id);
            store
                .persist_locked("attribute", ctx.org_id, &media.id.to_string(), &media)
                .await?;
            data.insert_attribute(media);
        }
        for (line_index, message) in demo_console_lines(workload, seed, status)
            .into_iter()
            .enumerate()
        {
            log_rows.push(ConsoleLogInsertRow {
                org_id: ctx.org_id,
                run_id,
                stream: if status == "failed" && line_index + 1 == 5 {
                    "stderr"
                } else {
                    "stdout"
                }
                .to_string(),
                ingest_id: Uuid::new_v4(),
                line_number: (line_index + 1) as u64,
                message,
                logged_at: Utc::now(),
                created_at: Utc::now(),
            });
        }
        for step in DEMO_STEPS {
            for (key, value) in demo_metrics(workload, index, seed, step) {
                points.push(ChMetricPointRow {
                    org_id: ctx.org_id,
                    run_id,
                    key,
                    step: step as f64,
                    value,
                    logged_at: Utc::now(),
                    created_at: Utc::now(),
                });
            }
        }
    }
    drop(data);
    for chunk in points.chunks(10_000) {
        metric_store.insert_points(chunk).await?;
    }
    for chunk in log_rows.chunks(10_000) {
        metric_store.insert_console_logs(chunk).await?;
    }
    let mut query = HashMap::new();
    query.insert("project".to_string(), "demo".to_string());
    query.insert("limit".to_string(), "100".to_string());
    runs_summary(store, ctx, &query).await
}

fn demo_usage_delta(project_exists: bool) -> UsageDelta {
    let mut metric_points = 0_i64;
    let mut artifacts = 0_i64;
    for index in 0..DEMO_RUN_COUNT {
        let seed = 7 + ((index as i64 * 37) % 100_000);
        let workload = if index % 10 < 6 { "llm" } else { "rl" };
        for step in DEMO_STEPS {
            metric_points += demo_metrics(workload, index, seed, step).len() as i64;
        }
        let rows = demo_artifacts(workload, seed);
        artifacts += rows.len() as i64;
    }
    UsageDelta {
        projects: if project_exists { 0 } else { 1 },
        runs: DEMO_RUN_COUNT as i64,
        metric_points,
        trace_events: 0,
        storage_bytes: artifacts * ARTIFACT_METADATA_BYTES
            + DEMO_RUN_COUNT as i64 * RUN_METADATA_BYTES
            + if project_exists {
                0
            } else {
                PROJECT_METADATA_BYTES
            },
    }
}

fn demo_console_lines(workload: &str, seed: i64, status: &str) -> Vec<String> {
    let model = if workload == "llm" {
        "transformer-small"
    } else {
        "ppo-policy"
    };
    let mut lines = vec![
        format!("[seed={seed}, model={model}] starting training loop"),
        "Epoch 1/6 | loss: 1.2042 | lr: 3e-4 | throughput: 1820 samples/s".to_string(),
        "\u{001b}[32mcheckpoint saved\u{001b}[0m at step 80".to_string(),
        "eval/return_mean improved; scheduling validation sweep".to_string(),
    ];
    if status == "failed" {
        lines.push("\u{001b}[31mRuntimeError: gradient overflow detected\u{001b}[0m".to_string());
    } else {
        lines.push("training finished with stable validation metrics".to_string());
    }
    lines
}

fn demo_object(
    data: &mut StoreData,
    org_id: Uuid,
    run_id: Uuid,
    path: &str,
    kind: &str,
    value: Value,
    summary: Value,
) -> AttributeRow {
    AttributeRow {
        id: data.allocate_attribute_id(org_id),
        org_id,
        run_id,
        path: path.to_string(),
        kind: kind.to_string(),
        step: Some(200.0),
        logged_at: Some(Utc::now()),
        value,
        summary,
        artifact_id: None,
        created_at: Utc::now(),
    }
}

fn demo_run_name(workload: &str, index: usize, seed: i64) -> String {
    if workload == "llm" {
        format!("llm-{}-seed-{seed}", ["sft", "dpo", "rag-eval"][index % 3])
    } else {
        format!(
            "rl-{}-seed-{seed}",
            ["ppo-cartpole", "sac-hopper", "dqn-minigrid"][index % 3]
        )
    }
}

fn demo_config(workload: &str, index: usize, seed: i64) -> Value {
    json!({
        "workload": workload,
        "seed": seed,
        "learning_rate": if index % 2 == 0 { 0.0003 } else { 0.0001 },
        "hardware": { "gpu_model": if index % 4 == 0 { "NVIDIA H100" } else { "NVIDIA A100" }, "gpu_count": 1 + (index % 8) }
    })
}

fn demo_tags(workload: &str, index: usize, seed: i64) -> Vec<String> {
    vec![
        "demo".to_string(),
        workload.to_string(),
        if index % 3 == 0 {
            "baseline"
        } else {
            "candidate"
        }
        .to_string(),
        format!("seed-{seed}"),
        if index % 5 == 0 {
            "reward-stability"
        } else {
            "healthy"
        }
        .to_string(),
    ]
}

fn demo_metadata(workload: &str, index: usize, seed: i64) -> Value {
    json!({
        "source": "demo-reset",
        "notes": if workload == "rl" {
            format!("Synthetic RL run {index}: reward stability and rollout quality for seed {seed}.")
        } else {
            format!("Synthetic LLM run {index}: loss, eval quality, and throughput for seed {seed}.")
        },
        "demo": { "seed": seed, "run_index": index }
    })
}

fn demo_artifacts(workload: &str, seed: i64) -> Vec<ArtifactRow> {
    let mut rows = vec![
        demo_artifact(
            "checkpoint",
            format!("checkpoint-step-200-seed-{seed}.pt"),
            format!("demo://checkpoints/{seed}.pt"),
            Some(200.0),
            Some(48_000_000 + seed),
        ),
        demo_artifact(
            "file",
            format!("run-config-seed-{seed}.json"),
            format!("demo://configs/{seed}.json"),
            None,
            Some(4096 + seed),
        ),
    ];
    if workload == "rl" {
        rows.push(demo_artifact(
            "rollout",
            format!("eval-rollout-seed-{seed}.mp4"),
            format!("demo://rollouts/{seed}.mp4"),
            Some(200.0),
            Some(8_000_000 + seed),
        ));
    } else {
        rows.push(demo_artifact(
            "file",
            format!("eval-audio-seed-{seed}.mp3"),
            format!("demo://audio/{seed}.mp3"),
            Some(200.0),
            Some(2_000_000 + seed),
        ));
    }
    rows
}

fn demo_artifact(
    kind: &str,
    name: String,
    uri: String,
    step: Option<f64>,
    size_bytes: Option<i64>,
) -> ArtifactRow {
    ArtifactRow {
        id: Uuid::new_v4(),
        org_id: LOCAL_ORG_ID,
        run_id: Uuid::nil(),
        kind: kind.to_string(),
        name,
        uri,
        step,
        size_bytes,
        sha256: None,
        mime_type: None,
        storage_backend: "external".to_string(),
        storage_key: None,
        storage_path: None,
        metadata: json!({ "source": "demo" }),
        created_at: Utc::now(),
    }
}

fn demo_metrics(workload: &str, index: usize, seed: i64, step: i64) -> Vec<(String, f64)> {
    let progress = step as f64 / 200.0;
    let wave = ((seed as f64) * 0.017 + step as f64 / 19.0).sin();
    let reward = 25.0 + progress * (260.0 + (index % 23) as f64 * 4.0) + wave * 18.0;
    vec![
        ("eval/return_mean".to_string(), round4(reward)),
        (
            "eval/loss".to_string(),
            round4((2.2 - progress * 1.4 + wave.abs() * 0.05).max(0.1)),
        ),
        ("train/reward".to_string(), round4(reward * 0.94)),
        (
            "train/loss".to_string(),
            round4((1.9 - progress * 1.2 + wave.abs() * 0.08).max(0.05)),
        ),
        (
            "train/grad_norm".to_string(),
            round4((0.8 + wave.abs() * 0.22 + (1.0 - progress) * 0.15).max(0.05)),
        ),
        ("rollout/ep_rew_mean".to_string(), round4(reward * 0.98)),
        (
            "agent/action_std".to_string(),
            round4((0.9 - progress * 0.55 + wave.abs() * 0.04).max(0.05)),
        ),
        (
            "data/loader_wait_ms".to_string(),
            round4((42.0 - 24.0 * progress + wave.abs() * 10.0).max(2.0)),
        ),
        (
            "system/cpu_percent".to_string(),
            round4(34.0 + 38.0 * progress + wave * 6.0),
        ),
        (
            "gpu/0/utilization_percent".to_string(),
            round4((55.0 + 38.0 * progress + wave * 8.0).clamp(0.0, 100.0)),
        ),
        (format!("{workload}/quality"), round4(0.3 + progress * 0.5)),
    ]
}
