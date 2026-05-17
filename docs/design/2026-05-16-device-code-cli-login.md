# Design: Device-Code CLI Login (RFC 8628)

Date: 2026-05-16

Status: Accepted

Owner: agent

## Summary

New users must currently copy/paste an API key from the web dashboard into their terminal. This design adds an `instantml login` CLI command backed by the OAuth 2.0 Device Authorization Grant (RFC 8628). The user runs one command, confirms in the browser, and the SDK writes credentials automatically—no copy/paste required.

## Goals

- `instantml login` opens the browser, prints a human-readable user code, and polls until confirmed.
- On confirmation the SDK writes `~/.instantml/credentials` (mode 0600) with `api_key`, `api_host`, `org_id`, and `user_email`.
- `iml.init()` with no explicit key picks up the credentials file.
- `instantml logout` removes the credentials file.
- `instantml whoami` prints org/user from the credentials file.
- Existing `INSTANTML_API_KEY` env var path is unchanged.
- Non-interactive contexts print a clear actionable error.

## Non-Goals

- OAuth scopes negotiation or token refresh (the issued credential is a long-lived API key, not a short-lived OAuth token).
- Multi-org switching from the CLI in this slice.
- PKCE or confidential-client flows—device-code is the correct RFC for headless/CLI clients.
- Moving user/identity data into OAuth claims.

## RFC 8628 Mapping

| RFC term | InstantML term |
|---|---|
| Device Authorization Endpoint | `POST /api/auth/device-code/start` |
| Token Endpoint (poll) | `POST /api/auth/device-code/poll` |
| (no RFC term) | `POST /api/auth/device-code/confirm` (browser-side confirmation) |
| `device_code` | 32-byte URL-safe random opaque token |
| `user_code` | 8-char alphanumeric `ABCD-EFGH` (format for readability) |
| `verification_uri` | `https://<host>/auth/device` |
| `verification_uri_complete` | `https://<host>/auth/device?code=ABCD-EFGH` |
| `expires_in` | 900 seconds (15 min) |
| `interval` | 5 seconds |

The issued credential is an `sdk:ingest`-scoped API key, not an OAuth token. This intentionally separates device-code from the OAuth token lifecycle.

## API Contract

### POST /api/auth/device-code/start

No auth required.

Request body (optional):
```json
{ "client_info": { "name": "instantml-cli", "version": "0.1.0" } }
```

Response 200:
```json
{
  "device_code": "<opaque-64-char-token>",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://app.instantml.ai/auth/device",
  "verification_uri_complete": "https://app.instantml.ai/auth/device?code=ABCD-EFGH",
  "expires_in": 900,
  "interval": 5
}
```

### POST /api/auth/device-code/poll

No auth required. Honors polling interval; returns 429 with `"slow_down"` code if polled faster than `interval`.

Request body:
```json
{ "device_code": "<opaque-64-char-token>" }
```

Response 200 (pending):
```json
{ "status": "pending" }
```

Response 200 (authorized):
```json
{
  "status": "authorized",
  "api_key": { "plaintext": "instantml_...", "prefix": "instantml_XXXX", "id": "<uuid>" },
  "org": { "id": "<uuid>", "name": "Acme", "slug": "acme" },
  "user": { "primary_email": "user@example.com", "display_name": "Alice" }
}
```

Response 200 (denied or expired):
```json
{ "status": "denied" }
{ "status": "expired" }
```

Response 429 (slow down):
```json
{ "error": "slow_down", "interval": 5 }
```

The `api_key.plaintext` field is returned exactly once (on the first poll that sees `authorized`). Subsequent polls return `status: "expired"` because the record is immediately consumed.

### POST /api/auth/device-code/confirm

Requires `instantml_session` cookie (signed-in browser user).

Request body:
```json
{ "user_code": "ABCD-EFGH" }
```

Response 200:
```json
{ "confirmed": true }
```

Response 404: user_code not found or expired.
Response 409: user_code already confirmed or denied.

### GET /auth/device

Browser page (Next.js App Router). Gated to signed-in users via Clerk middleware. Accepts optional `?code=ABCD-EFGH` query param to pre-fill the input. Calls `POST /api/auth/device-code/confirm`. Displays success or error states. Shows "You can close this tab" on success.

## SDK CLI Contract

```
instantml login [--api-host URL]
instantml logout
instantml whoami
```

`login` flow:
1. `POST <host>/api/auth/device-code/start` with `client_info`.
2. Print user_code prominently, print verification_uri.
3. Attempt `webbrowser.open(verification_uri_complete)`.
4. Poll `POST /api/auth/device-code/poll` at `interval` seconds.
5. On `authorized`: write `~/.instantml/credentials` (TOML, mode 0600), print success, exit 0.
6. On `expired` or `denied`: print actionable error, exit 1.
7. Ctrl+C: print "Login cancelled", exit 1.

Credentials file format (TOML):
```toml
api_key = "instantml_..."
api_host = "https://app.instantml.ai"
org_id = "..."
user_email = "user@example.com"
```

Credential resolution in `init()` (in priority order):
1. Explicit `api_key=` kwarg.
2. `INSTANTML_API_KEY` env var.
3. `~/.instantml/credentials` TOML file (`api_key` field).
4. If interactive TTY: print `Run \`instantml login\` to set up credentials.` and raise `InstantMLError`.
5. If non-interactive: raise `InstantMLError` with the same message.

## Storage (device_code table)

Device codes are stored in-memory in the existing `store::Store` locked data structure, following the same pattern as sessions and API keys. This avoids schema migrations for this slice and keeps behavior consistent with the operational replay model.

In-memory record:
```
DeviceCodeRecord {
    device_code_hash: Vec<u8>,   // SHA-256 of the raw device_code
    user_code: String,           // "ABCD-EFGH"
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,   // created_at + 15 min
    last_polled_at: Option<DateTime<Utc>>,
    status: "pending" | "authorized" | "denied" | "expired",
    org_id: Option<Uuid>,
    user_id: Option<Uuid>,
    api_key_id: Option<Uuid>,
    api_key_plaintext: Option<String>, // cleared after first successful poll
}
```

`StoreData` gains:
- `device_codes: BTreeMap<Vec<u8>, DeviceCodeRecord>` (keyed by device_code_hash)
- `device_codes_by_user_code: HashMap<String, Vec<u8>>` (user_code -> hash)

Cleanup: expired records are removed lazily on start and confirm operations. No background task is needed for this slice.

## Security

- `device_code`: 32 bytes of random data (two UUIDs), base64url-encoded. Stored only as SHA-256 hash. Transmitted to CLI only at device-code/start; never logged.
- `user_code`: 8 uppercase alphanumeric chars split into `XXXX-XXXX`. ~3.36 trillion combinations at 36^8, but 15-min TTL and per-code rate limiting (5s interval enforced server-side) make brute force impractical.
- Rate limiting: per-device_code polling enforced server-side via `last_polled_at`. Requests within `interval` seconds return 429.
- TTL: 15-minute hard expiry on both client and server. Expired device codes are unreachable.
- Confirm requires active browser session—unauthenticated confirm returns 401.
- API key issued is `sdk:ingest`-scoped, same as onboarding keys. Demo org restriction still applies (no key reveal for demo org).
- Credentials file written at mode 0600 (owner read/write only).

## Test Plan

Rust unit tests (in `store/device_code.rs`):
- `start` creates a valid record with correct TTL.
- `poll` returns pending, authorized, expired, denied correctly.
- `poll` enforces rate limit (slow_down).
- `confirm` binds user_code to session, mints API key, marks authorized.
- Expired device codes return expired on poll.
- Already-consumed plaintext returns expired on re-poll.

Rust integration tests (in `http/handlers.rs` #[cfg(test)]):
- Full device-code lifecycle: start -> confirm -> poll -> authorized.
- Poll before confirm: pending.
- Poll after expiry: expired.
- Poll too fast: slow_down 429.
- Confirm unknown user_code: 404.
- Confirm without session: 401.

SDK unit tests (in `tests/test_cli.py`):
- Credential resolution order: kwarg > env > file > error.
- `load_credentials` parses a valid TOML file.
- `write_credentials` writes TOML with mode 0600.
- `login` flow: mock poll sequence pending->authorized, verify creds written.
- `logout` removes the credentials file.
- `whoami` prints org/user from creds file.
- Non-interactive missing-creds raises InstantMLError.

## Documentation Plan

- `docs/design/2026-05-16-device-code-cli-login.md` (this file)
- `apps/rust-server/README.md`: document new auth endpoints
- `apps/web/README.md`: document `/auth/device` page
- `packages/python-sdk/README.md`: document CLI commands and credential resolution

## Alternatives Considered

- **Browser-redirect OAuth with PKCE**: Requires a localhost redirect server in the CLI, which is complex and blocked by firewalls. Device-code flow is the RFC-standard solution for CLI/headless clients.
- **Copy/paste API key (status quo)**: Friction-heavy; users must navigate to the dashboard, create a key, and paste it.
- **Persist device codes in ClickHouse**: Adds schema migration complexity. In-memory store (same pattern as sessions) is simpler for this slice and survives the TTL anyway.

## Review Notes

Fresh reviewer 1:
- Finding: Plaintext API key must not be stored at rest or returned more than once.
- Risk: Key exposure if poll is called twice after confirm.
- Recommended edit: After first successful poll, clear `api_key_plaintext` and transition record to `expired`.
- Decision: Accepted. Record is consumed on first authorized poll.

Fresh reviewer 2:
- Finding: User-code brute force during 15-min window.
- Risk: Attacker guesses user_code and confirms another user's device.
- Recommended edit: Confirm endpoint requires active session; rate-limit confirm by IP in a follow-up.
- Decision: Accepted for this slice. Session requirement is enforced. IP rate-limiting is a follow-up.

## Coverage Exceptions

None. All new first-party logic has unit and integration tests.

## Decision

Accepted. Implement the in-memory device-code store, three backend endpoints, one browser page, and the CLI login/logout/whoami commands.
