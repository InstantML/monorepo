use super::*;

pub async fn reset_demo(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
) -> AppResult<Value> {
    ensure_unrestricted_org_key(ctx)?;
    let now = Utc::now();
    let mut tx = pool.begin().await?;
    sqlx::query("delete from projects where org_id = $1 and name = 'demo'")
        .bind(ctx.org_id)
        .execute(&mut *tx)
        .await?;
    let project_id = sqlx::query_scalar::<_, Uuid>(
        "insert into projects (org_id, name) values ($1, 'demo') returning id",
    )
    .bind(ctx.org_id)
    .fetch_one(&mut *tx)
    .await?;
    let mut run_records = Vec::with_capacity(DEMO_RUN_COUNT);
    let mut ch_metric_rows: Vec<ChMetricPointRow> =
        Vec::with_capacity(DEMO_RUN_COUNT * DEMO_STEPS.len() * 32);
    let mut artifact_records = Vec::with_capacity(DEMO_RUN_COUNT * 4);
    for index in 0..DEMO_RUN_COUNT {
        let seed = demo_seed(index);
        let workload = demo_workload(index);
        let run_id = Uuid::new_v4();
        let status = demo_status(index);
        run_records.push(json!({
            "id": run_id,
            "name": demo_run_name(workload, index, seed),
            "status": status,
            "config": demo_config(workload, index, seed),
            "tags": demo_tags(workload, index, seed),
            "metadata": demo_metadata(workload, index, seed),
            "finished_at": if status == "running" { Value::Null } else { json!(now) },
        }));
        for step in DEMO_STEPS {
            let metrics = demo_metrics(workload, index, seed, step);
            for (key, value) in metrics {
                let value = value
                    .as_f64()
                    .ok_or_else(|| AppError::validation("invalid non-numeric demo metric"))?;
                ch_metric_rows.push(ChMetricPointRow {
                    org_id: ctx.org_id,
                    run_id,
                    key,
                    step: step as f64,
                    value,
                    logged_at: now,
                    created_at: now,
                });
            }
        }
        for artifact in demo_artifacts(workload, index, seed) {
            let kind = validate_artifact_type(artifact.kind.as_deref().unwrap_or("file"))?;
            let name = validate_name(artifact.name.as_deref(), "artifact name")?;
            let uri = validate_name(artifact.uri.as_deref(), "artifact uri")?;
            let step = artifact
                .step
                .as_ref()
                .map(|value| validate_optional_step(Some(value), "step"))
                .transpose()?
                .flatten();
            let size_bytes = artifact
                .size_bytes
                .as_ref()
                .map(validate_size_bytes)
                .transpose()?;
            let metadata = validate_json_object(artifact.metadata, "metadata")?;
            let mime_type = artifact
                .mime_type
                .or_else(|| mime_guess::from_path(&name).first_raw().map(str::to_string));
            artifact_records.push(json!({
                "run_id": run_id,
                "kind": kind,
                "name": name,
                "uri": uri,
                "step": step,
                "size_bytes": size_bytes,
                "sha256": artifact.sha256,
                "mime_type": mime_type,
                "metadata": metadata,
            }));
        }
    }
    insert_demo_runs_tx(&mut tx, ctx.org_id, project_id, &run_records).await?;
    for chunk in artifact_records.chunks(DEMO_INSERT_CHUNK) {
        insert_demo_artifacts_tx(&mut tx, ctx.org_id, chunk).await?;
    }
    insert_demo_rich_objects_tx(&mut tx, ctx.org_id, &run_records).await?;
    tx.commit().await?;
    // ClickHouse writes happen after the Postgres tx commits so that any
    // demo-runs rollback fully reverts state. The metric_series_mv materialized
    // view maintains the aggregated `metric_series` automatically, so the demo
    // path no longer pre-computes a series table.
    for chunk in ch_metric_rows.chunks(DEMO_INSERT_CHUNK) {
        metric_store.insert_points(chunk).await?;
    }
    let mut query = HashMap::new();
    query.insert("project".to_string(), "demo".to_string());
    query.insert("limit".to_string(), "100".to_string());
    runs_summary(pool, metric_store, ctx, &query).await
}

async fn insert_demo_runs_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    project_id: Uuid,
    records: &[Value],
) -> AppResult<()> {
    if records.is_empty() {
        return Ok(());
    }
    sqlx::query(
        r#"
        insert into runs (id, org_id, project_id, name, status, config, tags, metadata, finished_at)
        select record.id, $1, $2, record.name, record.status, record.config, record.tags, record.metadata, record.finished_at
        from jsonb_to_recordset($3::jsonb) as record(
          id uuid,
          name text,
          status text,
          config jsonb,
          tags text[],
          metadata jsonb,
          finished_at timestamptz
        )
        "#,
    )
    .bind(org_id)
    .bind(project_id)
    .bind(Json(Value::Array(records.to_vec())))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_demo_artifacts_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    records: &[Value],
) -> AppResult<()> {
    if records.is_empty() {
        return Ok(());
    }
    sqlx::query(
        r#"
        insert into artifacts (org_id, run_id, type, name, uri, step, size_bytes, sha256, mime_type, metadata)
        select $1, record.run_id, record.kind, record.name, record.uri, record.step, record.size_bytes,
               record.sha256, record.mime_type, record.metadata
        from jsonb_to_recordset($2::jsonb) as record(
          run_id uuid,
          kind text,
          name text,
          uri text,
          step double precision,
          size_bytes bigint,
          sha256 text,
          mime_type text,
          metadata jsonb
        )
        "#,
    )
    .bind(org_id)
    .bind(Json(Value::Array(records.to_vec())))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_demo_rich_objects_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_records: &[Value],
) -> AppResult<()> {
    for (index, record) in run_records.iter().enumerate() {
        if index >= 40 && index % 50 != 0 {
            continue;
        }
        let run_id = record
            .get("id")
            .and_then(Value::as_str)
            .and_then(|raw| Uuid::parse_str(raw).ok())
            .ok_or_else(|| AppError::validation("demo run id must be a UUID"))?;
        let seed = demo_seed(index);
        let workload = demo_workload(index);
        let table = insert_attribute_tx(
            tx,
            org_id,
            run_id,
            "eval/samples",
            "table",
            Some(200.0),
            Some(Utc::now()),
            json!({ "kind": "table", "metadata": { "source": "demo" } }),
            json!({
                "columns": ["prompt", "prediction", "target", "score"],
                "row_count": 5,
                "source": "demo"
            }),
            None,
        )
        .await?;
        let table_rows = demo_table_rows(workload, seed);
        insert_table_object_rows_tx(tx, org_id, table.id, &table_rows).await?;
        insert_attribute_tx(
            tx,
            org_id,
            run_id,
            "eval/score_distribution",
            "histogram_series",
            Some(200.0),
            Some(Utc::now()),
            json!({
                "bins": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
                "counts": demo_histogram_counts(index),
                "metadata": { "source": "demo" }
            }),
            json!({ "bins": 6, "source": "demo" }),
            None,
        )
        .await?;
        if let Some(artifact) = demo_media_artifact_tx(tx, org_id, run_id, workload).await? {
            let kind = if artifact
                .mime_type
                .as_deref()
                .unwrap_or_default()
                .starts_with("audio/")
            {
                "audio"
            } else {
                "video"
            };
            insert_attribute_tx(
                tx,
                org_id,
                run_id,
                &format!("media/{}", artifact.name),
                kind,
                artifact.step,
                Some(Utc::now()),
                json!({
                    "kind": kind,
                    "uri": artifact.uri,
                    "metadata": { "source": "demo", "caption": "Demo media sample" }
                }),
                merge_media_summary(json!({ "source": "demo" }), &artifact),
                Some(artifact.id),
            )
            .await?;
        }
    }
    Ok(())
}

async fn demo_media_artifact_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    workload: DemoWorkload,
) -> AppResult<Option<ArtifactRow>> {
    let media_prefix = match workload {
        DemoWorkload::Llm => "audio/%",
        DemoWorkload::Rl => "video/%",
    };
    sqlx::query_as::<_, ArtifactRow>(
        r#"
        select id, org_id, run_id, type as kind, name, uri, step, size_bytes, sha256, mime_type,
               storage_backend, storage_key, storage_path, metadata, created_at
        from artifacts
        where org_id = $1 and run_id = $2 and mime_type like $3
        order by created_at desc, id desc
        limit 1
        "#,
    )
    .bind(org_id)
    .bind(run_id)
    .bind(media_prefix)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Into::into)
}

fn demo_table_rows(workload: DemoWorkload, seed: i64) -> Vec<Value> {
    (0..5)
        .map(|index| match workload {
            DemoWorkload::Llm => json!({
                "prompt": format!("Summarize eval document {index}"),
                "prediction": format!("summary candidate seed {seed}-{index}"),
                "target": format!("reference summary {index}"),
                "score": round4(0.74 + (seed % 17) as f64 * 0.003 + index as f64 * 0.01)
            }),
            DemoWorkload::Rl => json!({
                "prompt": format!("episode {index}"),
                "prediction": format!("return {}", 180 + seed % 90 + index),
                "target": "stable high-return rollout",
                "score": round4(0.61 + (seed % 23) as f64 * 0.004 + index as f64 * 0.015)
            }),
        })
        .collect()
}

fn demo_histogram_counts(index: usize) -> Vec<i64> {
    vec![
        2 + (index % 4) as i64,
        8 + (index % 7) as i64,
        18 + (index % 11) as i64,
        13 + (index % 5) as i64,
        5 + (index % 3) as i64,
    ]
}

#[derive(Clone, Copy)]
enum DemoWorkload {
    Llm,
    Rl,
}

fn demo_seed(index: usize) -> i64 {
    7 + ((index as i64 * 37) % 100_000)
}

fn demo_workload(index: usize) -> DemoWorkload {
    if index % 10 < 6 {
        DemoWorkload::Llm
    } else {
        DemoWorkload::Rl
    }
}

fn demo_status(index: usize) -> &'static str {
    if index % 97 == 0 {
        "failed"
    } else if index % 89 == 0 {
        "running"
    } else {
        "finished"
    }
}

fn demo_hardware(index: usize) -> (&'static str, i64, i64, &'static str, i64, i64, &'static str) {
    let gpu_models = [
        "NVIDIA A100 80GB",
        "NVIDIA H100 80GB",
        "NVIDIA L4 24GB",
        "RTX 4090 24GB",
    ];
    let gpu_counts = [8_i64, 4, 2, 1];
    let gpu_memory = [80_i64, 80, 24, 24];
    let cpu_models = [
        "AMD EPYC 7B13",
        "Intel Xeon Platinum 8481C",
        "AMD EPYC 9654",
        "Apple M3 Max",
    ];
    let cpu_cores = [96_i64, 64, 128, 16];
    let ram_gb = [768_i64, 512, 1024, 128];
    let clouds = [
        "gcp/us-central1",
        "aws/us-west-2",
        "lambda/us-south",
        "local/lab",
    ];
    let choice = index % gpu_models.len();
    (
        cpu_models[choice],
        cpu_cores[choice],
        ram_gb[choice],
        gpu_models[choice],
        gpu_counts[choice],
        gpu_memory[choice],
        clouds[choice],
    )
}

fn demo_run_name(workload: DemoWorkload, index: usize, seed: i64) -> String {
    match workload {
        DemoWorkload::Llm => {
            let models = [
                "llama3-8b",
                "mistral-7b",
                "qwen2.5-7b",
                "t5-large",
                "bert-base",
            ];
            let tasks = ["sft", "dpo", "summarization", "classification", "rag-eval"];
            format!(
                "llm-{}-{}-seed-{seed}",
                models[index % models.len()],
                tasks[(index / models.len()) % tasks.len()]
            )
        }
        DemoWorkload::Rl => {
            let algos = ["ppo", "sac", "dqn", "td3"];
            let envs = [
                "cartpole",
                "hopper",
                "ant",
                "humanoid",
                "panda-reach",
                "minigrid",
            ];
            format!(
                "rl-{}-{}-seed-{seed}",
                algos[index % algos.len()],
                envs[(index / algos.len()) % envs.len()]
            )
        }
    }
}

fn demo_config(workload: DemoWorkload, index: usize, seed: i64) -> Value {
    let (cpu_model, cpu_cores, ram_gb, gpu_model, gpu_count, gpu_memory_gb, cloud) =
        demo_hardware(index);
    match workload {
        DemoWorkload::Llm => {
            let models = [
                "llama3-8b",
                "mistral-7b",
                "qwen2.5-7b",
                "t5-large",
                "bert-base",
            ];
            let datasets = [
                "alpaca-clean",
                "open-orca",
                "math-mix",
                "customer-support",
                "code-help",
            ];
            let tasks = ["sft", "dpo", "summarization", "classification", "rag-eval"];
            let batch_size = [16, 32, 64, 128][index % 4];
            let gradient_accumulation_steps = [1, 2, 4, 8][(index / 2) % 4];
            let sequence_length = [1024, 2048, 4096, 8192][(index / 5) % 4];
            let lora_rank = [0, 8, 16, 32][(index / 7) % 4];
            json!({
                "workload": "llm",
                "framework": "transformers",
                "trainer": if index % 4 == 0 { "deepspeed-zero3" } else { "hf-trainer" },
                "task": tasks[index % tasks.len()],
                "model": models[index % models.len()],
                "dataset": datasets[(index / 3) % datasets.len()],
                "seed": seed,
                "learning_rate": if index % 3 == 0 { 0.00005 } else { 0.00002 },
                "batch_size": batch_size,
                "gradient_accumulation_steps": gradient_accumulation_steps,
                "sequence_length": sequence_length,
                "precision": if index % 5 == 0 { "fp16" } else { "bf16" },
                "optimizer": if index % 7 == 0 { "adafactor" } else { "adamw" },
                "scheduler": if index % 2 == 0 { "cosine" } else { "linear" },
                "lora_rank": lora_rank,
                "hardware": {
                    "cpu_model": cpu_model,
                    "cpu_cores": cpu_cores,
                    "ram_gb": ram_gb,
                    "gpu_model": gpu_model,
                    "gpu_count": gpu_count,
                    "gpu_memory_gb": gpu_memory_gb,
                    "cloud": cloud
                }
            })
        }
        DemoWorkload::Rl => {
            let algos = ["ppo", "sac", "dqn", "td3"];
            let envs = [
                "CartPole-v1",
                "Hopper-v4",
                "Ant-v4",
                "Humanoid-v4",
                "PandaReach-v3",
                "MiniGrid-DoorKey-8x8",
            ];
            let num_envs = [4, 8, 16, 32][index % 4];
            let rollout_steps = [128, 256, 512, 1024][(index / 3) % 4];
            let batch_size = [64, 128, 256, 512][(index / 5) % 4];
            let gae_lambda = [0.9, 0.95, 0.97][index % 3];
            let clip_range = [0.1, 0.2, 0.3][(index / 2) % 3];
            let entropy_coef = [0.0, 0.001, 0.01][(index / 7) % 3];
            json!({
                "workload": "rl",
                "framework": "stable-baselines3",
                "algo": algos[index % algos.len()],
                "env": envs[(index / 4) % envs.len()],
                "seed": seed,
                "learning_rate": if index % 2 == 0 { 0.0003 } else { 0.0001 },
                "num_envs": num_envs,
                "rollout_steps": rollout_steps,
                "batch_size": batch_size,
                "gamma": if index % 3 == 0 { 0.995 } else { 0.99 },
                "gae_lambda": gae_lambda,
                "clip_range": clip_range,
                "entropy_coef": entropy_coef,
                "reward_shaping": index % 4 == 0,
                "hardware": {
                    "cpu_model": cpu_model,
                    "cpu_cores": cpu_cores,
                    "ram_gb": ram_gb,
                    "gpu_model": gpu_model,
                    "gpu_count": gpu_count,
                    "gpu_memory_gb": gpu_memory_gb,
                    "cloud": cloud
                }
            })
        }
    }
}

fn demo_tags(workload: DemoWorkload, index: usize, seed: i64) -> Vec<String> {
    let (_, _, _, gpu_model, gpu_count, _, cloud) = demo_hardware(index);
    let mut tags = vec![
        "demo".to_string(),
        if index % 3 == 0 {
            "baseline"
        } else {
            "candidate"
        }
        .to_string(),
        if index % 97 == 0 {
            "needs-triage"
        } else {
            "healthy"
        }
        .to_string(),
        format!("seed-{seed}"),
        format!(
            "{}x-{}",
            gpu_count,
            gpu_model
                .split_whitespace()
                .nth(1)
                .unwrap_or("gpu")
                .to_lowercase()
        ),
        cloud.replace('/', "-"),
    ];
    match workload {
        DemoWorkload::Llm => {
            tags.push("llm".to_string());
            tags.push(
                if index % 5 == 0 {
                    "long-context"
                } else {
                    "fine-tune"
                }
                .to_string(),
            );
        }
        DemoWorkload::Rl => {
            tags.push("rl".to_string());
            tags.push(
                if index % 4 == 0 {
                    "robotics"
                } else {
                    "control"
                }
                .to_string(),
            );
        }
    }
    tags
}

fn demo_metadata(workload: DemoWorkload, index: usize, seed: i64) -> Value {
    let (cpu_model, cpu_cores, ram_gb, gpu_model, gpu_count, gpu_memory_gb, cloud) =
        demo_hardware(index);
    let note = match workload {
        DemoWorkload::Llm => format!(
            "Synthetic LLM run {index}: compare loss, perplexity, throughput, gradient norm, eval quality, and hardware pressure."
        ),
        DemoWorkload::Rl => format!(
            "Synthetic RL run {index}: compare reward stability, KL/entropy, success rate, rollout speed, and hardware utilization."
        ),
    };
    let owner = ["research", "platform", "infra", "evals"][index % 4];
    json!({
        "source": "demo-reset",
        "host": format!("trainer-{:03}", index % 64),
        "notes": note,
        "owner": owner,
        "git": {
            "branch": if index % 2 == 0 { "main" } else { "sweep/demo" },
            "commit": format!("demo{:08x}", index * 2654435761usize)
        },
        "hardware": {
            "cpu_model": cpu_model,
            "cpu_cores": cpu_cores,
            "ram_gb": ram_gb,
            "gpu_model": gpu_model,
            "gpu_count": gpu_count,
            "gpu_memory_gb": gpu_memory_gb,
            "cloud": cloud,
            "cuda": "12.4",
            "driver": "550.54"
        },
        "demo": {
            "schema": "rich-llm-rl-v1",
            "run_index": index,
            "seed": seed
        }
    })
}

fn demo_metrics(workload: DemoWorkload, index: usize, seed: i64, step: i64) -> Map<String, Value> {
    let mut metrics = Map::new();
    let step_f = step as f64;
    let progress = (step_f / 200.0).clamp(0.0, 1.0);
    let wave = ((seed as f64) * 0.017 + step_f / 19.0).sin();
    demo_system_metrics(&mut metrics, index, progress, wave);
    match workload {
        DemoWorkload::Llm => demo_llm_metrics(&mut metrics, index, seed, step_f, progress, wave),
        DemoWorkload::Rl => demo_rl_metrics(&mut metrics, index, seed, step_f, progress, wave),
    }
    metrics
}

fn demo_system_metrics(metrics: &mut Map<String, Value>, index: usize, progress: f64, wave: f64) {
    let (_, _, ram_gb, _, gpu_count, gpu_memory_gb, _) = demo_hardware(index);
    let gpu_count_f = gpu_count as f64;
    put_metric(
        metrics,
        "system/cpu_percent",
        34.0 + 38.0 * progress + wave * 6.0 + (index % 9) as f64,
    );
    put_metric(metrics, "system/cpu_threads", 12.0 + (index % 32) as f64);
    put_metric(
        metrics,
        "system/memory_percent",
        42.0 + 24.0 * progress + (index % 7) as f64,
    );
    put_metric(
        metrics,
        "system/process_memory_gb",
        (ram_gb as f64 * (0.18 + progress * 0.22)).min(ram_gb as f64 * 0.85),
    );
    put_metric(
        metrics,
        "system/disk_read_mb_s",
        80.0 + 160.0 * (1.0 - progress) + wave.abs() * 25.0,
    );
    put_metric(
        metrics,
        "system/disk_write_mb_s",
        20.0 + 90.0 * progress + (index % 11) as f64,
    );
    put_metric(
        metrics,
        "system/network_rx_mb_s",
        12.0 + 38.0 * progress + wave.abs() * 6.0,
    );
    put_metric(
        metrics,
        "system/network_tx_mb_s",
        6.0 + 28.0 * progress + (index % 5) as f64,
    );
    put_metric(
        metrics,
        "gpu/0/utilization_percent",
        (55.0 + 38.0 * progress + wave * 8.0).clamp(0.0, 100.0),
    );
    put_metric(
        metrics,
        "gpu/0/memory_percent",
        (48.0 + 36.0 * progress + (index % 13) as f64).clamp(0.0, 99.0),
    );
    put_metric(
        metrics,
        "gpu/0/memory_allocated_gb",
        gpu_memory_gb as f64 * (0.42 + 0.43 * progress),
    );
    put_metric(
        metrics,
        "gpu/0/temperature_c",
        54.0 + 18.0 * progress + wave * 3.0,
    );
    put_metric(
        metrics,
        "gpu/0/power_watts",
        140.0 + 65.0 * gpu_count_f.sqrt() + 120.0 * progress,
    );
    put_metric(metrics, "gpu/0/sm_clock_mhz", 1200.0 + 270.0 * progress);
    put_metric(
        metrics,
        "data/loader_wait_ms",
        (42.0 - 24.0 * progress + wave.abs() * 10.0).max(2.0),
    );
}

fn demo_llm_metrics(
    metrics: &mut Map<String, Value>,
    index: usize,
    seed: i64,
    step_f: f64,
    progress: f64,
    wave: f64,
) {
    let base_loss = 2.8 - 1.7 * progress + (index % 7) as f64 * 0.025 + wave * 0.04;
    let eval_loss = base_loss + 0.12 + ((seed as f64) * 0.013).cos() * 0.03;
    let lr_peak = if index % 3 == 0 { 0.00005 } else { 0.00002 };
    let lr = if progress < 0.1 {
        lr_peak * (progress / 0.1).max(0.05)
    } else {
        lr_peak * (1.0 - (progress - 0.1) / 0.9).max(0.03)
    };
    put_metric(metrics, "train/loss", base_loss.max(0.18));
    put_metric(
        metrics,
        "train/perplexity",
        base_loss.max(0.18).exp().min(80.0),
    );
    put_metric(metrics, "train/learning_rate", lr);
    put_metric(
        metrics,
        "train/grad_norm",
        0.4 + (1.0 - progress) * 2.8 + wave.abs() * 0.5,
    );
    put_metric(
        metrics,
        "train/tokens_per_second",
        18_000.0 + (index % 17) as f64 * 950.0 - progress * 2_200.0,
    );
    put_metric(
        metrics,
        "train/samples_per_second",
        120.0 + (index % 9) as f64 * 12.0 - progress * 18.0,
    );
    put_metric(
        metrics,
        "train/steps_per_second",
        1.8 + (index % 5) as f64 * 0.12 - progress * 0.3,
    );
    put_metric(
        metrics,
        "train/tokens_seen",
        step_f * (48_000.0 + (index % 13) as f64 * 2_000.0),
    );
    put_metric(
        metrics,
        "optimizer/weight_decay",
        if index % 4 == 0 { 0.0 } else { 0.01 },
    );
    put_metric(
        metrics,
        "optimizer/beta2",
        0.95 + (index % 5) as f64 * 0.009,
    );
    put_metric(
        metrics,
        "data/sequence_length",
        [1024.0, 2048.0, 4096.0, 8192.0][(index / 5) % 4],
    );
    put_metric(
        metrics,
        "data/tokens_per_batch",
        [16_384.0, 32_768.0, 65_536.0, 131_072.0][index % 4],
    );
    put_metric(metrics, "eval/loss", eval_loss.max(0.2));
    put_metric(
        metrics,
        "eval/perplexity",
        eval_loss.max(0.2).exp().min(90.0),
    );
    put_metric(
        metrics,
        "eval/accuracy",
        (0.42 + progress * 0.42 + (index % 11) as f64 * 0.006).min(0.96),
    );
    put_metric(
        metrics,
        "eval/f1",
        (0.38 + progress * 0.47 + (index % 7) as f64 * 0.007).min(0.97),
    );
    put_metric(
        metrics,
        "eval/rouge_l",
        (0.22 + progress * 0.44 + wave * 0.015).clamp(0.0, 0.92),
    );
    put_metric(
        metrics,
        "eval/exact_match",
        (0.12 + progress * 0.38 + (index % 5) as f64 * 0.01).min(0.78),
    );
    put_metric(
        metrics,
        "generation/tokens_per_second",
        650.0 + (index % 19) as f64 * 25.0 - progress * 40.0,
    );
    put_metric(
        metrics,
        "generation/latency_ms",
        220.0 - progress * 70.0 + wave.abs() * 16.0,
    );
    put_metric(
        metrics,
        "quality/win_rate",
        (0.28 + progress * 0.48 + wave * 0.02).clamp(0.0, 0.95),
    );
}

fn demo_rl_metrics(
    metrics: &mut Map<String, Value>,
    index: usize,
    seed: i64,
    step_f: f64,
    progress: f64,
    wave: f64,
) {
    let reward = 25.0 + progress * (260.0 + (index % 23) as f64 * 4.0) + wave * 18.0;
    let success = (0.08 + progress * 0.82 + (index % 13) as f64 * 0.006).min(0.99);
    put_metric(metrics, "rollout/ep_rew_mean", reward);
    put_metric(
        metrics,
        "rollout/ep_len_mean",
        90.0 + progress * 360.0 + (index % 41) as f64,
    );
    put_metric(
        metrics,
        "rollout/exploration_rate",
        (1.0 - progress * 0.82).max(0.05),
    );
    put_metric(
        metrics,
        "eval/mean_reward",
        reward * (1.02 + (seed % 5) as f64 * 0.004),
    );
    put_metric(metrics, "eval/return_mean", reward * 1.06);
    put_metric(metrics, "eval/success_rate", success);
    put_metric(
        metrics,
        "eval/collision_rate",
        (0.38 - progress * 0.31 + wave.abs() * 0.02).max(0.01),
    );
    put_metric(
        metrics,
        "train/approx_kl",
        (0.004 + progress * 0.035 + wave.abs() * 0.006).min(0.12),
    );
    put_metric(
        metrics,
        "train/clip_fraction",
        (0.02 + progress * 0.23 + wave.abs() * 0.03).min(0.55),
    );
    put_metric(
        metrics,
        "train/clip_range",
        [0.1, 0.2, 0.3][(index / 2) % 3],
    );
    put_metric(
        metrics,
        "train/entropy_loss",
        -1.8 + progress * 1.2 - wave.abs() * 0.08,
    );
    put_metric(
        metrics,
        "train/explained_variance",
        (0.15 + progress * 0.78 + wave * 0.03).clamp(-0.2, 0.99),
    );
    put_metric(
        metrics,
        "train/learning_rate",
        if index % 2 == 0 { 0.0003 } else { 0.0001 },
    );
    put_metric(
        metrics,
        "train/loss",
        (1.9 - progress * 1.35 + wave.abs() * 0.08).max(0.08),
    );
    put_metric(
        metrics,
        "train/policy_gradient_loss",
        -0.02 - progress * 0.025 + wave * 0.004,
    );
    put_metric(
        metrics,
        "train/value_loss",
        (1.4 - progress * 0.95 + wave.abs() * 0.05).max(0.04),
    );
    put_metric(
        metrics,
        "time/fps",
        650.0 + (index % 37) as f64 * 24.0 - progress * 80.0,
    );
    put_metric(metrics, "time/iterations", step_f / 20.0);
    put_metric(
        metrics,
        "time/total_timesteps",
        step_f * [512.0, 1024.0, 2048.0, 4096.0][index % 4],
    );
    put_metric(metrics, "reward/extrinsic", reward * 0.82);
    put_metric(
        metrics,
        "reward/intrinsic",
        (20.0 * (1.0 - progress) + wave.abs() * 4.0).max(0.0),
    );
    put_metric(
        metrics,
        "agent/action_std",
        (0.9 - progress * 0.55 + wave.abs() * 0.04).max(0.05),
    );
}

fn put_metric(metrics: &mut Map<String, Value>, key: &str, value: f64) {
    metrics.insert(key.to_string(), json!(round4(value)));
}

fn demo_artifacts(workload: DemoWorkload, index: usize, seed: i64) -> Vec<CreateArtifactRequest> {
    let mut artifacts = vec![
        CreateArtifactRequest {
            kind: Some("checkpoint".to_string()),
            name: Some(format!("checkpoint-step-100-seed-{seed}.pt")),
            uri: Some(format!(
                "demo://checkpoints/checkpoint-step-100-seed-{seed}.pt"
            )),
            step: Some(json!(100)),
            size_bytes: Some(json!(24_000_000 + seed * 32)),
            sha256: None,
            mime_type: None,
            metadata: Some(json!({ "step": 100, "best": index % 3 == 0 })),
            path: None,
        },
        CreateArtifactRequest {
            kind: Some("checkpoint".to_string()),
            name: Some(format!("checkpoint-step-200-seed-{seed}.pt")),
            uri: Some(format!(
                "demo://checkpoints/checkpoint-step-200-seed-{seed}.pt"
            )),
            step: Some(json!(200)),
            size_bytes: Some(json!(48_000_000 + seed * 64)),
            sha256: None,
            mime_type: None,
            metadata: Some(json!({ "step": 200, "best": true })),
            path: None,
        },
    ];
    match workload {
        DemoWorkload::Llm => {
            artifacts.push(CreateArtifactRequest {
                kind: Some("file".to_string()),
                name: Some(format!("eval-generations-seed-{seed}.jsonl")),
                uri: Some(format!(
                    "demo://generations/eval-generations-seed-{seed}.jsonl"
                )),
                step: Some(json!(200)),
                size_bytes: Some(json!(256_000 + seed)),
                sha256: None,
                mime_type: Some("application/jsonl".to_string()),
                metadata: Some(json!({ "kind": "generations", "rows": 128 })),
                path: None,
            });
            artifacts.push(CreateArtifactRequest {
                kind: Some("file".to_string()),
                name: Some(format!("sample-audio-seed-{seed}.mp3")),
                uri: Some(format!("demo://audio/sample-audio-seed-{seed}.mp3")),
                step: Some(json!(200)),
                size_bytes: Some(json!(1_200_000 + seed)),
                sha256: None,
                mime_type: Some("audio/mpeg".to_string()),
                metadata: Some(json!({ "kind": "audio", "duration_seconds": 18 + (index % 12), "caption": "Synthetic eval sample for media compare UI" })),
                path: None,
            });
        }
        DemoWorkload::Rl => {
            artifacts.push(CreateArtifactRequest {
                kind: Some("rollout".to_string()),
                name: Some(format!("eval-rollout-seed-{seed}.mp4")),
                uri: Some(format!("demo://rollouts/eval-rollout-seed-{seed}.mp4")),
                step: Some(json!(200)),
                size_bytes: Some(json!(8_000_000 + seed * 12)),
                sha256: None,
                mime_type: Some("video/mp4".to_string()),
                metadata: Some(
                    json!({ "kind": "video", "frames": 2400, "fps": 30, "return": 200 + seed }),
                ),
                path: None,
            });
            artifacts.push(CreateArtifactRequest {
                kind: Some("file".to_string()),
                name: Some(format!("episode-trace-seed-{seed}.jsonl")),
                uri: Some(format!("demo://traces/episode-trace-seed-{seed}.jsonl")),
                step: Some(json!(200)),
                size_bytes: Some(json!(640_000 + seed)),
                sha256: None,
                mime_type: Some("application/jsonl".to_string()),
                metadata: Some(json!({ "kind": "episode_trace", "episodes": 32 })),
                path: None,
            });
        }
    }
    artifacts.push(CreateArtifactRequest {
        kind: Some("file".to_string()),
        name: Some(format!("run-config-seed-{seed}.json")),
        uri: Some(format!("demo://configs/run-config-seed-{seed}.json")),
        step: None,
        size_bytes: Some(json!(4096 + seed)),
        sha256: None,
        mime_type: Some("application/json".to_string()),
        metadata: Some(json!({ "kind": "config" })),
        path: None,
    });
    artifacts
}
