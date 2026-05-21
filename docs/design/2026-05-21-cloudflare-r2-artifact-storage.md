# Design: Cloudflare R2 Artifact Storage

Date: 2026-05-21

Status: Accepted for narrow implementation

Owner: Codex

## Summary

Hosted InstantML currently stores artifact metadata in ClickHouse but disables
artifact byte uploads because Cloud Run-local files are ephemeral. The smallest
useful hosted artifact slice is to keep ClickHouse as the artifact catalog,
store artifact bytes in Cloudflare R2, and keep the existing artifact upload and
download routes compatible for the SDK and UI.

Each organization gets a deterministic private R2 bucket. On upload, the Rust
API checks whether the org bucket exists, creates it if needed, writes the
artifact bytes to R2, verifies size from the uploaded body, and appends the
artifact metadata row to tenant ClickHouse. Usage summaries continue to compute
artifact bytes from `ArtifactRow.size_bytes`, so storage warnings and monthly
usage include hosted artifacts immediately.

## Goals

- Store hosted artifact bytes in Cloudflare R2 instead of Cloud Run-local disk.
- Use one private R2 bucket per organization.
- Preserve the existing SDK and frontend artifact route shapes in this slice.
- Store only R2 object references, sizes, hashes, MIME type, and metadata in
  ClickHouse.
- Keep local development on the local filesystem backend unless R2 is explicitly
  configured.
- Update pricing copy so hosted storage is a paid first-party feature.

## Non-Goals

- Do not add direct browser/SDK presigned upload URLs in this first slice.
- Do not add multipart upload, resumable upload, or large checkpoint streaming.
- Do not add artifact versions, aliases, lineage, retention policies, or delete
  APIs.
- Do not make usage summaries invoice truth.
- Do not store raw bytes in ClickHouse.

## Users and Use Cases

SDK users call `run.upload_file(...)` or rich media helpers. The same request
works locally and in hosted mode. Hosted mode writes bytes to the org's R2
bucket, records a stable `instantml://artifacts/...` URI, and lets the dashboard
render image, audio, and video previews through the same-origin download route.

Operators provide Cloudflare R2 credentials through environment variables. If
permissions are missing, uploads fail clearly before ClickHouse metadata is
committed.

## Proposed Design

Add an artifact backend switch:

- `local`: current filesystem behavior.
- `r2`: Cloudflare R2 behavior.

R2 configuration:

- `INSTANTML_ARTIFACT_BACKEND=r2`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_R2_API_KEY` or `CLOUDFLARE_API_TOKEN` for bucket management.
- `CLOUDFLARE_R2_ACCESS_KEY_ID` and
  `CLOUDFLARE_R2_SECRET_ACCESS_KEY` for S3-compatible object operations.
  If omitted, the server verifies the Cloudflare API token to recover the token
  id as the R2 access key id and uses the SHA-256 hash of the token value as
  the R2 secret access key, matching Cloudflare's R2 auth-token mapping.
- `CLOUDFLARE_R2_BUCKET_PREFIX`, default `instantml-org`.
- `CLOUDFLARE_R2_ENDPOINT`, default
  `https://<account_id>.r2.cloudflarestorage.com`.

If the Cloudflare token uses Client IP Address Filtering, the filter must
include every Cloud Run static egress IP that can call the bucket-management and
S3-compatible R2 APIs. The current hosted deployment uses `136.115.243.188`.
Hosted frontend origins such as `https://instantml.ai` do not need to be added
to this Cloudflare token filter in the current architecture because the browser
and Next app only call the Rust API; the Rust Cloud Run services are the only
processes that send the Cloudflare token or R2 S3 credentials to Cloudflare.

Bucket name:

```text
<bucket-prefix>-<org_id.simple>
```

Object key:

```text
runs/<run_id>/artifacts/<artifact_id>/<sanitized_filename>
```

The upload route decodes the existing base64 payload, computes/validates
SHA-256, ensures the bucket exists through the Cloudflare R2 bucket API, writes
the object through R2's S3-compatible API, then commits an `ArtifactRow` with:

- `storage_backend = "r2"`
- `storage_key = "<bucket>/<object_key>"`
- `storage_path = "r2://<bucket>/<object_key>"`
- `uri = "instantml://artifacts/<bucket>/<object_key>"`
- `size_bytes`, `sha256`, and `mime_type`

Downloads read the artifact metadata, require read/export scope, authorize
tenant access, then either stream local bytes or stream the R2 object through
the API. R2 downloads forward `Range` requests for media preview behavior. The
UI keeps using `/api/artifacts/:artifact_id/download`, so raw bucket names,
signed URLs, and object keys are not exposed in public artifact metadata.

## Component Impact

Backend:

- Add R2 config parsing and backend selection.
- Extend `artifact_store.rs` with R2 bucket creation, S3 SigV4 PUT/GET, and
  existing local behavior.
- Update artifact upload/download handlers to use the configured backend.

Frontend:

- Keep artifact preview routes unchanged.
- Update pricing copy from BYOS-only to hosted R2-backed storage overage.

Python SDK:

- No public API change in this slice.
- Existing `upload_file()` keeps sending the current payload.

Storage:

- Artifact bytes move to R2 when configured.
- ClickHouse stores the metadata/reference row and exact byte count.

Docs:

- Update architecture/API/schema/Rust/web/SDK docs for R2 behavior and config.

## Data Model

No ClickHouse table migration is required. `ArtifactRow` already has the needed
fields:

- `storage_backend`
- `storage_key`
- `storage_path`
- `size_bytes`
- `sha256`
- `mime_type`

`storage_key` changes from a local relative path to `<bucket>/<object_key>` for
R2 artifacts.

## API Contracts

Existing route shapes remain:

- `POST /api/runs/:run_id/artifacts/upload`
- `GET /api/artifacts/:artifact_id/download`

Hosted R2 misconfiguration returns a server error before metadata commit. Missing
R2 bytes return `404 artifact bytes not found`.

## Performance Considerations

This preserves the current JSON/base64 API and is suitable for small-to-medium
media files and first hosted validation. It is not the final large-checkpoint
path. Direct presigned uploads and multipart upload should be designed next so
large checkpoints avoid base64 overhead and Cloud Run request limits.

Usage summaries use `size_bytes` already stored on retained local/R2 artifact
rows, so counting artifacts remains an in-memory projection read and does not
list R2 buckets. External/imported artifact sizes remain declared metadata and
do not consume retained-storage quota unless a future importer copies bytes into
InstantML-owned storage.

## Simplicity Review

This is the simplest useful hosted implementation because it reuses the existing
SDK/UI route shape, existing artifact metadata row, and current usage summary
fields. It adds one backend implementation instead of a new upload protocol.

Deferred:

- Presigned direct uploads.
- Multipart uploads.
- R2 lifecycle cleanup.
- Billing-grade provider reconciliation.
- Artifact deletion and retention.

## Failure Modes

- Bucket creation fails: return an API error; do not write metadata.
- Object upload fails: return an API error; do not write metadata.
- Metadata commit fails after object upload: perform best-effort object cleanup;
  later cleanup design should reconcile any crash-only orphans by prefix.
- R2 download fails or object missing: return `404`.
- Misconfigured credentials: return a clear server configuration/storage error.

## Testing Plan

- Rust unit tests for bucket naming, object key parsing, local path behavior, and
  SigV4 helper behavior.
- Rust API/contract tests must keep local artifact upload/download passing.
- SDK tests keep existing file upload behavior.
- Local R2 smoke with small text, PNG, MP4, and MP3 files under 10 GB total.
- Browser smoke through localhost verifying image/audio/video previews load.

## Documentation Plan

- `README.md`
- `apps/rust-server/README.md`
- `docs/architecture/current-api.md`
- `docs/architecture/current-schemas.md`
- `docs/architecture/current-system.md`
- `packages/python-sdk/README.md`
- `apps/web/README.md`
- `.env.example`

## Alternatives Considered

- GCS buckets: operationally convenient on Cloud Run, but less portable and not
  aligned with the current S3-compatible storage direction.
- Direct presigned URLs first: better long-term performance, but a larger SDK
  and browser contract change.
- Store bytes in ClickHouse: rejected because artifacts are not analytical rows
  and would pollute the scalar metric hot path.
- One global bucket: simpler, but per-org buckets make storage inspection,
  isolation, and future retention policies easier.

## Review Notes

Implementation note:

- Artifact smoke runs should use a dedicated project named `artifacts`, so
  media verification data does not pollute ordinary demo or benchmark projects.

Fresh reviewer 1:

- Finding: The first slice should not change the public SDK contract while
  hosted artifact storage is still unproven.
- Risk: Large checkpoints remain inefficient through JSON/base64 upload.
- Recommended edit: Explicitly scope this to media/small artifact validation and
  require a follow-up presigned multipart design.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: Per-org buckets are acceptable if bucket names are deterministic and
  private, but usage must not list buckets on read paths.
- Risk: Metadata commit failure after object upload can leave orphaned objects.
- Recommended edit: Use `ArtifactRow.size_bytes` for monthly usage and document
  orphan cleanup as deferred.
- Decision: Accepted.

Fresh reviewer 3:

- Finding: R2 uploads should not hit Cloudflare before plan capacity checks, and
  external/imported artifact sizes should not be charged as retained storage.
- Risk: Over-limit uploads could create orphan R2 objects, and metadata-only
  imports could consume quota for bytes InstantML does not store.
- Decision: Accepted. Uploads now decode/measure and enforce capacity before
  local/R2 writes. Usage storage counts retained local/R2 bytes separately from
  declared external artifact bytes.

Fresh reviewer 4:

- Finding: Artifact read paths need explicit read/export scope, provider
  authorization failures should be storage/server errors rather than caller
  `403`s, and R2 downloads should stream/range for media.
- Risk: Write-only keys could download bytes, operator credential problems could
  look like customer auth failures, and media previews could buffer too much.
- Decision: Accepted. List/download require `export:read`, Cloudflare/R2
  `401/403` responses map to generic service-unavailable responses with
  sanitized server logs, and R2 byte responses stream through Axum with Range
  forwarding.

Fresh reviewer 5:

- Finding: Public artifact DTOs must not expose R2 bucket/object locators, and
  frontend previews/download affordances should appear only for stored-byte
  backends.
- Risk: Authenticated clients could see internal bucket layout, and imported
  `s3://`/`gs://` metadata rows could render broken same-origin downloads.
- Decision: Accepted. Artifact create/list/upload/export responses use an
  opaque public artifact row with `instantml://artifacts/<artifact_id>` for
  stored bytes and no `storage_key`/`storage_path`; UI download/preview controls
  now require `storage_backend` of `local` or `r2`.

Fresh reviewer 6:

- Finding: Artifact upload idempotency and direct large-file upload should be
  designed next.
- Risk: Client retries without an idempotency key can duplicate stored artifacts;
  JSON/base64 upload remains inefficient for large checkpoints.
- Decision: Deferred to a follow-up design because it changes SDK/API semantics
  beyond this narrow hosted storage slice.

## Coverage Exceptions

None planned.

## Decision

Accepted for a narrow R2-backed implementation that preserves current routes
and local filesystem behavior.
