# Fresh Setup

This guide is the handoff path for new contributors and reviewers. It should work from a clean clone on macOS or Linux.

## Requirements

- Git.
- Node.js 22 LTS. The app currently works on Node `>=20.9.0`, but Node 22 is the documented version and matches the checked-in `.nvmrc` / `.node-version`.
- npm 10 or newer.
- Python 3.11.
- Docker Desktop or Docker Engine is optional for the one-command container stack.
- Rust 1.83 or newer plus local Postgres command-line tools are required for the primary Rust/Postgres backend and smokes.

Version markers:

- `.nvmrc`: Node 22.
- `.node-version`: Node 22 for tools such as asdf/mise.
- `.python-version`: Python 3.11 for pyenv-style tools.

## Fresh Clone

```bash
git clone <repo-url>
cd rl-observability
```

Use the repo versions if your machine supports them:

```bash
nvm install
nvm use
```

Create and activate a Python virtual environment:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
```

If your system names Python 3.11 as `python3`, use:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
```

Install dependencies:

```bash
npm ci
python -m pip install -r requirements-dev.txt
npx playwright install chromium
```

Use `npm ci` for normal setup so installs follow `package-lock.json` exactly. The repo also sets `save-exact=true` in `.npmrc`; when adding or upgrading npm packages, commit the intentional exact version and updated lockfile together.

Check the environment:

```bash
npm run check:setup
```

## Verify The Repo

Run the fast backend/helper suites:

```bash
npm run rust:test
npm run test:node
python3 -m pytest
```

Run the scale smoke:

```bash
npm run test:scale
```

Run the primary Rust backend contract smoke:

```bash
npm run test:contract
```

Run the Rust/Postgres checks and smokes:

```bash
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
```

The `test:rust:*` commands create disposable Postgres clusters with `initdb`/`pg_ctl`, start the Rust server, and clean up afterward.

Run the browser smoke:

```bash
npm run test:ui
```

Run everything:

```bash
npm run test:all
```

Pull requests run the stable CI subset in GitHub Actions: Rust format/lint/unit tests, Node tests, and Python tests. Continue to run the Rust service, SDK, and UI smokes locally when touching service startup, auth, ClickHouse, or frontend integration paths.

`npm run test:ui` and `npm run test:ui:direct` start disposable Postgres, start the Rust API, build the Next app, start `next start`, drive the landing/signup/onboarding/dashboard flow with Playwright, and write a temporary screenshot path to stdout. Direct no-env invocation of `node apps/web/tests/ui-smoke.mjs` follows the same Rust default. The full UI smoke depends on Rust session/auth endpoints; use Node compatibility checks only for explicit legacy investigations.

## Run The App Locally

Terminal 1:

```bash
npm run dev:api
```

This starts local Postgres under `.rlobs/postgres`, applies Rust migrations, and serves the Rust API at `http://127.0.0.1:8000`.

If you need an isolated local database without touching an existing `.rlobs/postgres` cluster, use alternate generated-state paths and ports:

```bash
RLOBS_DEV_PGDATA=/tmp/rlobs-postgres \
RLOBS_DEV_PG_LOG=/tmp/rlobs-postgres.log \
RLOBS_DEV_PG_PORT=54339 \
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

Sign up with the labeled local dev Google-style flow, create a copy-once SDK key, then open the dashboard. Click `Reset demo` in the signed-in UI to seed the local `demo` project. The reset generates 1,000 deterministic synthetic LLM/RL runs with rich train/eval/system metrics, tags, notes, hardware metadata, checkpoints, MP3 audio artifact metadata, and MP4 rollout artifact metadata. Local state is written under `.rlobs/` for legacy Node mode or local Postgres for Rust mode; generated state is ignored by git.

For a production-style local web run:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:build
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:start
```

## Docker Path

Docker is optional. When available:

```bash
docker compose up --build
```

The Docker stack now starts Postgres and the primary Rust API at:

```text
http://127.0.0.1:8000
```

## Rust/Postgres Path

The current default product backend is Rust API plus Postgres. The deprecated Node server remains available only for compatibility and JSON migration work.

If you want to review the schema against a local or disposable Postgres database:

```bash
for migration in apps/rust-server/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
```

Start the Rust API manually:

```bash
DATABASE_URL=postgres://127.0.0.1:5432/rlobs \
RLOBS_BIND_ADDR=127.0.0.1:8001 \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

Run API-key contract mode against a manually started Rust server:

```bash
RLOBS_CONTRACT_BASE_URL=http://127.0.0.1:8001 \
RLOBS_CONTRACT_BOOTSTRAP_TOKEN=dev-bootstrap \
npm run test:contract:direct
```

With no `RLOBS_CONTRACT_BASE_URL`, `npm run test:contract:direct` also starts the disposable Rust/Postgres harness by default. Use `npm run test:contract:node` or `RLOBS_CONTRACT_BACKEND=node` for the deprecated Node compatibility contract smoke.

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

### Rust Migration Version Mismatch

If `npm run dev:api` exits with a SQLx migration version mismatch, the generated local Postgres cluster under `.rlobs/postgres` was created by an older checkout whose migration checksum no longer matches the current source. For a disposable dev database, stop the server and remove only the generated cluster:

```bash
rm -rf .rlobs/postgres .rlobs/postgres.log
npm run dev:api
```

Use the isolated `RLOBS_DEV_PGDATA` command above if you want to preserve the old generated cluster while checking a clean setup.

### Clean Local Generated State

This removes generated local state and build outputs, not source files:

```bash
rm -rf .rlobs apps/web/.next .pytest_cache .coverage
```

Remove installed dependencies only if you want a fully fresh install:

```bash
rm -rf node_modules .venv
```

Then repeat the fresh-clone install steps.
