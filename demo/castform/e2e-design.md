# Castform InstantML End-to-End Demo Design

Status: accepted for the demo-only first slice; revised 2026-07-01 to target
the live InstantML warehouse under a new project.
Scope: all artifacts stay under `demo/castform/`; no production API, SDK, or
database changes are required.

## Goal

Show a full local workflow that a Castform partner can understand in one pass:

1. a Castform SDK-shaped training run emits run metadata, scalar metrics, logs,
   and lifecycle events;
2. the demo streams those observations into InstantML through the real
   InstantML Python SDK and hosted or local InstantML API;
3. the demo creates short-lived InstantML iframe embed sessions for the seeded
   runs;
4. a local Castform-facing web page renders those iframes as read-only
   observability panels.

The demo must remain honest about what is real:

- InstantML ingestion, run storage, embed-session creation, and iframe rendering
  use real hosted InstantML surfaces by default so the demo data and iframe
  sessions persist for the call.
- Castform training can use a live Castform/Benchmax SDK run when credentials,
  uploaded assets, and quota are available. The deterministic local
  Castform-shaped fallback remains the default call-prep path when a live
  launch is not appropriate.
- The existing `castform_instantml_adapter.py` remains the live-read path when a
  real Benchmax/Castform API key and run ID are available.

## Architecture

```text
demo/castform/run_demo.py
  -> read a live InstantML API key from the environment
  -> mirror live Castform run IDs or run Castform SDK-shaped fallback trainer
  -> log metrics/text/console through packages/python-sdk
  -> POST /api/embed/sessions for selected run sets
  -> write web/public/demo-manifest.json

demo/castform/web
  -> static local parent page
  -> reads demo-manifest.json
  -> renders InstantML iframe src values
  -> shows Castform-side status, run metadata, and source mapping
```

Default hosted InstantML services:

- API: `https://api.instantml.ai`.
- Iframe app: `https://instantml.ai/embed/runs/:session_id#token=...`.
- Castform parent page: served locally but exposed through an HTTPS tunnel
  origin such as `https://<demo-subdomain>.ngrok-free.app`; hosted embeds reject
  plain loopback HTTP parent origins.

Local-only InstantML mode remains available for development by overriding
`--api-base-url`, `--instantml-web-base-url`, and `--parent-origin`, but it is
not the call-prep default.

## Demo Runner Contract

`run_demo.py` is the operator entrypoint.

Inputs:

- `--api-base-url`, default `https://api.instantml.ai`
- `--instantml-web-base-url`, default `https://instantml.ai`
- `--parent-origin`, required for hosted mode and must be an HTTPS
  non-InstantML origin
- `--project`, default `castform-live-demo`
- `--runs`, default `5`
- `--steps`, default `240`
- `--castform-run-id`, optional and repeatable for live Castform mirror mode
- `--manifest`, default `demo/castform/web/public/demo-manifest.json`

Outputs:

- `web/public/demo-manifest.json`, read by the local web page.
- `run-output/latest-summary.json`, safe to inspect and commit only when it does
  not include live bearer secrets.
- console output with run IDs, created iframe session IDs, and next commands.

The runner reads `INSTANTML_API_KEY` from the environment. The key must include
`sdk:ingest` and `export:read`; `artifacts:write` is useful but not required for
this demo slice.

The manifest includes iframe URLs because browser iframes need the token-bearing
fragment. Treat the manifest as local-only generated state; it is ignored by
Git. A token-redacted summary is written for review. Never commit the API key,
the plaintext embed token, or a live unredacted iframe URL.

## Live Castform SDK Path

Use `castform_live_bridge.py` when a real Castform run should be launched from
already-uploaded assets. It calls `benchmax.platform.client.TrainerClient`:

```bash
CASTFORM_API_KEY=... \
python3 demo/castform/castform_live_bridge.py \
  --training-run-type simple \
  --env-cls-path envs/.../env-cls.pkl \
  --env-metadata-path envs/.../env-metadata.json \
  --train-dataset-path datasets/.../train.jsonl \
  --eval-dataset-path datasets/.../eval.jsonl \
  --name castform-instantml-demo \
  --launcher-arg model='"Qwen/Qwen3.5-4B"'
```

Then pass the returned run ID into the hosted InstantML writer:

```bash
CASTFORM_API_KEY=... INSTANTML_API_KEY=... \
python3 demo/castform/run_demo.py \
  --castform-run-id <castform-run-id> \
  --parent-origin https://<demo-parent-origin>
```

## Castform SDK-Shaped Training Fallback

The fallback keeps the code path close to the public Castform/Benchmax shape:

- `CastformTrainingSpec` carries environment, launcher args, reward version,
  and tags.
- `LocalCastformTrainer.launch_training_run(...)` yields step events, scalar
  metrics, lifecycle events, and environment logs.
- Metric names match the mapping in `castform-metric-mapping.json`.

This lets the call show "where the Castform SDK hooks go" without pretending
the local script launched real Castform infrastructure.

## Iframe Sessions

The runner creates three embed sessions:

- `overview`: all selected runs, compact comparison.
- `winner-vs-overfit`: best balanced run against the overfit run.
- `winner-vs-verbose`: best balanced run against the verbose regression run.

Each session uses:

```json
{
  "allowed_parent_origin": "https://<demo-subdomain>.ngrok-free.app",
  "ttl_seconds": 3600,
  "options": {
    "metric_point_limit": 500,
    "max_panels": 8,
    "theme": "system"
  }
}
```

## Web Page Shape

The web page follows the generated concept in `assets/ui-concept.png`:

- left rail: Castform stream status, local services, manifest freshness;
- top center: run cards with model, learning rate, group size, and final
  metrics;
- main area: tabbed InstantML iframe panels;
- side panel: mirrored evidence and source mapping.

The page must not expose the embed token as visible text. The iframe `src`
contains the fragment token by necessity, but summaries and cards display only
session IDs and redacted URLs.

## Local Browser Smoke Path

Before live keys or a tunnel are available, use `create_smoke_manifest.py` to
write a synthetic manifest with the same schema and redaction behavior:

```bash
python3 demo/castform/create_smoke_manifest.py
python3 demo/castform/serve_web.py --port 5174
node demo/castform/browser_verify.mjs \
  --url http://127.0.0.1:5174 \
  --expect-runs 3 \
  --expect-sessions 3
```

This proves the Castform parent page loads, displays run cards, switches iframe
tabs, refreshes the manifest, and keeps `instantml_embed_...` tokens out of
visible text. It does not replace the final hosted check because the local smoke
uses `about:blank` iframe targets instead of live InstantML iframe content.

## Verification

Minimum checks before a commit:

```bash
python3 -m py_compile demo/castform/run_demo.py demo/castform/castform_live_bridge.py demo/castform/verify_demo.py demo/castform/castform_instantml_adapter.py demo/castform/seed_castform_demo.py demo/castform/create_smoke_manifest.py
node --check demo/castform/web/app.js
node --check demo/castform/browser_verify.mjs
git diff --check
```

Full local demo check:

1. obtain a live InstantML API key in Chrome and export it only in the shell
   running the demo;
2. start the Castform parent page locally;
3. expose it through an HTTPS tunnel and pass that origin as `--parent-origin`;
4. run `python3 demo/castform/run_demo.py --parent-origin <https-origin>`;
5. open the HTTPS parent page in Chrome and confirm hosted iframe content loads.

## Risks And Constraints

- The iframe source is a bearer secret. Generated manifests stay untracked.
- Creating or copying a live InstantML API key is a persistent-access operation
  and needs action-time confirmation in the browser workflow.
- Real Castform runs require partner credentials and may need a separate live
  adapter invocation. The Castform app entry point to check during prep is
  `https://app.castform.com/home`.
- Hosted iframes require an HTTPS parent origin that is not an InstantML-owned
  domain.
- Browser verification should avoid screenshots that reveal iframe token
  fragments in DOM dumps or visible text.
