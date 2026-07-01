# Castform Demo Web Page

This is the local Castform-facing parent page for the hosted iframe demo. It is
plain static HTML/CSS/JS so it can be served by Python or any simple web server.

## Run

From the repository root:

```bash
python3 demo/castform/serve_web.py --port 5174
```

For hosted InstantML iframes, expose that local port through an HTTPS tunnel and
use the tunnel origin as `--parent-origin` when running `run_demo.py`.

For local browser smoke without live credentials:

```bash
python3 demo/castform/create_smoke_manifest.py
python3 demo/castform/serve_web.py --port 5174
node demo/castform/browser_verify.mjs --expect-runs 3 --expect-sessions 3
```

## Generated Manifest

`run_demo.py` writes `public/demo-manifest.json`. That file includes live
token-bearing iframe URLs and is ignored by Git. The page never renders those
URLs as visible text; it only assigns them to iframe `src` attributes.

`create_smoke_manifest.py` writes the same ignored manifest path with synthetic
run IDs and `about:blank` iframe targets. It is only for checking the parent
page render, tab switching, refresh flow, and visible-token safety before a
live InstantML manifest is available.
