import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../..");

test("hosted demo benchmark defaults to database-mode ClickHouse", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "hosted-demo-seed-benchmark.mjs"), "utf8");

  assert.match(source, /INSTANTML_HOSTED_DEMO_PROVISIONER/);
  assert.match(source, /process\.env\.INSTANTML_CLICKHOUSE_PROVISIONER \|\| "database"/);
  assert.match(source, /INSTANTML_CLICKHOUSE_PROVISIONER: hostedDemoProvisioner/);
  assert.match(source, /hostedDemoProvisioner === "cloud-service"/);
  assert.doesNotMatch(source, /INSTANTML_CLICKHOUSE_PROVISIONER: "cloud-service"/);
});
