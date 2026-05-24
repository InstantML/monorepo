import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  docsHref,
  docsMarkdownPathForSlug,
  docsPathForSlug,
  loadDocsMarkdown,
  loadDocsMarkdownFull,
  loadDocsMarkdownIndex,
  loadDocsPage,
  mapDocsAssetSrc,
  parseDocsMdx,
} from "../src/docs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");

test("docs app route renders docs source instead of redirecting to a docs host", async () => {
  const route = await readFile(path.join(webRoot, "app", "docs", "[[...slug]]", "page.tsx"), "utf8");
  const agentButton = await readFile(path.join(webRoot, "app", "docs", "docs-agent-markdown-button.tsx"), "utf8");
  const codeBlock = await readFile(path.join(webRoot, "app", "docs", "docs-code-block.tsx"), "utf8");
  const styles = await readFile(path.join(webRoot, "app", "styles", "docs.css"), "utf8");
  assert.match(route, /loadDocsPage/);
  assert.match(route, /DocsSidebar/);
  assert.match(route, /DocsCodeBlock/);
  assert.match(route, /DocsAgentMarkdownButton/);
  assert.match(route, /Open \.md/);
  assert.match(agentButton, /fetch\(href/);
  assert.match(agentButton, /Copy \.md for agent/);
  assert.match(codeBlock, /navigator\.clipboard\.writeText/);
  // After the Stripe-style restructure (#92), the shell is a two-column grid
  // sized via a CSS variable instead of an inline clamp(). Assert on the
  // structural shape rather than literal values so future polish doesn't
  // require a test change every time.
  assert.match(styles, /grid-template-columns:\s*(?:var\(--docs-sidebar-width\)|\d|clamp)/);
  assert.doesNotMatch(styles, /max-width:\s*1240px/);
  assert.doesNotMatch(route, /docs\.instantml\.ai|localhost:3001|INSTANTML_DOCS_BASE/);
});

test("first-run onboarding links to human and agent quickstart docs", async () => {
  const authFlow = await readFile(path.join(webRoot, "app", "auth-flow.tsx"), "utf8");
  const emptyWorkspace = await readFile(
    path.join(webRoot, "app", "dashboard", "components", "empty-workspace-snippet.tsx"),
    "utf8",
  );

  assert.match(authFlow, /href="\/docs\/quickstart"/);
  assert.match(authFlow, /href="\/docs\/quickstart\.md"/);
  assert.match(authFlow, /paste[\s\S]*quickstart\.md[\s\S]*to your agent/);
  assert.match(emptyWorkspace, /href="\/docs\/quickstart"/);
  assert.match(emptyWorkspace, /href="\/docs\/quickstart\.md"/);
  assert.match(emptyWorkspace, /paste[\s\S]*quickstart\.md[\s\S]*to your agent/);
});

test("docs routes bypass Clerk proxy middleware", async () => {
  const proxy = await readFile(path.join(webRoot, "proxy.ts"), "utf8");
  assert.match(proxy, /\(\?!_next\|docs\|/);
  assert.match(proxy, /txt\|xml\|webmanifest/);
});

test("docs asset route serves images from the docs source tree", async () => {
  const route = await readFile(path.join(webRoot, "app", "docs", "assets", "[...path]", "route.ts"), "utf8");
  assert.match(route, /docsImagesRoot/);
  assert.match(route, /Content-Type/);
});

test("docs markdown mirrors are routed from /docs/*.md", async () => {
  const config = await readFile(path.join(webRoot, "next.config.mjs"), "utf8");
  const route = await readFile(path.join(webRoot, "app", "docs-md", "[[...slug]]", "route.ts"), "utf8");
  const llms = await readFile(path.join(webRoot, "app", "llms.txt", "route.ts"), "utf8");
  const llmsFull = await readFile(path.join(webRoot, "app", "llms-full.txt", "route.ts"), "utf8");

  assert.match(config, /source: "\/docs\/:path\*\.md"/);
  assert.match(config, /destination: "\/docs-md\/:path\*\.md"/);
  assert.match(route, /loadDocsMarkdown/);
  assert.match(route, /text\/markdown/);
  assert.match(llms, /loadDocsMarkdownIndex/);
  assert.match(llmsFull, /loadDocsMarkdownFull/);
});

test("main app navigation links to the same-origin docs route", async () => {
  const landing = await readFile(path.join(webRoot, "components", "landing", "LandingPage.tsx"), "utf8");
  const topbar = await readFile(path.join(webRoot, "app", "dashboard", "chrome", "topbar.tsx"), "utf8");
  const navRail = await readFile(path.join(webRoot, "app", "dashboard", "chrome", "nav-rail.tsx"), "utf8");

  assert.match(landing, /href="\/docs"/);
  assert.match(topbar, /href="\/docs"/);
  assert.match(navRail, /href="\/docs"/);
  assert.doesNotMatch(`${landing}\n${topbar}\n${navRail}`, /docs\.instantml\.ai/);
});

test("docs slug paths are normalized and reject traversal", () => {
  assert.equal(docsPathForSlug([]), "index");
  assert.equal(docsPathForSlug(["sdk", "logging"]), "sdk/logging");
  assert.equal(docsPathForSlug(["api-reference", "platform", "get-health"]), "api-reference");
  assert.equal(docsMarkdownPathForSlug(["quickstart.md"]), "quickstart");
  assert.equal(docsMarkdownPathForSlug(["sdk", "logging.md"]), "sdk/logging");
  assert.equal(docsMarkdownPathForSlug(["api-reference", "platform", "get-health.md"]), "api-reference");
  assert.throws(() => docsPathForSlug([".."]), /Unsafe docs slug segment/);
  assert.throws(() => docsPathForSlug(["sdk/logging"]), /Unsafe docs slug segment/);
  assert.throws(() => docsMarkdownPathForSlug(["../quickstart.md"]), /Unsafe docs slug segment/);
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

test("docs markdown loader mirrors pages and agent indexes", async () => {
  const quickstart = await loadDocsMarkdown(["quickstart.md"]);
  assert.equal(quickstart.path, "quickstart");
  assert.match(quickstart.markdown, /^# Quickstart/m);
  assert.doesNotMatch(quickstart.markdown, /^---/);
  assert.match(quickstart.markdown, /instantml login/);
  assert.match(quickstart.markdown, /## Agent navigation/);
  assert.match(quickstart.markdown, /\[Logging\]\(\/docs\/sdk\/logging\.md\)/);
  assert.match(quickstart.markdown, /\[Quickstart\]\(\/docs\/quickstart\.md\) \(current page\)/);

  const apiReference = await loadDocsMarkdown(["api-reference.md"]);
  assert.match(apiReference.markdown, /^# API Reference/m);
  assert.match(apiReference.markdown, /## GET \/health/);
  assert.match(apiReference.markdown, /\[Quickstart\]\(\/docs\/quickstart\.md\)/);

  const index = await loadDocsMarkdownIndex();
  assert.match(index, /\[Quickstart\]\(\/docs\/quickstart\.md\)/);

  const full = await loadDocsMarkdownFull();
  assert.match(full, /Source: \/docs\/quickstart\.md/);
  assert.match(full, /Shadow a W&B run/);
});
