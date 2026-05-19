#!/usr/bin/env node
// codegen-api.mjs
//
// End-to-end TypeScript codegen from the Rust handlers' utoipa-driven OpenAPI spec.
//
// Pipeline:
//   1. `cargo run -- emit-openapi` -> JSON spec on stdout (no running server needed).
//   2. Spec is written to `apps/rust-server/openapi.generated.json` (gitignored, build artifact).
//   3. `openapi-typescript` converts that into `apps/web/src/types/api.generated.ts`.
//
// Flags:
//   --check    Run the pipeline, then `git diff --exit-code` on the emitted files.
//              CI uses this to fail PRs that ship Rust changes without re-running codegen.
//
// Add new handlers in `apps/rust-server/src/http/handlers.rs` with `#[utoipa::path(...)]`
// and update `crate::http::openapi::ApiDoc#[openapi(paths(...))]`; this script picks them up
// automatically.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const cargoManifest = resolve(repoRoot, "apps/rust-server/Cargo.toml");
const specOut = resolve(repoRoot, "apps/rust-server/openapi.generated.json");
const tsOut = resolve(repoRoot, "apps/web/src/types/api.generated.ts");

const checkMode = process.argv.includes("--check");

function run(cmd, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"], ...opts });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code === 0) resolveP(Buffer.concat(chunks));
      else rejectP(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function main() {
  process.stderr.write("[codegen:api] emitting OpenAPI spec from Rust handlers...\n");
  const stdout = await run(
    "cargo",
    ["run", "--quiet", "--manifest-path", cargoManifest, "--", "emit-openapi"],
    { env: { ...process.env, RUST_LOG: "error" } },
  );
  const specText = stdout.toString("utf8");
  if (!specText.trim().startsWith("{")) {
    throw new Error("emit-openapi produced non-JSON output");
  }
  // Validate JSON shape.
  const parsed = JSON.parse(specText);
  if (!parsed.openapi || !parsed.paths) {
    throw new Error("emit-openapi spec missing required 'openapi' or 'paths' fields");
  }
  const pathCount = Object.keys(parsed.paths).length;
  const schemaCount = Object.keys(parsed.components?.schemas ?? {}).length;
  process.stderr.write(`[codegen:api] spec covers ${pathCount} paths, ${schemaCount} schemas\n`);

  mkdirSync(dirname(specOut), { recursive: true });
  // Stable formatting so diffs only fire when the spec actually changes.
  writeFileSync(specOut, `${JSON.stringify(parsed, null, 2)}\n`);
  process.stderr.write(`[codegen:api] wrote ${specOut}\n`);

  mkdirSync(dirname(tsOut), { recursive: true });
  process.stderr.write("[codegen:api] generating TypeScript bindings...\n");
  const tsRes = spawnSync(
    "npx",
    ["--yes", "openapi-typescript@7", specOut, "--output", tsOut],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (tsRes.status !== 0) {
    throw new Error(`openapi-typescript exited ${tsRes.status}`);
  }
  process.stderr.write(`[codegen:api] wrote ${tsOut}\n`);

  if (checkMode) {
    process.stderr.write("[codegen:api] --check: verifying no diff against git tree...\n");
    const diff = spawnSync(
      "git",
      ["diff", "--exit-code", "--", specOut, tsOut],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (diff.status !== 0) {
      process.stderr.write(
        "[codegen:api] FAIL: generated files differ from committed copy. Run `npm run codegen:api` and commit.\n",
      );
      process.exit(1);
    }
    process.stderr.write("[codegen:api] OK: generated files are in sync.\n");
  }
}

main().catch((err) => {
  process.stderr.write(`[codegen:api] ${err.message ?? err}\n`);
  process.exit(1);
});
