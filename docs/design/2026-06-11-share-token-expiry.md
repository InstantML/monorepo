# Report share-token expiry (audit S6)

Date: 2026-06-11
Status: Accepted, implemented on `ui-followups`
Scope source: `docs/design/2026-06-10-ui-ux-production-audit.md` section 6 (S6)

## Problem

Report share tokens (`instantml_share_…`) never expired. A leaked share URL
granted read access to the report forever, and the only remediation was a
manual rotate. The audit flagged indefinite bearer-style tokens as the one
security finding without even a time bound.

## Approach

Expiry by issuance timestamp, enforced at the two read paths that accept a
token:

- `ReportRow` gains `share_token_issued_at: Option<DateTime<Utc>>`
  (`#[serde(default)]` so previously persisted rows deserialize cleanly).
- `rotate_share_token` stamps `Utc::now()` whenever a token is minted.
- `get_report` (token arm) and `get_report_by_share_token` both require
  `share_token_active`: token present AND younger than the TTL. Expired
  tokens 404 like unknown tokens — no oracle distinguishing "expired" from
  "never existed".
- TTL is `INSTANTML_SHARE_TOKEN_TTL_DAYS` (default 30; `0` disables expiry
  for self-hosted installs that prefer permanent links).

## Legacy rows

Rows persisted before the field existed have `share_token_issued_at: None`
and are treated as active until rotated. Breaking every pre-existing share
link in one deploy is a worse failure than a one-time grace window; rotation
(already exposed in the UI) upgrades any legacy token to an expiring one.

## Non-goals

- Per-report custom TTLs and a UI expiry picker (needs product design).
- Surfacing `share_token_expires_at` in `ReportSummary` and the share dialog
  (additive follow-up; the contract change here is deliberately minimal).
- Audit logging of share-link access.

## Tests

`share_tokens_expire_after_the_configured_ttl` covers: no token, legacy
`None` issuance, fresh token, past-TTL token, and the `0` opt-out, against
the pure `share_token_active_with_ttl` helper.
