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

## Current Demo URL

The local parent page was exposed at:

```text
https://legends-cathedral-grey-broadcast.trycloudflare.com
```

The page now renders the live runs and an explicit blocked-embed panel rather
than stale mock iframe data.

## Recovery Path

After the hosted embed API is deployed/enabled, rerun:

```bash
INSTANTML_API_KEY=... python3 demo/castform/run_demo.py \
  --parent-origin https://legends-cathedral-grey-broadcast.trycloudflare.com \
  --project castform-live-demo \
  --runs 4 \
  --steps 160 \
  --step-size 20
```

That command will write a fresh set of runs and create iframe sessions. To avoid
creating duplicate runs, add a small resume helper that calls
`POST /api/embed/sessions` for the run IDs above and then writes the manifest.
