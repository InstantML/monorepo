# Castform Collaboration Demo

Artifacts for planning a Castform collaboration call and demo. These files are
self-contained so the work can be reviewed without touching product code.

Research date: 2026-06-30.

## Files

- `castform-research-brief.md`: what Castform appears to provide, public source
  links, and the observability opportunity for InstantML.
- `demo-plan.md`: call-ready demo story, runbook, fallback path, and success
  criteria.
- `integration-plan.md`: practical integration slices, data mapping, risks, and
  questions for Castform.
- `call-agenda.md`: suggested call structure and discovery questions.
- `castform-metric-mapping.json`: proposed Castform-to-InstantML field and metric
  mapping.
- `castform_instantml_adapter.py`: illustrative pull-sync script using
  Benchmax's public run-read client and the InstantML SDK.
- `seed_castform_demo.py`: deterministic synthetic Castform-shaped data seeder
  for an InstantML demo workspace when live Castform credentials are unavailable.
- `e2e-design.md`: accepted local architecture for the runnable Castform to
  InstantML iframe demo.
- `assets/ui-concept.png`: generated visual concept for the local parent page.

## Demo Paths

Live mirror path, if we have Castform and InstantML credentials:

```bash
CASTFORM_API_KEY=sk_... \
INSTANTML_API_KEY=instantml_... \
PYTHONPATH=packages/python-sdk \
python3 demo/castform/castform_instantml_adapter.py \
  --castform-run-id <castform-run-id> \
  --instantml-project castform-demo
```

Synthetic fallback path:

```bash
INSTANTML_API_KEY=instantml_... \
PYTHONPATH=packages/python-sdk \
python3 demo/castform/seed_castform_demo.py --project castform-demo --runs 10
```

Both paths are designed to populate InstantML with Castform-shaped run metadata,
reward curves, solve-rate curves, response-length curves, subreward curves,
environment logs, and lifecycle notes so the call can focus on the integration
value instead of credential setup.

## End-to-End Hosted Demo

The full demo design lives in `e2e-design.md`. The runnable slice will write to
hosted InstantML by default under a new `castform-live-demo` project and create
hosted iframe embed sessions that persist through the call. The local Castform
parent page must be served through an HTTPS tunnel because hosted InstantML
embeds require an exact HTTPS, non-InstantML parent origin.

## Verification

The scripts are dependency-light but require installed `instantml` and, for the
live mirror path, installed `benchmax` at runtime. Syntax-only verification:

```bash
python3 -m py_compile demo/castform/castform_instantml_adapter.py demo/castform/seed_castform_demo.py
```
