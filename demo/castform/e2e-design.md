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
  -> read a live InstantML API key from the environment or ignored local .env
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

Current deployment note, 2026-07-01: hosted production data writes work, but
prod and staging currently return 404 for `POST /api/embed/sessions` and their
OpenAPI documents omit embed routes. The local real iframe E2E below is the
repeatable full iframe proof until the hosted embed API is deployed. The hosted
runner supports `--allow-embed-blocked` so an operator can still generate a
live-run parent page with zero iframe sessions and an explicit deployment
blocker after production data has been written or recovered by run ID.
`run_live_blocked_smoke.py` wraps that recovery path with a local parent server
and browser verification for the current call-prep environment.

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
- `--instantml-run-id`, optional and repeatable to reuse existing InstantML runs
  and only mint iframe sessions
- `--manifest`, default `demo/castform/web/public/demo-manifest.json`

Outputs:

- `web/public/demo-manifest.json`, read by the local web page.
- `run-output/latest-summary.json`, safe to inspect and commit only when it does
  not include live bearer secrets.
- console output with run IDs, created iframe session IDs, and next commands.

The runner reads `INSTANTML_API_KEY` from the environment, after first loading
ignored local `demo/castform/.env` values when that file exists. Explicitly
exported environment variables win over `.env`. The key must include
`sdk:ingest` and `export:read`; `artifacts:write` is useful but not required
for this demo slice.

When `--instantml-run-id` is used, the runner calls `GET /api/runs/summary` for
each run ID, reconstructs the Castform run-card metadata from the stored config
and latest metrics, and then creates only new embed sessions. It must not create
duplicate runs. This is the recovery path for the already-written production
`castform-live-demo` run IDs once hosted embed routes are available.

The manifest includes iframe URLs because browser iframes need the token-bearing
fragment. Treat the manifest as local-only generated state; it is ignored by
Git. A token-redacted summary is written for review. Never commit the API key,
the plaintext embed token, or a live unredacted iframe URL.

## Live Castform SDK Path

Use `castform_live_bridge.py` when a real Castform run should be launched from
already-uploaded assets. It calls `benchmax.platform.client.TrainerClient`:

Before launching, run the safe readiness gate:

```bash
python3 demo/castform/check_castform_readiness.py \
  --env-cls-path envs/.../env-cls.pkl \
  --env-metadata-path envs/.../env-metadata.json \
  --train-dataset-path datasets/.../train.jsonl \
  --eval-dataset-path datasets/.../eval.jsonl
```

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

No-secret bridge coverage:

```bash
python3 demo/castform/run_castform_bridge_smoke.py
python3 demo/castform/run_castform_sdk_e2e_smoke.py
```

The smoke command runs the same bridge CLI against a temporary fake
`benchmax.platform.client.TrainerClient`, verifies the uploaded asset paths,
launcher args, API-key plumbing, returned Castform run ID, and output file, and
does not persist the fake SDK key. The SDK E2E smoke goes further: it launches
through the fake Benchmax SDK, mirrors fake Castform scalars, events, and logs
through `castform_instantml_adapter.py` and the real InstantML SDK into a fake
InstantML API, then reuses that mirrored run to create iframe sessions and
browser-verify the parent page.

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

Before live keys or a tunnel are available, use `run_mocked_e2e.py` to exercise
the real hosted writer against a fake local InstantML API:

```bash
python3 demo/castform/run_mocked_e2e.py
```

This starts a fake API, runs `run_demo.py`, records SDK traffic, creates mock
embed sessions, reruns `run_demo.py --instantml-run-id` against the mock run
IDs without increasing the run count, serves the parent page, verifies generated
artifacts, and runs desktop/mobile browser checks. It proves the SDK-write ->
embed-manifest -> parent-page loop and the existing-run recovery command without
production credentials.

For a lighter parent-page-only check, use `run_local_smoke.py`:

```bash
python3 demo/castform/run_local_smoke.py
```

This proves the Castform parent page loads, displays run cards, switches iframe
tabs, refreshes the manifest, and keeps `instantml_embed_...` tokens out of
visible text at desktop and mobile viewports. It does not replace the final
hosted check because the local smoke uses `about:blank` iframe targets instead
of live InstantML iframe content.

## Real Local InstantML Iframe Path

Use `run_local_real_iframe_e2e.py` when hosted iframes are unavailable or when a
pre-call proof should avoid live secrets:

```bash
python3 demo/castform/run_local_real_iframe_e2e.py \
  --runs 3 \
  --steps 40 \
  --step-size 10 \
  --timeout 180
```

This starts an isolated local stack:

- Rust API through `npm run dev:api` with embed routes enabled.
- Local ClickHouse on free ports and ignored temporary state.
- Next embed app from `apps/web` with explicit local API bases.
- Castform parent page on a free loopback port.

The runner then mints a disposable local API key, runs `run_demo.py` through the
real Python SDK, creates real local embed sessions, runs `verify_demo.py`, reruns
`run_demo.py --instantml-run-id` against the same run IDs, verifies the local run
count is unchanged, and uses `browser_verify.mjs --require-iframe-content` at
`1366x900` and `390x844`. The browser check requires `INSTANTML EMBED`, `Run
metrics`, plotted/latest metric text, visible iframe sizing, tab switching,
refresh behavior, and at least one rendered InstantML panel element inside the
iframe. The ignored report is written to
`run-output/local-real-iframe-e2e-report.json`.

With `--keep-running`, the runner writes the verified report before it waits and
keeps the local API, local InstantML web app, and Castform parent page alive for
screen sharing until Ctrl-C.

Do not run another `next dev` for `apps/web` while this command is running.
Next holds an app-directory dev lock even when different ports are used.

## Verification

Minimum checks before a commit:

```bash
python3 -m py_compile demo/castform/demo_env.py demo/castform/run_demo.py demo/castform/castform_live_bridge.py demo/castform/verify_demo.py demo/castform/castform_instantml_adapter.py demo/castform/seed_castform_demo.py demo/castform/create_smoke_manifest.py demo/castform/run_local_smoke.py demo/castform/check_hosted_readiness.py demo/castform/check_castform_readiness.py demo/castform/run_mocked_e2e.py demo/castform/run_local_real_iframe_e2e.py demo/castform/run_call_prep_check.py
node --check demo/castform/web/app.js
node --check demo/castform/browser_verify.mjs
python3 demo/castform/run_call_prep_check.py --full
# With live InstantML key/.env installed:
python3 demo/castform/run_call_prep_check.py --full --live
git diff --check
```

Full local demo check:

1. obtain a live InstantML API key in Chrome and export it only in the shell
   running the demo;
2. start the Castform parent page locally;
3. expose it through an HTTPS tunnel and pass that origin as `--parent-origin`;
4. run `python3 demo/castform/check_hosted_readiness.py --parent-origin
   <https-origin> --parent-url <https-origin>`;
5. run `python3 demo/castform/run_demo.py --parent-origin <https-origin>`;
6. open the HTTPS parent page in Chrome and confirm either hosted iframe content
   loads, when hosted embed routes are deployed, or the explicit blocked-embed
   state from `live-hosted-status.md` appears.

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
