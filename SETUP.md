# Fresh Setup

This guide is the handoff path for new contributors and reviewers. It should work from a clean clone on macOS or Linux.

## Requirements

- Git.
- Node.js 22 LTS. The app currently works on Node `>=20.9.0`, but Node 22 is the documented version and matches the checked-in `.nvmrc` / `.node-version`.
- npm 10 or newer.
- Python 3.11.
- Rust 1.83 or newer.
- A local ClickHouse binary (`clickhouse`) or a reachable `CLICKHOUSE_URL` for Rust API/dev smokes.
- Docker Desktop or Docker Engine is optional for the one-command container stack.

Version markers:

- `.nvmrc`: Node 22.
- `.node-version`: Node 22 for tools such as asdf/mise.
- `.python-version`: Python 3.11 for pyenv-style tools.

## Fresh Clone

```bash
git clone <repo-url>
cd rl-observability
nvm install
nvm use
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
npm ci
python -m pip install -r requirements-dev.txt
npx playwright install chromium
npm run check:setup
```

Use `npm ci` for normal setup so installs follow `package-lock.json` exactly. The repo also sets `save-exact=true` in `.npmrc`; when adding or upgrading npm packages, commit the intentional exact version and updated lockfile together.

## Verify The Repo

Fast checks:

```bash
npm run rust:test
npm run test:node
python3 -m pytest
npm run test:scale
npm run test:contract
```

Rust/ClickHouse checks and smokes:

```bash
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
```

The Rust service smoke commands create disposable ClickHouse state, start the Rust server, and clean up afterward. Pull requests run the stable CI subset in GitHub Actions: Rust format/lint/unit tests, Node tests, and Python tests. Continue to run the Rust service, SDK, and UI smokes locally when touching service startup, auth, ClickHouse, or frontend integration paths.

Run everything:

```bash
npm run test:all
```

## Run The App Locally

Terminal 1:

```bash
npm run dev:api
```

This starts or reuses ClickHouse at `CLICKHOUSE_URL`, stores generated local state under `.rlobs/clickhouse`, applies the Rust ClickHouse schema, and serves the Rust API at `http://127.0.0.1:8000`.

If you need isolated generated state, use alternate ClickHouse paths and ports:

```bash
RLOBS_DEV_CHDATA=/tmp/rlobs-clickhouse \
RLOBS_DEV_CH_LOG_DIR=/tmp/rlobs-clickhouse-logs \
CLICKHOUSE_URL=http://default:@127.0.0.1:8124/rlobs \
RLOBS_API_PORT=8010 \
npm run dev:api
```

Terminal 2:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

Open:

```text
http://127.0.0.1:3000
```

Sign up with the labeled local dev Google-style flow, create a copy-once SDK key, then open the dashboard. Click `Reset demo` in the signed-in UI to seed the local `demo` project. The reset generates 1,000 deterministic synthetic LLM/RL runs with rich train/eval/system metrics, tags, notes, hardware metadata, checkpoints, MP3 audio artifact metadata, and MP4 rollout artifact metadata. Generated state is ignored by git.

For a production-style local web run:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:build
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:start
```

## Docker Path

Docker is optional. When available:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up --build
```

The override enables the dev Google-style auth flow inside the
container (the Rust server only enables it automatically when bound to
a loopback address, which the container is not) and remaps host port
8000 → 8010 in case another local service already owns 8000. The
override file is gitignored so per-machine tweaks don't get committed.
Skip the `cp` step on a clean machine to ship with secure defaults
only — but then `/signup` will render disabled buttons.

The Docker stack starts ClickHouse and the primary Rust API at:

```text
http://127.0.0.1:8010   # or http://127.0.0.1:8000 with the default port mapping
```

Run the Next frontend separately with `RLOBS_API_BASE=http://127.0.0.1:8010`
(or `:8000` if you skipped the override).

**Do not enable `RLOBS_DEV_AUTH_ENABLED` on any host reachable from the
public internet** — the endpoint lets anyone mint an authenticated
session with an arbitrary email.

## Rust/ClickHouse Path

The current default product backend is Rust API plus ClickHouse operational storage and ClickHouse metric storage. The deprecated Node server remains available only for compatibility and JSON migration work.

Apply the schema manually:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/rlobs \
cargo run --manifest-path apps/rust-server/Cargo.toml -- migrate
```

Start the Rust API manually:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/rlobs \
RLOBS_BIND_ADDR=127.0.0.1:8001 \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

Run API-key contract mode against a manually started Rust server:

```bash
RLOBS_CONTRACT_BASE_URL=http://127.0.0.1:8001 \
RLOBS_CONTRACT_BOOTSTRAP_TOKEN=dev-bootstrap \
npm run test:contract:direct
```

With no `RLOBS_CONTRACT_BASE_URL`, `npm run test:contract:direct` also starts the disposable Rust/ClickHouse harness by default. Use `npm run test:contract:node` or `RLOBS_CONTRACT_BACKEND=node` for the deprecated Node compatibility contract smoke.

Use `apps/rust-server/SETUP.md` for Rust-specific setup details.

Run the deprecated Node compatibility server:

```bash
npm run dev:api:node
```

## Common Problems

### `next` Or React Commands Are Missing

Run:

```bash
npm ci
```

### `pytest` Is Missing

Activate your virtualenv and run:

```bash
python -m pip install -r requirements-dev.txt
```

### Playwright Cannot Find A Browser

Run:

```bash
npx playwright install chromium
```

### Port 8000 Or 3000 Is Busy

Use a different Rust API port:

```bash
RLOBS_API_PORT=8010 npm run dev:api
RLOBS_API_BASE=http://127.0.0.1:8010 npm run web:dev
```

For the Next app, pass a different port directly:

```bash
cd apps/web
../../node_modules/.bin/next dev --port 3001
```

If the default ClickHouse HTTP port is busy with a non-ClickHouse process, use a different `CLICKHOUSE_URL` port:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8124/rlobs npm run dev:api
```
