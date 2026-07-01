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

## 1. Start The Parent Page

Optional preflight before live credentials:

```bash
python3 demo/castform/run_local_smoke.py
```

If port 5174 is already in use, pass `--port 0` to pick a free local port for
the preflight.

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

## 3. Create A Live API Key

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

## 4. Write Hosted Runs And Iframes

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
  --runs 5 \
  --steps 240
```

The runner writes:

- `web/public/demo-manifest.json`: live iframe URLs with bearer fragments,
  ignored by Git;
- `run-output/latest-summary.json`: redacted review summary, ignored by Git.

## 5. Verify Generated Artifacts

```bash
python3 demo/castform/verify_demo.py \
  --parent-url https://your-demo-origin.example
```

The verifier must report run/session counts and `redacted_summary=ok`. It fails
if the parent URL is still behind a localtunnel warning page.

## 6. Browser Check

Run the automated parent-page check against the HTTPS origin:

```bash
node demo/castform/browser_verify.mjs \
  --url https://your-demo-origin.example \
  --expect-runs 5 \
  --expect-sessions 3
```

Open the HTTPS parent origin in Chrome and verify:

- the Castform parent page loads from the exact HTTPS origin;
- no live `instantml_embed_...` token text is visible in the page;
- the InstantML iframe renders run charts;
- the tabs switch between `All Castform candidates`, `Best vs overfit`, and
  `Best vs verbose regression`;
- the InstantML dashboard project `castform-live-demo` lists the created runs.

## 7. Cleanup

After the call, revoke the demo API key from `https://instantml.ai/dashboard/api`
unless the key is intentionally retained for more partner prep.
