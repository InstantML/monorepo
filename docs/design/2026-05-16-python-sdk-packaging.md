# Design: Python SDK Packaging And PyPI Release

Date: 2026-05-16

Status: Accepted for packaging preparation; public PyPI publication remains gated by maintainer setup.

Owner: Codex

## Summary

InstantML needs a standard Python distribution package so users can install the SDK with `pip install instantml` instead of setting `PYTHONPATH=packages/python-sdk`. The narrow first slice adds package metadata, local build checks, CI packaging verification, and a trusted-publishing GitHub Actions workflow for TestPyPI/PyPI.

This slice does not change the SDK runtime contract, hosted onboarding, auth defaults, artifact semantics, or public method signatures. It only makes the existing `instantml` import package buildable and publishable.

## Research Notes

PyPA's current packaging tutorial recommends a `pyproject.toml` build backend, building a source distribution plus wheel with `python -m build`, checking archives before upload, and publishing through Twine or trusted automation. PyPA's GitHub Actions publishing guide and PyPI's Trusted Publishers docs recommend OIDC-based Trusted Publishing so release jobs do not store long-lived PyPI tokens. The `instantml` project name returned 404 on both PyPI and TestPyPI during local checks on 2026-05-16, so the name appears unclaimed at research time but still must be reserved by the first successful publish.

## Goals

- Build a pure-Python wheel and sdist for `instantml`.
- Keep core installs dependency-light and standard-library-only.
- Expose optional extras for media conversion and system metric dependencies.
- Provide a console entry point for the existing process uploader.
- Verify package metadata and importability in CI.
- Prepare a GitHub Actions release path using PyPI/TestPyPI Trusted Publishing.
- Keep public release blocked on maintainer-controlled PyPI publisher setup and final license/terms confirmation.

## Non-Goals

- Do not publish from the local developer machine.
- Do not introduce long-lived PyPI API tokens into the repository.
- Do not change SDK API behavior, default base URL, or auth requirements.
- Do not choose a permissive open-source license in this slice.
- Do not bundle artifacts, example data, tests, or local generated files into the wheel.

## Proposed Design

Add `packages/python-sdk/pyproject.toml` using `setuptools.build_meta`. The project name is `instantml`, version `0.1.0`, `requires-python >=3.11`, and the only included import package is `instantml`. The core package has no required dependencies because current SDK runtime code uses the standard library unless optional media/system helpers are invoked.

Add `MANIFEST.in` so source distributions include user-facing docs and optional dependency pins while excluding tests, build output, caches, and generated files.

Add optional extras:

- `media`: Pillow, imageio, moviepy, and soundfile for image/audio/video data conversion.
- `system`: psutil and pynvml for runtime/system metrics.
- `all`: the existing optional dependency set from `requirements-optional.txt`.

Use a PyPI-specific README so the package page is user-facing and does not expose internal contributor workflow text from `packages/python-sdk/README.md`.

Add `instantml-uploader = "instantml.uploader:main"` as a console entry point while preserving `python -m instantml.uploader`.

## Release Workflow

The release workflow builds artifacts in one job, stores them as a GitHub artifact, then publishes in separate jobs with `id-token: write` only on publishing jobs:

- Manual `workflow_dispatch` to `testpypi` publishes to TestPyPI.
- GitHub release publication, or an explicit manual dispatch to `pypi`, publishes to PyPI.
- The PyPI job uses the `pypi` GitHub Environment and should require manual approval.

Before first upload, maintainers must configure pending trusted publishers on PyPI/TestPyPI for:

- Project name: `instantml`
- Workflow file: `python-sdk-release.yml`
- Environments: `pypi` and `testpypi`

## Testing And Verification

Local and CI verification:

```bash
python3 -m build packages/python-sdk
python3 -m twine check packages/python-sdk/dist/*
python3 -m pip install packages/python-sdk/dist/instantml-0.1.0-py3-none-any.whl
python3 -c "import instantml as im; print(im.Client())"
```

The repository Python test suite remains the SDK behavior gate:

```bash
npm run test:python
```

## Risks

- The `instantml` name can still be claimed by someone else before first upload. Mitigation: reserve it on TestPyPI/PyPI promptly once license/terms are ready.
- Publishing without final license/terms would be confusing. Mitigation: metadata uses a proprietary license reference, docs call out the pending public terms, and actual PyPI upload is gated by trusted publisher setup plus GitHub Environment approval.
- TestPyPI packages are not permanent and can be deleted. Mitigation: use TestPyPI for pipeline rehearsal only; use PyPI for real installation once approved.

## Review Notes

- Fresh agent review was not run in this turn because local tool policy only permits spawning reviewer agents when the user explicitly asks for delegation. This packaging slice deliberately avoids runtime/API changes, and the actual public upload remains gated by maintainer-controlled PyPI/GitHub setup.
