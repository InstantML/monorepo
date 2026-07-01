# Castform Live Hosted Status

Status date: 2026-07-01.

## Live Data Written

The production InstantML project `castform-live-demo` was created in workspace
`InstantML Warehouse` and populated through the real InstantML SDK using the
Castform-shaped fallback trainer.

Latest verified production run IDs:

- `a0c53fce-5351-476b-bd63-537c6ce442be`
- `01fff006-b7e6-4329-9d6d-c32b44eb4d3c`
- `b9a7b17a-8e37-4bec-9ae2-9ea4a9bba429`
- `a51f74e9-1077-4587-87ad-9d678002aa49`
- `1ddca3ef-fd24-4032-a95b-1d77f1c4b8aa`

Verified live write summary:

- Project: `castform-live-demo`
- Runs: `5`
- Logged step events: `25` per run (`0..240` by `10`)
- Scalar metrics per event: `16`
- Best final `eval/reward_mean`: `0.779903`
- Hosted embed sessions: `0`, blocked by missing `/api/embed/sessions`

The local live manifest at `web/public/demo-manifest.json` is generated and
ignored by Git. It contains these run IDs and the live metric evidence, but no
API key and no embed token. The latest ignored evidence files are
`run-output/live-generated-summary.json`,
`run-output/live-generated-blocked-smoke-summary.json`, and
`run-output/live-generated-blocked-smoke-report.json`.

## Hosted Iframe Blocker

The run writer successfully created production runs, then failed to create
hosted iframe sessions:

```text
POST https://api.instantml.ai/api/embed/sessions -> 404 {"error":"route not found"}
POST https://instantml.ai/api/embed/sessions -> 404 {"error":"route not found"}
POST https://staging.api.instantml.ai/api/embed/sessions -> 404 {"error":"route not found"}
```

Additional verification:

- `https://api.instantml.ai/openapi.json` has no embed paths.
- `https://staging.api.instantml.ai/openapi.json` has no embed paths.
- `https://instantml.ai/dashboard/runs` sends `frame-ancestors 'none'` and
  `X-Frame-Options: SAMEORIGIN`, so dashboard pages cannot be used as a real
  iframe fallback.

Conclusion: the live data side is complete, but persistent hosted iframes cannot
be minted until the embed API route is deployed/enabled in the hosted
environment.

## Local Iframe Proof

The full iframe integration was verified locally with real InstantML services:

```bash
python3 demo/castform/run_local_real_iframe_e2e.py \
  --runs 3 \
  --steps 40 \
  --step-size 10 \
  --timeout 180
```

The passing run started an isolated local Rust API, local ClickHouse, local Next
embed app, and Castform parent page; wrote 3 Castform-shaped runs; created 3
real local embed sessions; reused those same run IDs through
`run_demo.py --instantml-run-id` without increasing the run count; and verified
42 rendered iframe panel elements at both `1366x900` and `390x844`.

## Last Tunnel URL

The local parent page was previously exposed at:

```text
https://legends-cathedral-grey-broadcast.trycloudflare.com
```

That tunnel was a temporary call-prep URL and is not expected to remain active.
Start a fresh tunnel from `live-runbook.md` before any new hosted browser demo.
The generated page state rendered the live runs and an explicit blocked-embed
panel rather than stale mock iframe data.

## Recovery Path

After the hosted embed API is deployed/enabled, reuse the existing production
runs without duplicating data:

```bash
INSTANTML_API_KEY=... python3 demo/castform/run_demo.py \
  --parent-origin https://your-fresh-demo-origin.example \
  --project castform-live-demo \
  --allow-embed-blocked \
  --instantml-run-id a0c53fce-5351-476b-bd63-537c6ce442be \
  --instantml-run-id 01fff006-b7e6-4329-9d6d-c32b44eb4d3c \
  --instantml-run-id b9a7b17a-8e37-4bec-9ae2-9ea4a9bba429 \
  --instantml-run-id a51f74e9-1077-4587-87ad-9d678002aa49 \
  --instantml-run-id 1ddca3ef-fd24-4032-a95b-1d77f1c4b8aa
```

That command calls `GET /api/runs/summary` for those IDs and writes a new
manifest for the parent page. With hosted embed routes still absent,
`--allow-embed-blocked` produces the blocked live-data page instead of
duplicating runs; after the route is deployed it mints fresh embed sessions.
