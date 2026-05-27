/**
 * Source-level guardrails for the customer-owned ClickHouse onboarding copy.
 *
 * The browser walkthrough covers the rendered flow. These checks make sure the
 * customer-facing first-run instructions stay on the accepted GCP self-hosted
 * BYOC path and do not drift back to ClickHouse Cloud provisioning copy.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFlowPath = path.join(__dirname, "..", "app", "auth-flow.tsx");

describe("AuthFlow customer-owned ClickHouse setup copy", () => {
  const src = fs.readFileSync(authFlowPath, "utf8");

  test("recommends GCP self-hosted ClickHouse instead of ClickHouse Cloud", () => {
    assert.ok(src.includes("Recommended GCP ClickHouse setup"));
    assert.ok(src.includes("self-hosted ClickHouse deployment"));
    assert.ok(src.includes("https://clickhouse.acme.example.com:8443"));
    assert.ok(src.includes('username: "instantml_writer"'));
    assert.doesNotMatch(src, /ClickHouse Cloud: create a production service/);
    assert.doesNotMatch(src, /clickhouse\.cloud:8443/);
  });

  test("calls out InstantML egress allowlisting and R2-only storage accounting", () => {
    assert.ok(src.includes("allow only the InstantML egress CIDRs"));
    assert.ok(src.includes("Run data goes to your GCP ClickHouse"));
    assert.ok(src.includes("InstantML counts only R2 artifact bytes"));
  });

  test("setup SQL includes the current materialized-view grant and optional DDL revoke", () => {
    assert.match(src, /IDENTIFIED WITH sha256_password/);
    assert.match(src, /CREATE VIEW/);
    assert.match(src, /REVOKE CREATE TABLE, CREATE VIEW, ALTER TABLE/);
    assert.doesNotMatch(src, /DROP TABLE ON \$\{database\}/);
  });
});
