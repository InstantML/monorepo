import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  docsHref,
  docsPathForSlug,
  loadDocsPage,
  mapDocsAssetSrc,
  parseDocsMdx,
} from "../src/docs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");

test("docs app route renders docs source instead of redirecting to a docs host", async () => {
  const route = await readFile(path.join(webRoot, "app", "docs", "[[...slug]]", "page.tsx"), "utf8");
  assert.match(route, /loadDocsPage/);
  assert.match(route, /DocsSidebar/);
  assert.doesNotMatch(route, /docs\.instantml\.ai|localhost:3001|INSTANTML_DOCS_BASE/);
});

test("docs routes bypass Clerk proxy middleware", async () => {
  const proxy = await readFile(path.join(webRoot, "proxy.ts"), "utf8");
  assert.match(proxy, /\(\?!_next\|docs\|/);
});

test("docs asset route serves images from the docs source tree", async () => {
  const route = await readFile(path.join(webRoot, "app", "docs", "assets", "[...path]", "route.ts"), "utf8");
  assert.match(route, /docsImagesRoot/);
  assert.match(route, /Content-Type/);
});

test("docs slug paths are normalized and reject traversal", () => {
  assert.equal(docsPathForSlug([]), "index");
  assert.equal(docsPathForSlug(["sdk", "logging"]), "sdk/logging");
  assert.equal(docsPathForSlug(["api-reference", "platform", "get-health"]), "api-reference");
  assert.throws(() => docsPathForSlug([".."]), /Unsafe docs slug segment/);
  assert.throws(() => docsPathForSlug(["sdk/logging"]), /Unsafe docs slug segment/);
});

test("docs links and assets are mapped to same-origin /docs URLs", () => {
  assert.equal(docsHref("/quickstart"), "/docs/quickstart");
  assert.equal(docsHref("sdk/logging"), "/docs/sdk/logging");
  assert.equal(docsHref("/api-reference/platform/get-health"), "/docs/api-reference/platform/get-health");
  assert.equal(docsHref("https://instantml.ai"), "https://instantml.ai");
  assert.equal(docsHref("#steps"), "#steps");
  assert.equal(mapDocsAssetSrc("/images/product/dashboard-runs.png"), "/docs/assets/images/product/dashboard-runs.png");
});

test("docs parser extracts frontmatter, headings, images, cards, and code", () => {
  const parsed = parseDocsMdx(`---
title: "Example Page"
description: "Example docs"
---

![Dashboard](/images/product/dashboard-runs.png)

<CardGroup cols={2}>
  <Card title="Quickstart" icon="rocket" href="/quickstart">
    Start quickly.
  </Card>
</CardGroup>

## Log metrics

Use \`run.log\` from Python.

\`\`\`python
run.log({"loss": 0.1}, step=1)
\`\`\`
`);

  assert.equal(parsed.frontmatter.title, "Example Page");
  assert.equal(parsed.blocks.find((block) => block.type === "image")?.src, "/images/product/dashboard-runs.png");
  assert.equal(parsed.blocks.find((block) => block.type === "cards")?.cards[0].href, "/quickstart");
  assert.equal(parsed.blocks.find((block) => block.type === "heading")?.id, "log-metrics");
  assert.equal(parsed.blocks.find((block) => block.type === "code")?.language, "python");
});

test("docs loader can read an MDX page and the generated API reference", async () => {
  const logging = await loadDocsPage(["sdk", "logging"]);
  assert.equal(logging.kind, "mdx");
  assert.equal(logging.path, "sdk/logging");
  assert.ok(logging.blocks.length > 0);

  const apiReference = await loadDocsPage(["api-reference", "platform", "get-health"]);
  assert.equal(apiReference.kind, "api-reference");
  assert.ok(apiReference.endpoints.length > 0);
});
