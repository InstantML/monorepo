import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDocsOpenApi,
  publicOpenApiPaths,
} from "../sync-docs-openapi.mjs";
import { findInternalDocsReferences } from "../validate-docs-content.mjs";
import { findSnippetViolations } from "../validate-docs-snippets.mjs";

test("buildDocsOpenApi filters private paths and prunes unreferenced schemas", () => {
  const source = {
    openapi: "3.1.0",
    info: {
      title: "InstantML test API",
      version: "0.1.0",
      license: { name: "" },
    },
    paths: {
      "/runs": {
        get: {
          tags: ["runs"],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PublicRun" },
                },
              },
            },
          },
        },
      },
      "/api/auth/session": {
        get: {
          responses: {
            "200": {
              description: "private",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PrivateSession" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        PublicRun: {
          type: "object",
          properties: {
            id: { type: "string" },
            summary: { $ref: "#/components/schemas/PublicSummary" },
          },
        },
        PublicSummary: {
          type: "object",
          properties: {
            status: { type: "string" },
          },
        },
        PrivateSession: {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
      },
    },
  };

  const docsSpec = buildDocsOpenApi(source, {
    publicPaths: ["/runs"],
    servers: [{ url: "https://api.example.test" }],
  });

  assert.deepEqual(Object.keys(docsSpec.paths), ["/runs"]);
  assert.equal(docsSpec.info.license, undefined);
  assert.match(docsSpec.info.description, /Public InstantML API reference/);
  assert.deepEqual(docsSpec.servers, [{ url: "https://api.example.test" }]);
  assert.deepEqual(Object.keys(docsSpec.components.schemas).sort(), [
    "PublicRun",
    "PublicSummary",
  ]);
});

test("publicOpenApiPaths excludes known admin and internal route families", () => {
  assert.equal(publicOpenApiPaths.includes("/api/auth/session"), false);
  assert.equal(publicOpenApiPaths.includes("/api/billing/webhook"), false);
  assert.equal(publicOpenApiPaths.includes("/api/storage/clickhouse-connections"), false);
  assert.equal(publicOpenApiPaths.includes("/api/orgs/{org_id}/api-keys"), false);
  assert.equal(publicOpenApiPaths.includes("/api/runs/summary"), true);
  assert.equal(publicOpenApiPaths.includes("/api/runs/side-by-side"), true);
  assert.equal(publicOpenApiPaths.includes("/api/reports"), true);
  assert.equal(publicOpenApiPaths.includes("/api/reports/{report_id}/markdown"), true);
  assert.equal(publicOpenApiPaths.includes("/api/dashboard/preferences"), true);
});

test("findInternalDocsReferences catches internal docs links", () => {
  const violations = findInternalDocsReferences([
    {
      path: "apps/docs/index.mdx",
      content: "Read docs/design/2026-05-23-example.md before publishing.",
    },
    {
      path: "apps/docs/quickstart.mdx",
      content: "Start with the SDK quickstart.",
    },
  ]);

  assert.deepEqual(violations, [
    {
      path: "apps/docs/index.mdx",
      pattern: "docs/design",
    },
  ]);
});

test("findInternalDocsReferences catches local-only public docs URLs", () => {
  const violations = findInternalDocsReferences([
    {
      path: "apps/docs/openapi.json",
      content: '{"servers":[{"url":"http://127.0.0.1:8000"}]}',
    },
    {
      path: "apps/docs/index.mdx",
      content: "Use troubleshooting when local server behavior is confusing.",
    },
  ]);

  assert.deepEqual(violations, [
    {
      path: "apps/docs/openapi.json",
      pattern: "127.0.0.1",
    },
    {
      path: "apps/docs/index.mdx",
      pattern: "local server",
    },
  ]);
});

test("findSnippetViolations catches known non-copyable docs snippets", () => {
  const violations = findSnippetViolations([
    {
      path: "apps/docs/sdk/cli-login.mdx",
      content: "```bash\ninstantml login --base-url https://api.instantml.ai\n```",
    },
    {
      path: "apps/docs/sdk/rich-objects.mdx",
      content: '```python\nrun.log_text("notes/eval", "done")\n```',
    },
  ]);

  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /--api-host/);
  assert.match(violations[1].message, /dictionary/);
});
