# Admin App

This directory contains the separate Next/React internal operator console for
InstantML. It is read-only in the first slice and renders the Rust
`GET /api/admin/overview` response.

The app is intentionally not linked from `apps/web` or the public landing page.
Deploy it only on an internal URL, such as an admin-only host or path.

## Purpose

- Inspect all projected users, organizations, API keys, billing posture, storage
  state, tenant-route status, and risk items.
- Help operators and support correlate safe IDs and metadata before using
  existing operational tools.
- Keep bootstrap-token use server-side; the browser never receives the token.
- Require Clerk sign-in from an allowlisted admin email before any admin data is
  fetched. The default allowlist currently contains only `instantml.ai@gmail.com`.

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
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_... \
CLERK_SECRET_KEY=sk_... \
INSTANTML_ADMIN_ALLOWED_EMAILS=instantml.ai@gmail.com \
INSTANTML_ADMIN_API_BASE=http://127.0.0.1:8000 \
INSTANTML_ADMIN_BOOTSTRAP_TOKEN=local-admin-token \
npm run admin:dev
```

Open `http://127.0.0.1:3001`.

Use Clerk development keys for plain localhost testing. Clerk production keys
are restricted to HTTPS hosts under the configured production domain, so the
admin app shows a setup message instead of a sign-in button when a `pk_live_`
key is used on `http://localhost` or `http://127.0.0.1`.

## Common Commands

From the repo root:

```bash
npm run admin:dev
npm run admin:build
npm run admin:start
npm run test:node
```

From `apps/admin`, for deploy platforms that use this directory as the project
root:

```bash
npm run dev
npm run build
npm run start
npm run test
```

## Vercel Deployment

Create a separate Vercel project for the same repository and set Root Directory
to `apps/admin`. The app-local `vercel.json` in this directory pins the Vercel
settings, so the dashboard may show these fields as read-only repo-managed
values:

```text
Install Command: npm install
Build Command: npm run build
Development Command: npm run dev
Output Directory: .next
```

If the admin Vercel project still shows the root web build command
`cd apps/web && ...`, redeploy from a commit that includes
`apps/admin/vercel.json` and confirm the project's Root Directory is
`apps/admin`.

Configure production environment variables on that Vercel project:

```text
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
INSTANTML_ADMIN_ALLOWED_EMAILS
INSTANTML_ADMIN_API_BASE
INSTANTML_ADMIN_BOOTSTRAP_TOKEN
```

Set `INSTANTML_ADMIN_ALLOWED_EMAILS=instantml.ai@gmail.com` for the current
first slice and add the custom domain `admin.instantml.ai`.

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

## Access Control

Admin access is two-layered:

- The human viewer must have a verified Clerk primary email on
  `INSTANTML_ADMIN_ALLOWED_EMAILS`. When unset, the allowlist defaults to
  `instantml.ai@gmail.com`.
- The Next server must have `INSTANTML_ADMIN_BOOTSTRAP_TOKEN` or
  `INSTANTML_BOOTSTRAP_TOKEN` so it can call the Rust admin API. This token is
  never sent to client components or browser routes.

This is a temporary first slice. Do not expose the app publicly without an
additional edge gate such as Cloudflare Access or IAP, and do not add broader
admin roles or mutation controls without a new design doc.

## Coverage Expectations

Keep meaningful first-party logic covered. The current covered logic lives in
`src/view-model.mjs`. Server rendering and layout are verified through build
checks and Chrome/Computer Use smoke until the app gains mutation flows or more
complex route state.

## Key Files

- `app/page.tsx`: server entry point and setup/error state.
- `app/access-panel.tsx`: Clerk sign-in and deny/setup states for the hidden
  admin URL.
- `proxy.ts`: Clerk request proxy required for server-side admin viewer checks.
- `vercel.json`: app-local Vercel settings for the separate admin project.
- `src/admin-auth.mjs`: temporary admin email allowlist helpers.
- `src/admin-data.ts`: server-only overview fetch using the bootstrap token.
- `src/admin-console.tsx`: interactive client console for tabs, selected orgs,
  tables, detail panels, and queues.
- `src/logo-mark.tsx`: InstantML dot-grid logo mark used by admin chrome and
  setup/error states.
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
