import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../..");

test("hosted scale seed can connect through a local ClickHouse tunnel", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "hosted-tenant-scale-seed.mjs"), "utf8");

  assert.match(source, /INSTANTML_HOSTED_SCALE_CLICKHOUSE_ENDPOINT_OVERRIDE/);
  assert.doesNotMatch(source, /writes to live ClickHouse Cloud/);
});
