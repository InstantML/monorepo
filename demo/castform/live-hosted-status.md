# Castform Live Hosted Status

Status date: 2026-07-01.

## Live Data Written

The production InstantML project `castform-live-demo` was created in workspace
`InstantML Warehouse` and populated through the real InstantML SDK using the
Castform-shaped fallback trainer.

Verified production run IDs:

- `80aa6afb-4003-4756-bffc-591c541a332d`
- `a2f80903-ddf8-4e84-a4dc-297480144093`
- `46d776c3-8061-44a0-9ce5-27a9cf3ab85b`
- `2abdb990-1305-47ee-be70-c0716ac0f1c4`

Verified production summary:

- Project: `castform-live-demo`
- Runs: `4`
- Metric points: `576`
- Active runs: `0`
- Failed runs: `0`
- Best `eval/reward_mean`: `0.7989583424106731`

The local live manifest at `web/public/demo-manifest.json` is generated and
ignored by Git. It contains these run IDs and the live metric evidence, but no
API key and no embed token.

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
  --instantml-run-id 80aa6afb-4003-4756-bffc-591c541a332d \
  --instantml-run-id a2f80903-ddf8-4e84-a4dc-297480144093 \
  --instantml-run-id 46d776c3-8061-44a0-9ce5-27a9cf3ab85b \
  --instantml-run-id 2abdb990-1305-47ee-be70-c0716ac0f1c4
```

That command calls `GET /api/runs/summary` for those IDs, mints fresh embed
sessions, and writes a new manifest for the parent page.
