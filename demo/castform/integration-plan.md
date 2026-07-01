# Castform Integration Plan

Research date: 2026-06-30.

## First Slice

Build a one-way mirror from Castform to InstantML:

```text
Castform run-read API / Benchmax TrainerClient
  -> lightweight sync process
  -> InstantML Python SDK or Import v2
  -> InstantML Runs workspace, Compare, export, and agent analysis
```

The first slice should mirror:

- run identity, name, status, URL, created/updated times;
- launcher args and environment/dataset storage paths as config;
- scalar series for train/eval modes;
- lifecycle events as text evidence;
- environment logs as console/text evidence;
- high-level tags and notes.

## Why Pull Sync First

Pull sync is enough for a credible collaboration demo because Benchmax already
has public read methods for runs, scalars, events, and environment logs.

Advantages:

- no Castform trainer changes;
- easy to run from a laptop during prep;
- safe failure mode because Castform remains the source of truth;
- useful for historical backfills.

Limitations:

- polling latency;
- unclear pagination/incremental cursor support from public docs;
- rollout-level richness depends on what Castform exposes through run-read APIs;
- artifact bytes may remain external references until a deeper integration.

## Phase 1: Demo Pull Mirror

Implement as a script or small service:

1. Accept `castform_run_id`, `instantml_project`, Castform API key, and InstantML
   API key.
2. Fetch `get_run(..., include_config=True)` and `get_run_details(...)`.
3. Create an InstantML run with Castform metadata and launcher args.
4. Fetch modes from details and call `get_run_scalars(run_id, mode)` for each.
5. Normalize metrics and log them into InstantML.
6. Fetch `get_run_events(...)` and `get_environment_logs(...)`, then log them as
   text/console evidence.
7. Finish the InstantML mirror run with a status derived from Castform status.

Use `demo/castform/castform_instantml_adapter.py` as the current planning artifact.

## Phase 2: Partner-Grade Integration

Replace polling with a Castform-side delivery path:

```text
Castform trainer or platform service
  -> observer hook / webhook batch
  -> InstantML ingest endpoint
  -> ClickHouse metric series and run summaries
```

Preferred payloads:

- `run.created`, `run.updated`, `run.finished`, `run.failed`;
- `metrics.batch` with mode, metric name, step, value, timestamp;
- `reward_components.batch`;
- `environment_logs.batch` with level, message, created_at, rollout_id if safe;
- `artifact.reference.created` for checkpoints, eval summaries, dataset
  manifests, and environment metadata.

Durability requirements:

- stable external run ID: `castform:<run_id>`;
- idempotency key per event batch;
- monotonically increasing source sequence or timestamp;
- explicit partial-write behavior and retries;
- bounded batch sizes.

## Phase 3: Embedded Views And Shared Analysis

After reliable mirroring:

- Add an "Open in InstantML" link from Castform run pages.
- Optionally embed an InstantML read-only comparison panel back into Castform for
  selected projects or reports.
- Expose an agent-readable comparison endpoint or MCP workflow so Castform users
  can ask questions across historical runs.

## Data Mapping

See `castform-metric-mapping.json` for the proposed canonical mapping.

Important choices:

- Prefix source metrics with mode: `train/*`, `eval/*`, `comp/*`.
- Preserve source names under metadata for traceability.
- Store Castform URL and run ID in config/metadata/notes.
- Expect environment-specific reward component names. The public RAG example
  uses `citation`, `correctness`, and `search_efficiency`, but other
  environments may expose different components.
- Use tags for workflow filtering, not one-off details.
- Keep raw rollout inspection in Castform; mirror selected logs and summaries in
  InstantML.

## Open Questions For Castform

1. Are `get_run_scalars`, `get_run_events`, and `get_environment_logs` intended
   as stable partner APIs?
2. Do run scalar endpoints paginate, support incremental reads, or expose
   updated-at cursors?
3. What scalar mode names should we expect beyond `train` and `eval`?
4. Are reward component metrics returned as ordinary scalar names or a separate
   structured shape?
5. Can lifecycle events include checkpoint/model/eval artifact references?
6. Can environment logs be fetched by time range, step range, or rollout ID list?
7. Does Castform expose enough rollout IDs from the run summary to fetch selected
   rollout logs without scraping UI data?
8. What auth model should a partner integration use: user API keys,
   organization-scoped service tokens, OAuth, or webhook signing?
9. Can Castform emit webhooks for run status and metric batches?
10. Would Castform prefer InstantML as a customer-owned destination, a hosted
    integration, or an embedded observability panel inside Castform?

## Risks

- Castform already has strong per-run observability, so the demo must emphasize
  cross-run value.
- Public API surfaces may not be complete enough for incremental mirroring.
- Raw rollout messages can contain sensitive customer data. The demo should
  mirror only selected logs and metadata unless Castform confirms sharing rules.
- Metric naming may differ across environments. Keep normalization configurable.
- If the first demo uses synthetic data, label it clearly.

## Recommended Ask On The Call

Ask Castform for one shared training run or a sandbox API key with read-only
access to a few non-sensitive runs. That lets us mirror real curves and return
with a concrete embedded or hosted prototype.

The public app home already exposes example result links for `company docs
search (rag)` and `customer support (traces)`. Use those examples on the call to
ask whether the same IDs are stable enough for a shared read-only mirror, or
whether Castform would prefer to provide a separate sandbox run set.
