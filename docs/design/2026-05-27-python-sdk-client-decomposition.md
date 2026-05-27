# Design: Python SDK Client Decomposition

Date: 2026-05-27

Status: Accepted first slice

Owner: Codex

## Summary

`packages/python-sdk/instantml/client.py` has grown into a multi-responsibility
module. It currently contains public rich-object wrappers, the REST `Client`,
the read-oriented `Api`, async producer buffering, `Run`, initialization helpers,
local audit storage, system metrics, console capture, framework adapters, media
conversion, process-spool helpers, and a collection of validation/classification
helpers.

This refactor keeps the public SDK contract stable while splitting cohesive
internal responsibilities into focused modules. `instantml.client` remains a
compatibility facade that re-exports existing public and private names used by
tests and downstream code. The first slice is intentionally narrow and
mechanical: move only leaf value/media/log-payload code, keep route behavior
unchanged, and avoid public API changes.

## Goals

- Reduce `client.py` size and cognitive load.
- Preserve `from instantml.client import ...` compatibility.
- Keep `instantml.__init__` exports unchanged.
- Avoid behavior, REST payload, upload-mode, or storage changes.
- Preserve 100% first-party Python coverage.

## Non-Goals

- Do not change public SDK method signatures.
- Do not rewrite `Run` internals beyond import/module boundary changes.
- Do not change async batching semantics from
  `2026-05-27-async-sqlite-batching.md`.
- Do not introduce shared abstractions before extraction proves the boundaries.
- Do not split frontend, Rust, or API code.

## Users and Use Cases

Future SDK contributors need to work on rich objects, media conversion, async
uploading, framework integrations, and run lifecycle code without reading a
single large file. Existing SDK users should see no behavior change.

## Proposed Design

Keep `client.py` as the compatibility facade for this slice. Move only the
smallest leaf responsibilities:

- `objects.py`: `Table`, `Histogram`, `File`, `Artifact`, `CheckpointPolicy`,
  `Text`, `Image`, `Video`, `Audio`, `_histogram_from_count()`, and
  `_histogram_counts_for_edges()`.
- `media.py`: `_is_local_file_uri()`, `_strip_file_uri()`, `_FileStats`,
  `_hash_file()`, `_write_image_data()`, `_write_audio_data()`, and
  `_write_video_data()`.
- `log_payload.py`: `_classify_log_payload()`, `_classify_log_sequence()`,
  `_validate_rank_context()`, and `_validate_rank_weight()`.

Do not move `Client`, `Api`, `Run`, `_AsyncProducerBuffer`, `_LocalStore`,
system metrics, console capture, process-spool helpers, source capture,
framework integrations, or `init()` in this slice. Those are `Run`
collaborators rather than leaf code and need a later design with explicit
protocol boundaries.

For compatibility, `client.py` imports the moved names and keeps them available
from `instantml.client`. `Run` continues to resolve these helpers through
`client.py` module globals, so tests or downstream users that monkeypatch
`instantml.client._write_image_data` or `instantml.client._classify_log_payload`
still affect `Run` behavior.

### Import Dependency Graph

The accepted import direction is:

```text
validation.py, serialization.py, errors.py
  -> objects.py
  -> log_payload.py
  -> client.py

errors.py, serialization.py
  -> media.py
  -> client.py
```

New modules must not runtime-import `instantml.client`. If a future module needs
`Run` or `init()`, use a later design with `typing.TYPE_CHECKING`, a small
`Protocol`, or a local import inside an adapter method.

### Move Map

| Name | New module | Exported from `instantml.client` | Notes |
| --- | --- | --- | --- |
| `Table` | `objects.py` | Yes | Public class; keep `__module__` as `instantml.client`. |
| `Histogram` | `objects.py` | Yes | Move histogram helper functions with it. |
| `File`, `Artifact` | `objects.py` | Yes | Public dataclasses. |
| `CheckpointPolicy` | `objects.py` | Yes | Uses step validation only. |
| `Text`, `Image`, `Video`, `Audio` | `objects.py` | Yes | Public rich wrappers. |
| `_histogram_from_count`, `_histogram_counts_for_edges` | `objects.py` | Yes | Private compatibility re-export. |
| `_is_local_file_uri`, `_strip_file_uri` | `media.py` | Yes | Private compatibility re-export used by shadow tests. |
| `_FileStats`, `_hash_file` | `media.py` | Yes | Private compatibility re-export used by upload paths. |
| `_write_image_data`, `_write_audio_data`, `_write_video_data` | `media.py` | Yes | Private compatibility re-export; `Run` global lookup remains patchable through `instantml.client`. |
| `_classify_log_payload`, `_classify_log_sequence` | `log_payload.py` | Yes | Private compatibility re-export. |
| `_validate_rank_context`, `_validate_rank_weight` | `log_payload.py` | Yes | Private compatibility re-export. |

### Compatibility Surface

The first slice preserves imports through `instantml.client` for all public
SDK exports and known private test/uploader imports, including `Client`, `Api`,
`Run`, `SourceTracking`, `InstantMLError`, `_ConsoleStream`, `_LocalStore`,
`_check_credentials_or_raise`, `_coerce_numeric_values`,
`_collect_system_metrics`, `_environment_metadata`, `_git_metadata`,
`_normalize_source_tracking`, `_source_metadata`, media writers, log payload
classification, file URI helpers, and histogram helpers.

Public moved classes set `__module__ = "instantml.client"` during this
compatibility slice so simple introspection and pickle paths remain stable.

## Component Impact

Backend:

- No change.

Frontend:

- No change.

Python SDK:

- Internal module layout changes.
- Public imports remain stable.
- Tests may import helpers from the new modules where appropriate, but old
  helper imports through `instantml.client` continue to work.

Storage:

- No schema, path, or persistence behavior change.

Docs:

- Update the Python SDK README notes for future agents.
- Update design index.

## Data Model

No data model changes.

## API Contracts

No REST or public SDK contract changes. The compatibility requirement is:

```python
from instantml.client import Run, Table, _collect_system_metrics
```

must continue to work after the split.

## Performance Considerations

This is a structural refactor. Runtime performance should remain unchanged
except for negligible import-boundary differences. The split should avoid lazy
imports on hot logging paths unless they already existed for optional
dependencies.

## Simplicity Review

The smallest useful slice moves leaf definitions and helpers while keeping the
stateful `Run` class in place. This limits circular import risk and keeps the
refactor reviewable. Moving `Run` itself is deferred until the dependency graph
is simpler.

## Failure Modes

- Circular imports can break SDK import. Mitigation: new modules do not import
  `instantml.client`; this slice leaves all `Run` collaborators in `client.py`.
- Compatibility imports can disappear. Mitigation: re-export moved names from
  `client.py`, add import-smoke coverage, and keep existing tests.
- Monkeypatch behavior can drift. Mitigation: `Run` keeps resolving moved
  helpers through `client.py` globals for this slice.
- Behavior can drift during extraction. Mitigation: no logic rewrites beyond
  import relocation; run full Python tests and package import smokes.

## Testing Plan

- Add import-smoke tests for `instantml`, `instantml.client`,
  `instantml.uploader`, `instantml.objects`, `instantml.media`, and
  `instantml.log_payload`.
- Add facade export checks for the moved names and `__module__` compatibility on
  public moved classes.
- Keep existing monkeypatch behavior covered by tests that patch
  `instantml.client` helper names.
- Run focused Python SDK tests for client/shadow/CLI behavior.
- Run `npm run test:python`.
- Run package checks: `npm run sdk:build`, `npm run sdk:check`, and
  `npm run sdk:test-install`.
- Keep 100% meaningful first-party Python coverage.

## Documentation Plan

- Update `packages/python-sdk/README.md` key-files section / notes for future
  agents.
- Update `docs/design/README.md`.

## Alternatives Considered

Move `Run` immediately:

- Rejected for this first slice because `Run` depends on almost every SDK
  helper. Moving it after leaf extraction will be safer.

Create a nested `instantml.sdk` package:

- Rejected for now because it widens import churn and does not help existing
  compatibility imports.

Leave `client.py` unchanged:

- Rejected because the file now mixes unrelated responsibilities and has already
  been flagged by code-quality review.

## Review Notes

Fresh reviewer 1:

- Finding: The original eight-module split was too broad because async,
  system, console, and integrations are `Run` collaborators rather than leaves.
- Risk: Circular imports and behavioral drift would make the refactor hard to
  review.
- Recommended edit: Narrow the first slice to one or two true leaf areas and
  defer stateful collaborators.
- Decision: Accepted. The first slice moves only rich objects, media helpers,
  and log payload validation/classification.

Fresh reviewer 2:

- Finding: The design needed an explicit import DAG, compatibility export
  surface, monkeypatch policy, helper move map, and package import verification.
- Risk: Re-exporting alone could break private imports, tests, monkeypatches,
  optional dependency behavior, installed-wheel imports, and public class module
  identity.
- Recommended edit: Document exact moved names, keep new modules from importing
  `instantml.client`, preserve `__module__` for public moved classes, and add
  build/check/test-install coverage.
- Decision: Accepted. The plan now includes the import DAG, compatibility
  matrix, facade monkeypatch policy, and package verification steps.

## Coverage Exceptions

None planned.

## Decision

Proceed with the narrow first slice only. Future decomposition of
`_LocalStore`, process spool, system metrics, console capture, integrations,
async producer buffering, `Run`, `Client`, or `Api` requires a follow-up design
or an explicit update to this document.
