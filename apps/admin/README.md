# Admin App

This directory contains the separate Next/React internal operator console for
InstantML. It is read-only in the first slice and renders the Rust
`GET /api/admin/overview` response.

## Purpose

- Inspect all projected users, organizations, API keys, billing posture, storage
  state, tenant-route status, and risk items.
- Help operators and support correlate safe IDs and metadata before using
  existing operational tools.
- Keep bootstrap-token use server-side; the browser never receives the token.

## Local Setup

Install root dependencies first:

```bash
npm ci
```

Start the Rust API with a bootstrap token:

```bash
INSTANTML_AUTH_MODE=api-key \
INSTANTML_BOOTSTRAP_TOKEN=local-admin-token \
npm run dev:api
```

Start the admin app in another terminal:

```bash
INSTANTML_ADMIN_API_BASE=http://127.0.0.1:8000 \
INSTANTML_ADMIN_BOOTSTRAP_TOKEN=local-admin-token \
npm run admin:dev
```

Open `http://127.0.0.1:3001`.

## Common Commands

From the repo root:

```bash
npm run admin:dev
npm run admin:build
npm run admin:start
npm run test:node
```

## Testing Commands

Admin-specific helper tests are included in the root Node test suite:

```bash
node --test apps/admin/tests/*.test.js
```

The first slice should also pass:

```bash
npm run admin:build
npm run verify:api-types
```

## Observability

`src/admin-data.ts` is the admin app's server-only Rust API boundary. It adds a
safe `x-request-id` to `GET /api/admin/overview`, includes that request ID in
operator-facing failure messages, and writes a server-side
`instantml_admin_api_request` event with method, redacted route path, status,
duration, code, retryability, and trace/request ID. Do not log the bootstrap
token, full URL/query string, raw API response body, user emails, API-key
plaintext, tenant credentials, or provider error text from the admin app.

## Coverage Expectations

Keep meaningful first-party logic covered. The current covered logic lives in
`src/view-model.mjs`. Server rendering and layout are verified through build
checks and Chrome/Computer Use smoke until the app gains mutation flows or more
complex route state.

## Key Files

- `app/page.tsx`: server entry point and setup/error state.
- `src/admin-data.ts`: server-only overview fetch using the bootstrap token.
- `src/admin-console.tsx`: interactive client console for tabs, selected orgs,
  tables, detail panels, and queues.
- `src/view-model.mjs`: formatting and tone helpers covered by Node tests.
- `app/globals.css`: app-specific visual system.

## Design Docs

- `docs/design/2026-05-24-admin-operator-app.md`

## Notes For Future Agents

- Do not add mutation controls without a new design doc and review.
- Do not send the bootstrap token to client components or browser routes.
- Do not expose API-key plaintext, API-key hashes, session tokens, tenant
  passwords, password references, signed URLs, or raw provider error text.
- Keep list endpoints bounded before increasing admin data volume.
