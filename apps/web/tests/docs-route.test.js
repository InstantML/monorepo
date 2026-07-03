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
  loadPublicDocsPages,
  mapDocsAssetSrc,
  mdxToMarkdown,
  pagePathToTitle,
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
  // Assert on structural shape (var(), clamp(), or numeric) so the test
  // doesn't break every time the shell's grid values get polished. Both
  // the PR #91 clamp version and #92's var version satisfy this.
  assert.match(styles, /grid-template-columns:\s*(?:var\(--docs-sidebar-width\)|\d|clamp)/);
  assert.doesNotMatch(styles, /max-width:\s*1240px/);
  assert.doesNotMatch(route, /docs\.instantml\.ai|localhost:3001|INSTANTML_DOCS_BASE/);
});

test("docs routes declare self canonicals and static public rendering", async () => {
  const route = await readFile(path.join(webRoot, "app", "docs", "[[...slug]]", "page.tsx"), "utf8");
  const sitemap = await readFile(path.join(webRoot, "app", "sitemap.ts"), "utf8");

  assert.match(route, /dynamic = "force-static"/);
  assert.match(route, /generateStaticParams/);
  assert.match(route, /loadPublicDocsPages/);
  assert.match(route, /alternates:\s*\{\s*canonical:\s*routePath\s*\}/);
  assert.match(route, /robots:\s*\{\s*index:\s*true,\s*follow:\s*true\s*\}/);
  assert.doesNotMatch(route, /alternates:\s*\{\s*canonical:\s*"\/"\s*\}/);
  assert.match(sitemap, /loadPublicDocsPages/);
  assert.match(sitemap, /docsUrl\(page\.path\)/);
});

test("docs code blocks do not inherit standalone raw pre borders", async () => {
  const docsStyles = await readFile(path.join(webRoot, "app", "styles", "docs.css"), "utf8");
  const preStyles = await Promise.all(
    ["run-detail.css", "dark-overrides.css", "mobile.css"].map((file) =>
      readFile(path.join(webRoot, "app", "styles", file), "utf8"),
    ),
  );

  assert.match(docsStyles, /\.docs-route-code pre\s*\{[\s\S]*?border:\s*0;[\s\S]*?max-height:\s*none;/);
  assert.doesNotMatch(preStyles.join("\n"), /(?:^|\n)\s*pre\s*\{/);
});

test("docs loader caches static filesystem work for server renders", async () => {
  const docs = await readFile(path.join(webRoot, "src", "docs.js"), "utf8");
  assert.match(docs, /from "react"/, "docs loader should use React cache for request-level dedupe");
  assert.match(docs, /loadDocsPageByPath\s*=\s*cache/, "metadata and page loads should dedupe by normalized docs path");
  assert.match(docs, /loadApiReferenceEndpoints\s*=\s*cache/, "generated API reference parsing should be cached");
});

test("public docs page list is derived from docs navigation for sitemap/static params", async () => {
  const pages = await loadPublicDocsPages();
  const paths = pages.map((page) => page.path);

  assert.ok(paths.includes("index"));
  assert.ok(paths.includes("quickstart"));
  assert.ok(paths.includes("guides/wandb-alternative"));
  assert.ok(paths.includes("guides/instantml-vs-mlflow"));
  assert.ok(paths.includes("guides/wandb-import-guide"));
  assert.ok(paths.includes("sdk/logging"));
  assert.ok(paths.includes("dashboard/runs-workspace"));
  assert.ok(paths.includes("api-reference"));
  assert.equal(new Set(paths).size, paths.length);
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

test("first-run code snippet uses a conventional code font stack", async () => {
  const dashboardStyles = await readFile(path.join(webRoot, "app", "styles", "overhaul.css"), "utf8");

  assert.match(dashboardStyles, /--snippet-code-face:\s*ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;/);
  assert.match(
    dashboardStyles,
    /\.empty-workspace-snippet__code\s*\{[\s\S]*?font-size:\s*var\(--fs-body\);[\s\S]*?line-height:\s*1\.65;[\s\S]*?font-family:\s*var\(--snippet-code-face\);/,
  );
});

test("first-run copy buttons share the terminal copy button box", async () => {
  const dashboardStyles = await readFile(path.join(webRoot, "app", "styles", "overhaul.css"), "utf8");

  assert.match(
    dashboardStyles,
    /\.empty-workspace-snippet \.copy-button\s*\{[\s\S]*?height:\s*24px;[\s\S]*?min-height:\s*24px;[\s\S]*?padding:\s*0 9px;[\s\S]*?box-shadow:\s*none;/,
  );
  assert.match(
    dashboardStyles,
    /\.empty-workspace-snippet__term \.iml-copy\s*\{[\s\S]*?height:\s*24px;[\s\S]*?min-height:\s*24px;/,
  );
});

test("docs routes bypass Clerk proxy middleware", async () => {
  const proxy = await readFile(path.join(webRoot, "proxy.ts"), "utf8");
  assert.match(proxy, /_next/);
  assert.match(proxy, /docs/);
  assert.match(proxy, /INSTANTML_WEB_EXPLICIT_API_BASES/);
  assert.match(proxy, /NextResponse\.next/);
  assert.match(proxy, /__clerk/);
});

test("local explicit API-base runs bypass Clerk proxy when Clerk is unconfigured", async () => {
  const proxy = await readFile(path.join(webRoot, "proxy.ts"), "utf8");
  assert.match(proxy, /usesExplicitLocalApiBases/);
  assert.match(proxy, /configuredApiBasesAreLoopback/);
  assert.match(proxy, /isLoopbackHostname/);
  assert.match(proxy, /new URL/);
  assert.match(proxy, /INSTANTML_CONTROL_API_BASE/);
  assert.match(proxy, /INSTANTML_DATA_API_BASE/);
  assert.match(proxy, /hasClerkRuntimeConfig/);
  assert.match(proxy, /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
  assert.match(proxy, /CLERK_SECRET_KEY/);
  assert.match(proxy, /NextResponse\.next/);
});

test("API rewrites bypass Clerk proxy middleware", async () => {
  const proxy = await readFile(path.join(webRoot, "proxy.ts"), "utf8");
  assert.match(proxy, /\(?!_next\|api\|trpc\|docs/);
  assert.doesNotMatch(proxy, /"\/\(api\|trpc/);
});

test("docs asset route serves images from the docs source tree", async () => {
  const route = await readFile(path.join(webRoot, "app", "docs", "assets", "[...path]", "route.ts"), "utf8");
  assert.match(route, /docsImagesRoot/);
  assert.match(route, /Content-Type/);
  assert.match(route, /Content-Disposition/);
  assert.match(route, /Content-Security-Policy/);
  assert.match(route, /X-Content-Type-Options/);
  assert.match(route, /\.svg/);
  assert.match(route, /sandbox/);
  assert.match(route, /nosniff/);
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
  const navRail = await readFile(path.join(webRoot, "app", "dashboard", "chrome", "nav-rail.tsx"), "utf8");

  // Dashboard topbar no longer carries a docs link — the dedicated icon
  // button was removed to declutter the brand bar. Mobile users still
  // reach docs via the nav-rail; the landing page still links to it.
  assert.match(landing, /href="\/docs"/);
  assert.match(navRail, /href="\/docs"/);
  assert.doesNotMatch(`${landing}\n${navRail}`, /docs\.instantml\.ai/);
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

test("docs navigation title overrides preserve source branding", () => {
  assert.equal(pagePathToTitle("guides/wandb-alternative"), "W&B alternative");
  assert.equal(pagePathToTitle("guides/wandb-import-guide"), "W&B import guide");
  assert.equal(pagePathToTitle("guides/instantml-vs-mlflow"), "InstantML vs MLflow");
  assert.equal(pagePathToTitle("guides/wandb-neptune-imports"), "W&B and Neptune imports");
  assert.equal(pagePathToTitle("guides/export-usage-limits"), "Export Usage Limits");
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

test("docs parser extracts Note/Tip/Warning/Info callouts as callout blocks", () => {
  const parsed = parseDocsMdx(`---
title: "Callouts"
---

<Note>Single-line note with \`inline code\`.</Note>

<Warning>
Keys are shown once. Copy the value
before closing the dialog.
</Warning>

Regular paragraph after callouts.
`);

  const callouts = parsed.blocks.filter((block) => block.type === "callout");
  assert.equal(callouts.length, 2);
  assert.equal(callouts[0].kind, "note");
  assert.equal(callouts[0].text, "Single-line note with `inline code`.");
  assert.equal(callouts[1].kind, "warning");
  assert.equal(callouts[1].text, "Keys are shown once. Copy the value before closing the dialog.");
  assert.ok(parsed.blocks.some((block) => block.type === "paragraph" && block.text.startsWith("Regular paragraph")));
});

test("docs markdown mirrors degrade callouts to labeled blockquotes", () => {
  const markdown = mdxToMarkdown(`---
title: "Callouts"
---

<Tip>
Use \`instantml login\` on interactive machines.
</Tip>
`);

  assert.match(markdown, /^> \*\*Tip:\*\* Use `instantml login` on interactive machines\.$/m);
  assert.ok(!markdown.includes("<Tip>"));
});

test("public docs card icons are mapped by the same-origin docs renderer", async () => {
  const route = await readFile(path.join(webRoot, "app", "docs", "[[...slug]]", "page.tsx"), "utf8");
  const mappedIcons = new Set(
    [...route.matchAll(/^\s*(?:"([^"]+)"|([a-z][a-z0-9-]*)):\s*[A-Z][A-Za-z0-9]*/gm)].map(
      (match) => match[1] ?? match[2],
    ),
  );
  const cardIcons = new Set();

  for (const page of await loadPublicDocsPages()) {
    const slug = page.path === "index" ? [] : page.path.split("/");
    const docsPage = await loadDocsPage(slug);
    if (docsPage.kind !== "mdx") continue;
    for (const block of docsPage.blocks) {
      if (block.type !== "cards") continue;
      for (const card of block.cards) {
        if (card.icon) cardIcons.add(card.icon);
      }
    }
  }

  const missing = [...cardIcons].filter((icon) => !mappedIcons.has(icon)).sort();
  assert.deepEqual(missing, []);
});

test("docs parser joins wrapped list item continuation lines", () => {
  const parsed = parseDocsMdx(`---
title: "Lists"
---

- Paid signup redirects through Stripe Checkout before writes and SDK key
  creation are unlocked.
- Settings shows plan, usage, rate limits, seats, storage accounting, and
  billing controls.

1. Open Run Detail and choose a checkpoint
   before creating the fork.
2. Attach the SDK to the child run.
`);

  const lists = parsed.blocks.filter((block) => block.type === "list");
  assert.deepEqual(lists[0]?.items, [
    "Paid signup redirects through Stripe Checkout before writes and SDK key creation are unlocked.",
    "Settings shows plan, usage, rate limits, seats, storage accounting, and billing controls.",
  ]);
  assert.deepEqual(lists[1]?.items, [
    "Open Run Detail and choose a checkpoint before creating the fork.",
    "Attach the SDK to the child run.",
  ]);
});

test("docs parser keeps nested list lines attached to their parent item", () => {
  const parsed = parseDocsMdx(`---
title: "Nested Lists"
---

- Parent item
  - Child item
    with wrapped child context.
- Sibling item
`);

  const lists = parsed.blocks.filter((block) => block.type === "list");
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0]?.items, [
    "Parent item - Child item with wrapped child context.",
    "Sibling item",
  ]);
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

test("dashboard workflow docs expose product screenshots through the route parser", async () => {
  const artifacts = await loadDocsPage(["dashboard", "artifacts-files"]);
  const artifactImages = artifacts.blocks.filter((block) => block.type === "image").map((block) => block.src);
  assert.ok(artifactImages.includes("/images/product/dashboard-artifacts-evidence.png"));
  assert.ok(artifactImages.includes("/images/product/dashboard-artifacts-browser.png"));
  assert.ok(artifactImages.includes("/images/product/dashboard-checkpoint-fork.png"));
  assert.ok(artifactImages.includes("/images/product/dashboard-lineage-graph.png"));

  const tour = await loadDocsPage(["dashboard", "tour"]);
  const tourImages = tour.blocks.filter((block) => block.type === "image").map((block) => block.src);
  assert.ok(tourImages.includes("/images/product/dashboard-artifacts-browser.png"));
  assert.ok(tourImages.includes("/images/product/dashboard-reports-editor.png"));
});

test("import docs describe metadata-only artifact bundles", async () => {
  const importsGuide = await loadDocsMarkdown(["guides", "imports.md"]);
  assert.match(importsGuide.markdown, /artifact references only[\s\S]*never copy source artifact bytes/);
  assert.match(importsGuide.markdown, /downloads stay unavailable until you upload the actual bytes/);

  const importApi = await loadDocsMarkdown(["api", "import-export-usage.md"]);
  assert.match(importApi.markdown, /metadata-only/);
});

test("buyer-intent docs expose comparison and W&B import guidance", async () => {
  const wandbAlternative = await loadDocsMarkdown(["guides", "wandb-alternative.md"]);
  assert.match(wandbAlternative.markdown, /^# W&B alternative/m);
  assert.match(wandbAlternative.markdown, /W&B-style/);
  assert.match(wandbAlternative.markdown, /\[W&B import guide\]\(\/docs\/guides\/wandb-import-guide\.md\)/);
  assert.match(wandbAlternative.markdown, /\(\/docs\/benchmarks\.md\)/);

  const mlflowComparison = await loadDocsMarkdown(["guides", "instantml-vs-mlflow.md"]);
  assert.match(mlflowComparison.markdown, /^# InstantML vs MLflow/m);
  assert.match(mlflowComparison.markdown, /hosted-first training observability/);
  assert.match(mlflowComparison.markdown, /open-source experiment tracking/);

  const wandbImportGuide = await loadDocsMarkdown(["guides", "wandb-import-guide.md"]);
  assert.match(wandbImportGuide.markdown, /^# W&B import guide/m);
  assert.match(wandbImportGuide.markdown, /credentials never reach InstantML servers/);
  assert.match(wandbImportGuide.markdown, /instantml import wandb/);
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
  assert.match(full, /Shadow W&B alongside InstantML/);
});
