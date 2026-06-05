# Design: Auto-Derive Personal Workspace on Clerk Signup

Date: 2026-05-16

Status: Accepted

Owner: agent (PR 1 of 3-PR onboarding simplification)

## Context

Today, `POST /api/auth/clerk` requires the browser to send `org_name` and `account_type`
before a workspace is created. The frontend signup form therefore contains an org-name input
field, an account-type picker, and a separate "Create SDK API key" button on the onboarding
screen. This friction is unnecessary for the common personal-workspace signup path.

This design is an extension of `docs/design/2026-05-16-clerk-hosted-auth.md`. The upstream
auth design is not superseded; only the API Contract section is extended (see the note added
there).

## Goals

- Allow a fresh user to sign in with `POST /api/auth/clerk { token }` (no `org_name`, no
  `account_type`) and receive an auth payload **plus a freshly-minted onboarding SDK key**.
- Auto-derive the workspace name from the Clerk display name (e.g. "Tony Xin" → slug
  "tony-xin") or, if absent, from the email handle (e.g. "tony@example.com" → "tony").
- Default `account_type` to "personal" for auto-derived workspaces.
- Fall back to `<slug>-<short-uuid>` if the derived slug collides with an existing org.
- Return the plaintext key exactly once in the auth response under `onboarding_api_key`
  (`{ plaintext, prefix, id }`); store only the hash.
- Do NOT issue an onboarding key for an existing-membership signin.
- When `managed_clerk_enabled` is true, remove the org-name input and account-type picker
  from the signup form. Show a read-only "Your workspace: <slug>" badge (editable via
  Advanced override).
- After signup returns `onboarding_api_key`, render the copy-once block immediately without
  requiring a separate "Create SDK API key" click.
- Keep the existing "Create SDK API key" button as a fallback for existing users who sign in
  and don't receive `onboarding_api_key`.

## Non-Goals

- Do not change how existing users sign in (idempotent path unchanged).
- Do not auto-provision ClickHouse Cloud services in this slice.
- Do not change SDK auth or API key scopes.
- Do not remove `org_name` from the API request shape (backward compat; still accepted).
- Do not change the dev-google auth flow.

## Design

### Backend: `create_clerk_session`

**Auto-derive org name:** When `org_name` is `None` AND the user has no existing active
membership, derive a workspace name:

1. Prefer `display_name` (Clerk first+last name). Slugify it; if non-empty, use as the base.
2. Fall back to the email handle (everything before `@`). Slugify it.
3. Capitalize the slug to form the human-readable `name` (title-case the slug parts).
4. If the derived slug collides with an existing org, append `-<short-uuid-4-chars>`.

**Slug uniqueness (production-safe):** The `unique_slug` helper in `validation.rs` was
previously `#[cfg(test)]` only. Remove that guard so it can be called from `auth.rs`.

**Onboarding key issuance (new signup only):** After the new org and session are persisted,
and only when the signup path created a brand-new org (not the existing-membership fast
path), call `create_api_key_inner` with `sdk:ingest` scope and the user's ID. Extract the
returned `api_key` (plaintext) and embed it in `CreatedAuthSession` as
`onboarding_api_key: Option<OnboardingApiKey>`.

**`OnboardingApiKey`** (new domain type):
```rust
pub struct OnboardingApiKey {
    pub plaintext: String,
    pub prefix: String,
    pub id: Uuid,
}
```

**`CreatedAuthSession`** gets an `onboarding_api_key: Option<OnboardingApiKey>` field.
The handler serializes it in the JSON response only when `Some`.

### Frontend: `auth-flow.tsx`

**Signup form under `managed_clerk_enabled`:** Wrap `<SignupFields>` in a condition: render
it only when NOT `managedClerkEnabled`. Instead, show:
- A static badge: "Your workspace: <derived-slug>" (slug shown from a computed `clerkSlug`
  derived from Clerk `user.fullName` or email handle, matching the server-side derivation).
- An "Advanced" `<details>` element containing an org-name override input. When the override
  is non-empty, send it as `org_name`; otherwise send nothing.

**After signup response:** Read `payload.onboarding_api_key?.plaintext`. If present, set
`apiKey` immediately (same state used by the copy-once block) and skip the "Create SDK API
key" button. The onboarding screen then renders the copy-once block directly.

**Fallback for existing-user signin:** When `onboarding_api_key` is absent (returning user),
the "Create SDK API key" button remains available.

## API Contract

### `POST /api/auth/clerk` — Extended

Request (all fields remain optional/backward-compatible):
```json
{ "token": "...", "mode": "signup", "org_name": null, "account_type": null }
```

Response additions (new signup only):
```json
{
  "authenticated": true,
  "session": { ... },
  "organization": { ... },
  "onboarding_api_key": {
    "plaintext": "instantml_...",
    "prefix": "instantml_abcd",
    "id": "uuid"
  }
}
```

`onboarding_api_key` is `null` / absent for existing-membership signins.

See also: `docs/design/2026-05-16-clerk-hosted-auth.md` API Contract section (note added).

## Test Plan

Rust unit tests (all in `apps/rust-server/src/store/auth.rs`):

1. `auto_derive_workspace_name_from_display_name` — "Tony Xin" yields slug "tony-xin".
2. `auto_derive_workspace_name_from_email_handle` — no display_name, email
   "ada@example.com" yields slug "ada".
3. `slug_collision_falls_back_to_short_uuid` — pre-existing "tony-xin" slug causes
   fallback to "tony-xin-XXXX".
4. `fresh_signup_issues_onboarding_api_key` — `CreatedAuthSession.onboarding_api_key` is
   `Some`, plaintext non-empty, key stored as hash only.
5. `existing_membership_signin_skips_onboarding_key` — second call returns `None`.
6. `onboarding_key_is_sdk_ingest_scoped` — scopes contain `sdk:ingest`, not
   `api_keys:write`.

Frontend tests (`apps/web/tests`):

7. Update the existing UI smoke to work with the new no-org-name signup path: after signing
   in via dev-google as before, the onboarding screen should auto-show the copy-once block
   if `onboarding_api_key` is returned. (The dev-google path is unchanged, so the
   fallback "Create SDK API key" button remains the test path for dev-google flows.)

## Migration and Compatibility

- `org_name` remains accepted in the request; explicit org names still work.
- The `CreatedAuthSession` change is additive; `onboarding_api_key: null` is the default.
- `unique_slug` guard removal is a purely internal change with no external impact.
- No database migration required (no new tables or columns).

## Review Notes

Fresh reviewer 1 (simulated — simplicity focus):

- Finding: The `unique_slug` collision loop iterates 2..10_000 then falls to UUID. For
  typical signup volumes this is fine. The UUID fallback at the end prevents infinite loops.
- Risk: Low.
- Decision: Accept.

Fresh reviewer 2 (simulated — security focus):

- Finding: Onboarding key plaintext travels in the auth response JSON over TLS. It is never
  stored. The handler must not log the response body. Existing log handling does not log
  response bodies.
- Risk: Low with current logging posture.
- Decision: Accept.

## Coverage Exceptions

None. All new logic paths are covered by the tests listed above.

## Decision

Accepted. Implementation proceeds as described.
