# Design: Staging Cloud Run Environment And Public Router

Date: 2026-05-22

Status: Accepted first slice

Owner: Codex

## Summary

Production currently uses `api.instantml.ai` as a Google global HTTPS load
balancer, not as a custom application proxy. The load balancer terminates TLS
and routes by path to two Cloud Run serverless NEGs:

- control paths to `instantml-control`
- all other paths to `instantml-data-us-central1-a`

That shape is correct for the current single data-cell deployment, but the
router contract was incomplete: `/api/billing/*`,
`/api/dashboard/preferences`, and `/api/workspace-views*` are control-plane
routes in Rust but were not present in the URL map. The backend service timeout
also remained at the Google default `30s`, while Cloud Run and the Rust request
timeout are configured for longer hosted operations.

This slice fixes the production router contract and adds an isolated staging
deployment target:

- `api.instantml.ai` remains production.
- `staging.api.instantml.ai` points to separate staging Cloud Run control/data
  services and a separate staging HTTPS load balancer.
- Staging uses separate Secret Manager secret names and a separate User Data
  ClickHouse database path by default.

## Goals

- Keep production and staging Cloud Run services from overwriting each other.
- Keep production and staging public-router resources from overwriting each
  other.
- Route every implemented control-plane API path to the control service.
- Align public-router backend service timeout with Cloud Run/Rust request
  timeout.
- Make staging deployable with one command for local/frontend/API tests.

## Non-Goals

- Do not build a tenant-aware application proxy in this slice.
- Do not add multi-region or multi-cell tenant routing.
- Do not create a separate ClickHouse Cloud account or provider project.
- Do not expose HTTP port 80.

## Proposed Design

### Production Router

Production keeps these resources:

- forwarding rule: `instantml-public-api-https`
- URL map: `instantml-public-api`
- control backend: `instantml-public-api-control`
- data backend: `instantml-public-api-data`
- certificate: `instantml-public-api-cert`
- address: `instantml-public-api-ip`

The URL map defaults to the data backend and sends these prefixes/exact paths to
control:

- `/api/auth`, `/api/auth/*`
- `/api/billing`, `/api/billing/*`
- `/api/dashboard/preferences`
- `/api/users`, `/api/users/*`
- `/api/orgs`, `/api/orgs/*`
- `/api/workspace-views`, `/api/workspace-views/*`

### Staging Router

The staging command is:

```bash
npm run deploy:cloud-run:staging
```

It expands to:

```bash
node tools/deploy-cloud-run.mjs --topology=split --environment=staging --public-router
```

Staging defaults:

- service prefix: `instantml-staging`
- control service: `instantml-staging-control`
- data service: `instantml-staging-data-us-central1-a`
- router resource prefix: `instantml-staging-public-api`
- domain: `staging.api.instantml.ai`
- Secret Manager prefix: `instantml-staging-`
- User Data database: `instantml_user_data_staging`

Staging reuses the same GCP project, Artifact Registry, runtime service account,
VPC connector path, Cloud NAT static egress IP, and ClickHouse Cloud API
credentials. It does not reuse production Secret Manager secret names. By
default, the staging User Data endpoint is the same ClickHouse service host as
production with the database path changed to `instantml_user_data_staging`.
Tenant warehouses created from staging signups remain real ClickHouse Cloud
services, so operators should treat staging tests as live-cost operations.

### Timeout Alignment

The deploy helper updates each public-router backend service with
`INSTANTML_CLOUD_RUN_BACKEND_TIMEOUT_SECONDS`, falling back to
`INSTANTML_CLOUD_RUN_TIMEOUT`, then `INSTANTML_REQUEST_TIMEOUT_SECONDS`, then
`900`.

This keeps the Google HTTPS load balancer from returning a `30s` timeout while
Cloud Run and Rust are still legitimately processing provisioning/import
requests.

## Failure Modes

- If staging DNS does not point at the reserved global IP yet, deploy returns a
  pending router object and writes direct staging Cloud Run URLs locally.
- If the managed certificate is not active yet, deploy returns
  `pending-certificate`; rerun the staging deploy after DNS propagates.
- If an operator deploys staging without isolated secret names, staging could
  read production User Data. The helper avoids this by defaulting to scoped
  secret names outside prod.
- If Cloudflare DNS cannot be updated by API, the staging A record must be added
  through the Cloudflare dashboard.

## Verification

- Deploy helper tests assert staging defaults, scoped secrets, complete control
  URL-map paths, and backend timeout configuration.
- Rust OpenAPI filtering now treats `/api/billing/*` as control-plane paths.
- Live verification should check:
  - `https://api.instantml.ai/api/auth/config` reports `control`
  - `https://api.instantml.ai/openapi.json` reports `data`
  - control-only paths return control-plane auth errors rather than data-plane
    404s
  - `https://staging.api.instantml.ai/api/auth/config` reports `control`
  - `https://staging.api.instantml.ai/openapi.json` reports `data`

## Review Notes

- Fresh sub-agent review was not spawned because the active tool policy only
  permits sub-agents when the user explicitly asks for them. This document keeps
  the accepted slice narrow and the implementation is verified through deploy
  helper tests plus live GCP checks.

