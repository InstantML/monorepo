# Castform Hosted Demo Runbook

This runbook is the operator path for the call demo. It assumes the code in this
directory is already committed and that live secrets will stay in the local shell
only.

## Preconditions

- Chrome is signed into the InstantML workspace that should own the demo data.
- A live InstantML API key can be created with at least `sdk:ingest` and
  `export:read`.
- An HTTPS parent origin is available for the local Castform page. Hosted
  InstantML embeds reject plain loopback HTTP origins.
- As of 2026-07-01, production writes to `castform-live-demo` work, but hosted
  embed-session routes are not deployed. Use the local real iframe E2E below to
  show the complete iframe integration until production embed routes are live.

## 1. Start The Parent Page

Optional preflight before live credentials:

```bash
python3 demo/castform/run_call_prep_check.py --full
python3 demo/castform/check_castform_readiness.py \
  --allow-missing-live-inputs \
  --skip-network
python3 demo/castform/run_castform_bridge_smoke.py
python3 demo/castform/run_castform_sdk_e2e_smoke.py
python3 demo/castform/run_mocked_e2e.py
python3 demo/castform/run_local_smoke.py
python3 demo/castform/run_local_real_iframe_e2e.py \
  --runs 3 \
  --steps 40 \
  --step-size 10 \
  --timeout 180
```

If port 5174 is already in use, pass `--port 0` to pick a free local port for
the lightweight smoke preflight.

`run_call_prep_check.py --full` is the walk-up gate for the demo: it runs the
safe Castform readiness dry check, mocked InstantML recovery rehearsal,
parent-page smoke, and full local real iframe E2E. `check_castform_readiness.py`
is the safe live-Castform preflight by itself: it checks SDK importability,
Castform API-key presence, uploaded asset arguments, and optional Castform app
reachability without printing secrets. `run_castform_bridge_smoke.py` runs the
live bridge CLI against a temporary fake Benchmax SDK so the
`TrainerClient.launch_training_run(...)` call shape is covered without real
Castform credentials. `run_castform_sdk_e2e_smoke.py` stitches the fake
Benchmax launch and fake Castform run-read API into the real mirror adapter,
real InstantML SDK, fake InstantML API, parent page, and browser verifier.
`run_mocked_e2e.py` is the stronger
InstantML rehearsal: it executes the real hosted writer against a fake local
InstantML API, verifies the existing-run recovery command, and browser-tests the
generated page.
`run_local_smoke.py` is the lighter parent-page smoke. `run_local_real_iframe_e2e.py`
is the complete no-secret proof: it starts a local Rust API, local ClickHouse,
the local Next embed app, and the parent page; writes Castform-shaped runs
through the SDK; creates real local embed sessions; and checks iframe panels at
desktop and mobile viewports. It writes ignored desktop/mobile screenshots to
`run-output/local-real-iframe-screenshots/`. Do not run another `next dev` for
`apps/web` at the same time.

If a live InstantML API key is already exported and the goal is to rehearse the
current production persisted-data page without duplicating runs, use:

```bash
python3 demo/castform/run_live_blocked_smoke.py
```

That command reads the existing `castform-live-demo` run IDs, handles the
current hosted `/api/embed/sessions` 404 as an expected blocked state, serves
the parent page on a free local port, and runs desktop plus mobile browser
checks. Pass `--parent-origin https://your-demo-origin.example` if you already
have a tunnel and want the generated manifest to match that origin.

For the live hosted path, start or keep the parent page server running:

```bash
python3 demo/castform/serve_web.py --port 5174
```

Open `http://127.0.0.1:5174` locally to confirm the empty state renders.

## 2. Start An HTTPS Tunnel

Any HTTPS tunnel works as long as the browser can load the Castform parent page
from the tunnel origin without a warning or interstitial.

Localtunnel can be used for a quick smoke:

```bash
npx --yes localtunnel --port 5174 --local-host 127.0.0.1
```

If localtunnel shows its "Tunnel website ahead" page, clear it in Chrome before
using that origin for the final browser demo. A tunnel without an interstitial is
better for the call.

## 3. Dry Hosted Readiness Check

Before creating or exporting live secrets, confirm local dependencies, generated
path safety, parent-origin shape, and hosted API health:

```bash
python3 demo/castform/check_hosted_readiness.py \
  --allow-missing-live-inputs \
  --parent-origin https://your-demo-origin.example \
  --parent-url https://your-demo-origin.example
```

This command does not write to InstantML and does not print secrets. Missing
live keys should appear as warnings in this dry pass. The command also checks
whether hosted OpenAPI advertises `POST /api/embed/sessions`; while it is
absent, the check warns and the operator should use the blocked hosted mode or
local real iframe E2E.

## 4. Create A Live API Key

In Chrome:

1. Open `https://instantml.ai/dashboard/api`.
2. Create a key named `Castform live demo YYYY-MM-DD`.
3. Copy the key once.
4. Export it only in the shell that will run the demo:

   ```bash
   export INSTANTML_API_KEY=instantml_...
   ```

Do not paste the key into committed files, terminal history documents, or the
demo webpage.

After exporting the key, rerun the strict readiness gate:

```bash
python3 demo/castform/check_hosted_readiness.py \
  --parent-origin https://your-demo-origin.example \
  --parent-url https://your-demo-origin.example
```

When hosted embed routes are expected to be live, make that expectation strict:

```bash
python3 demo/castform/check_hosted_readiness.py \
  --parent-origin https://your-demo-origin.example \
  --parent-url https://your-demo-origin.example \
  --require-hosted-embeds
```

## 5. Write Hosted Runs And Iframes

### Option A: Mirror A Real Castform Run

If Castform credentials and a shared run are available, mirror the live run
directly:

```bash
CASTFORM_API_KEY=... \
INSTANTML_API_KEY=... \
python3 demo/castform/run_demo.py \
  --castform-run-id <castform-run-id> \
  --parent-origin https://your-demo-origin.example \
  --project castform-live-demo
```

### Option B: Launch Through The Benchmax SDK First

If uploaded Castform assets are available, launch with the SDK bridge, then
mirror the returned run ID:

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

Then run Option A with the printed `castform_run_id`.

### Option C: Deterministic Call-Prep Fallback

Use the HTTPS tunnel origin as `--parent-origin`:

```bash
python3 demo/castform/run_demo.py \
  --parent-origin https://your-demo-origin.example \
  --project castform-live-demo \
  --allow-embed-blocked \
  --runs 5 \
  --steps 240
```

### Option D: Reuse Existing InstantML Runs

After hosted embed routes are deployed, reuse already-written production runs
without creating duplicates:

```bash
python3 demo/castform/run_demo.py \
  --parent-origin https://your-demo-origin.example \
  --project castform-live-demo \
  --allow-embed-blocked \
  --instantml-run-id 80aa6afb-4003-4756-bffc-591c541a332d \
  --instantml-run-id a2f80903-ddf8-4e84-a4dc-297480144093 \
  --instantml-run-id 46d776c3-8061-44a0-9ce5-27a9cf3ab85b \
  --instantml-run-id 2abdb990-1305-47ee-be70-c0716ac0f1c4
```

This reads run summaries from InstantML, reconstructs the local manifest cards,
and only creates iframe sessions. While hosted embed routes still return 404,
`--allow-embed-blocked` writes a blocked-state manifest with the persisted run
cards and no iframe tokens; after the route is deployed, the same command mints
real hosted sessions.

The runner writes:

- `web/public/demo-manifest.json`: live iframe URLs with bearer fragments,
  ignored by Git;
- `run-output/latest-summary.json`: redacted review summary, ignored by Git.

## 6. Verify Generated Artifacts

```bash
python3 demo/castform/verify_demo.py \
  --parent-url https://your-demo-origin.example \
  --allow-blocked-embeds
```

The verifier must report run/session counts and `redacted_summary=ok`. It fails
if the parent URL is still behind a localtunnel warning page. In the current
blocked hosted state it reports `embed_status=blocked` and `blocked_summary=ok`
instead of session counts.

## 7. Browser Check

Run the automated parent-page check against the HTTPS origin:

```bash
node demo/castform/browser_verify.mjs \
  --url https://your-demo-origin.example \
  --expect-runs 4 \
  --expect-sessions 3
```

If production run data exists but hosted embed sessions are not deployed, verify
the explicit blocked state instead. The one-command local rehearsal is:

```bash
python3 demo/castform/run_live_blocked_smoke.py \
  --parent-origin https://your-demo-origin.example
```

For a parent page that is already served at the HTTPS origin, the direct browser
check is:

```bash
node demo/castform/browser_verify.mjs \
  --url https://your-demo-origin.example \
  --expect-runs 4 \
  --expect-sessions 0 \
  --allow-blocked-embeds
```

For the local real iframe E2E, the runner already invokes the stricter browser
check:

```bash
node demo/castform/browser_verify.mjs \
  --url http://127.0.0.1:<parent-port> \
  --expect-runs 3 \
  --expect-sessions 3 \
  --require-iframe-content
```

Open the HTTPS parent origin in Chrome and verify:

- the Castform parent page loads from the exact HTTPS origin;
- no live `instantml_embed_...` token text is visible in the page;
- the InstantML iframe renders run charts, or the page shows the explicit
  hosted embed deployment blocker from `live-hosted-status.md`;
- the tabs switch between `All Castform candidates`, `Best vs overfit`, and
  `Best vs verbose regression` when iframe sessions exist;
- the InstantML dashboard project `castform-live-demo` lists the created runs.

## 8. Cleanup

After the call, revoke the demo API key from `https://instantml.ai/dashboard/api`
unless the key is intentionally retained for more partner prep.
