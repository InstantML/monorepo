import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import { fileURLToPath } from "node:url";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const srcDir = path.dirname(fileURLToPath(import.meta.url));

export const docsRoot = resolveDocsRoot();
export const repoRoot = path.resolve(docsRoot, "..", "..");
export const docsImagesRoot = path.join(docsRoot, "images");

export function docsPathForSlug(slug = []) {
  const parts = Array.isArray(slug) ? slug : [];
  const cleanParts = parts
    .map((part) => decodeURIComponent(String(part)))
    .filter(Boolean);
  for (const part of cleanParts) {
    if (part === "." || part === ".." || part.startsWith(".") || part.includes("/") || part.includes("\\")) {
      throw new Error(`Unsafe docs slug segment: ${part}`);
    }
  }
  if (cleanParts.length === 0) return "index";
  if (cleanParts[0] === "api-reference") return "api-reference";
  return cleanParts.join("/");
}

export function docsMarkdownPathForSlug(slug = []) {
  const parts = Array.isArray(slug) ? slug : [];
  const cleanParts = parts.map((part) => String(part));
  if (cleanParts.length > 0) {
    const lastIndex = cleanParts.length - 1;
    cleanParts[lastIndex] = cleanParts[lastIndex].replace(/\.md$/i, "");
  }
  return docsPathForSlug(cleanParts);
}

export function docsHref(href = "") {
  if (!href) return "#";
  if (/^(https?:|mailto:|tel:)/i.test(href) || href.startsWith("#")) return href;
  if (href.startsWith("/docs")) return href;
  if (href.startsWith("/images/")) return mapDocsAssetSrc(href);
  if (href === "/") return "/docs";
  const normalized = href.startsWith("/") ? href : `/${href}`;
  return `/docs${normalized}`.replace(/\/index$/, "");
}

export function mapDocsAssetSrc(src = "") {
  if (src.startsWith("/images/")) return `/docs/assets${src}`;
  return src;
}

export const loadDocsConfig = cache(async function loadDocsConfig() {
  return JSON.parse(await readFile(path.join(docsRoot, "docs.json"), "utf8"));
});

export async function loadDocsPage(slug = []) {
  const pagePath = docsPathForSlug(slug);
  return loadDocsPageByPath(pagePath);
}

const loadDocsPageByPath = cache(async function loadDocsPageByPath(pagePath) {
  const config = await loadDocsConfig();
  const navigation = flattenDocsNavigation(config);
  if (pagePath === "api-reference") {
    return {
      kind: "api-reference",
      path: pagePath,
      title: "API Reference",
      description: "Public InstantML API routes generated from the Rust service OpenAPI specification.",
      navigation,
      endpoints: await loadApiReferenceEndpoints(),
    };
  }

  const filePath = safeJoin(docsRoot, `${pagePath}.mdx`);
  const raw = await readFile(filePath, "utf8");
  const parsed = parseDocsMdx(raw);
  return {
    kind: "mdx",
    path: pagePath,
    title: parsed.frontmatter.title || pagePathToTitle(pagePath),
    description: parsed.frontmatter.description || "",
    navigation,
    ...parsed,
  };
});

export async function loadDocsMarkdown(slug = [], options = {}) {
  const includeNavigation = options.includeNavigation ?? true;
  const pagePath = docsMarkdownPathForSlug(slug);
  return loadDocsMarkdownByPath(pagePath, includeNavigation);
}

const loadDocsMarkdownByPath = cache(async function loadDocsMarkdownByPath(pagePath, includeNavigation) {
  if (pagePath === "api-reference") {
    const markdown = await apiReferenceMarkdown();
    return {
      path: pagePath,
      title: "API Reference",
      markdown: includeNavigation ? await appendMarkdownNavigation(markdown, pagePath) : markdown,
    };
  }

  const filePath = safeJoin(docsRoot, `${pagePath}.mdx`);
  const raw = await readFile(filePath, "utf8");
  const parsed = parseDocsMdx(raw);
  return {
    path: pagePath,
    title: parsed.frontmatter.title || pagePathToTitle(pagePath),
    markdown: includeNavigation ? await appendMarkdownNavigation(mdxToMarkdown(raw), pagePath) : mdxToMarkdown(raw),
  };
});

export async function loadDocsMarkdownIndex() {
  const pages = await markdownPagesFromConfig();
  const lines = [
    "# InstantML Docs",
    "",
    "Agent-readable Markdown mirrors for the public InstantML documentation.",
    "",
    "- [Full documentation bundle](/llms-full.txt)",
    "",
    "## Pages",
    "",
  ];
  for (const page of pages) {
    lines.push(`- [${page.title}](${docsMarkdownUrl(page.path)})`);
  }
  return lines.join("\n").trimEnd() + "\n";
}

export async function loadDocsMarkdownFull() {
  const pages = await markdownPagesFromConfig();
  const sections = [
    "# InstantML Docs",
    "",
    "This file concatenates the public InstantML docs for agents and offline readers.",
  ];
  for (const page of pages) {
    const slug = page.path.split("/");
    slug[slug.length - 1] = `${slug[slug.length - 1]}.md`;
    const markdown = await loadDocsMarkdown(slug, { includeNavigation: false });
    sections.push(
      "",
      "---",
      "",
      `Source: ${docsMarkdownUrl(page.path)}`,
      "",
      markdown.markdown.trimEnd(),
    );
  }
  return sections.join("\n").trimEnd() + "\n";
}

export function flattenDocsNavigation(config) {
  const tabs = config?.navigation?.tabs ?? [];
  return tabs.map((tab) => {
    if (tab.openapi) {
      return {
        tab: tab.tab,
        groups: [
          {
            group: "Generated reference",
            pages: [{ path: "api-reference", title: "API Reference" }],
          },
        ],
      };
    }
    return {
      tab: tab.tab,
      groups: (tab.groups ?? []).map((group) => ({
        group: group.group,
        pages: (group.pages ?? []).map((page) => ({
          path: page,
          title: pagePathToTitle(page),
        })),
      })),
    };
  });
}

export function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const frontmatter = {};
  for (const line of raw.slice(4, end).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    frontmatter[key] = stripQuotes(value);
  }
  return {
    frontmatter,
    body: raw.slice(end + 5).replace(/^\r?\n/, ""),
  };
}

export function parseDocsMdx(raw) {
  const { frontmatter, body } = parseFrontmatter(raw);
  const lines = body.split(/\r?\n/);
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("<CardGroup")) {
      const collected = [];
      while (index < lines.length) {
        collected.push(lines[index]);
        if (lines[index].trim() === "</CardGroup>") {
          index += 1;
          break;
        }
        index += 1;
      }
      blocks.push(parseCardGroup(collected.join("\n")));
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
        id: slugifyHeading(heading[2]),
      });
      index += 1;
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(trimmed);
    if (image) {
      blocks.push({ type: "image", alt: image[1], src: image[2] });
      index += 1;
      continue;
    }

    const fence = /^```(\S*)/.exec(trimmed);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", language: fence[1] || "text", code: code.join("\n") });
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      blocks.push(parseTable(tableLines));
      continue;
    }

    if (/^-\s+/.test(trimmed)) {
      const parsed = parseList(lines, index, /^-\s+(.+)$/);
      blocks.push({ type: "list", ordered: false, items: parsed.items });
      index = parsed.nextIndex;
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const parsed = parseList(lines, index, /^\d+\.\s+(.+)$/);
      blocks.push({ type: "list", ordered: true, items: parsed.items });
      index = parsed.nextIndex;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !startsSpecialBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    }
  }

  return { frontmatter, blocks };
}

function parseList(lines, startIndex, markerPattern) {
  const items = [];
  let index = startIndex;
  const baseIndent = leadingWhitespaceCount(lines[startIndex] ?? "");

  while (index < lines.length) {
    const line = lines[index];
    if (leadingWhitespaceCount(line) !== baseIndent) break;
    const itemMatch = markerPattern.exec(line.slice(baseIndent));
    if (!itemMatch) break;
    const parts = [itemMatch[1]];
    index += 1;

    while (index < lines.length) {
      const continuation = lines[index];
      const trimmed = continuation.trim();
      if (!trimmed) break;
      if (leadingWhitespaceCount(continuation) <= baseIndent) break;
      parts.push(trimmed);
      index += 1;
    }

    items.push(parts.join(" "));
  }

  return { items, nextIndex: index };
}

function leadingWhitespaceCount(value) {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function pagePathToTitle(pagePath) {
  if (pagePath === "index") return "Overview";
  if (pagePath === "api-reference") return "API Reference";
  const last = pagePath.split("/").at(-1) ?? pagePath;
  return last
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const loadApiReferenceEndpoints = cache(async function loadApiReferenceEndpoints() {
  const spec = JSON.parse(await readFile(path.join(docsRoot, "openapi.json"), "utf8"));
  const endpoints = [];
  for (const [route, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      endpoints.push({
        method: method.toUpperCase(),
        path: route,
        summary: operation.summary || operation.description || `${method.toUpperCase()} ${route}`,
        tags: operation.tags ?? [],
        parameters: (operation.parameters ?? []).map((parameter) => ({
          name: parameter.name,
          in: parameter.in,
          required: Boolean(parameter.required),
          description: parameter.description || "",
        })),
        requestBody: Boolean(operation.requestBody),
        responseCodes: Object.keys(operation.responses ?? {}),
        security: (operation.security ?? []).flatMap((entry) => Object.keys(entry)),
      });
    }
  }
  return endpoints.sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
});

async function apiReferenceMarkdown() {
  const endpoints = await loadApiReferenceEndpoints();
  return [
    "# API Reference",
    "",
    "Public InstantML API routes generated from the Rust service OpenAPI specification.",
    "",
    ...endpoints.flatMap((endpoint) => [
      `## ${endpoint.method} ${endpoint.path}`,
      "",
      endpoint.summary,
      "",
      endpoint.tags?.length ? `Tags: ${endpoint.tags.join(", ")}` : "",
      endpoint.security?.length ? `Auth: ${endpoint.security.join(", ")}` : "",
      endpoint.parameters?.length
        ? `Parameters: ${endpoint.parameters.map((parameter) => `${parameter.name}${parameter.required ? " (required)" : ""}`).join(", ")}`
        : "",
      endpoint.requestBody ? "Request body: yes" : "",
      endpoint.responseCodes?.length ? `Responses: ${endpoint.responseCodes.join(", ")}` : "",
      "",
    ]),
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n").trimEnd() + "\n";
}

const markdownPagesFromConfig = cache(async function markdownPagesFromConfig() {
  const config = await loadDocsConfig();
  const navigation = flattenDocsNavigation(config);
  const pages = [];
  const seen = new Set();
  for (const tab of navigation) {
    for (const group of tab.groups) {
      for (const page of group.pages) {
        if (seen.has(page.path)) continue;
        seen.add(page.path);
        pages.push(page);
      }
    }
  }
  return pages;
});

export function docsMarkdownUrl(pagePath) {
  if (pagePath === "index") return "/docs/index.md";
  return `/docs/${pagePath}.md`;
}

async function appendMarkdownNavigation(markdown, currentPath) {
  const config = await loadDocsConfig();
  const navigation = flattenDocsNavigation(config);
  const lines = [
    "",
    "## Agent navigation",
    "",
    "- [Docs index](/llms.txt)",
    "- [Full docs bundle](/llms-full.txt)",
  ];

  for (const tab of navigation) {
    lines.push("", `### ${tab.tab}`, "");
    for (const group of tab.groups) {
      if (tab.groups.length > 1) lines.push(`**${group.group}**`, "");
      for (const page of group.pages) {
        const current = page.path === currentPath ? " (current page)" : "";
        lines.push(`- [${page.title}](${docsMarkdownUrl(page.path)})${current}`);
      }
    }
  }

  return markdown.trimEnd() + "\n" + lines.join("\n").trimEnd() + "\n";
}

function mdxToMarkdown(raw) {
  const { body } = parseFrontmatter(raw);
  return normalizeMarkdownLinks(
    body.replace(/<CardGroup[^>]*>([\s\S]*?)<\/CardGroup>/g, (_match, inner) => {
      const cards = parseCardGroup(`<CardGroup>${inner}</CardGroup>`).cards;
      return cards.map((card) => `- [${card.title}](${docsMarkdownHref(card.href)}): ${card.description}`).join("\n");
    }),
  ).trimEnd() + "\n";
}

function normalizeMarkdownLinks(markdown) {
  return markdown.replace(/(!?)\[([^\]]+)\]\(([^)]+)\)/g, (_match, bang, label, href) => {
    const mapped = bang ? mapMarkdownImageSrc(href) : docsMarkdownHref(href);
    return `${bang}[${label}](${mapped})`;
  });
}

function mapMarkdownImageSrc(src = "") {
  if (src.startsWith("/images/")) return `/docs/assets${src}`;
  return src;
}

function docsMarkdownHref(href = "") {
  if (!href) return "#";
  if (/^(https?:|mailto:|tel:)/i.test(href) || href.startsWith("#")) return href;
  if (href.startsWith("/docs/assets/")) return href;
  if (href.startsWith("/images/")) return mapMarkdownImageSrc(href);
  if (href === "/" || href === "/docs") return "/docs/index.md";
  if (href.startsWith("/docs/")) {
    const path = href.slice("/docs/".length).replace(/\/$/, "");
    if (!path || path === "index") return "/docs/index.md";
    if (path.startsWith("api-reference")) return "/docs/api-reference.md";
    return `/docs/${path.replace(/\.md$/i, "")}.md`;
  }
  const normalized = href.startsWith("/") ? href.slice(1) : href;
  if (normalized.startsWith("api-reference")) return "/docs/api-reference.md";
  return `/docs/${normalized.replace(/\/index$/, "").replace(/\.md$/i, "")}.md`;
}

function parseCardGroup(source) {
  const cards = [];
  const cardPattern = /<Card\s+([^>]*)>([\s\S]*?)<\/Card>/g;
  for (const match of source.matchAll(cardPattern)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[attr[1]] = attr[2];
    }
    cards.push({
      title: attrs.title ?? "Docs",
      icon: attrs.icon ?? "",
      href: attrs.href ?? "#",
      description: match[2].replace(/\s+/g, " ").trim(),
    });
  }
  return { type: "cards", cards };
}

function parseTable(lines) {
  const rows = lines
    .filter((line, index) => index !== 1)
    .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  const [headers = [], ...bodyRows] = rows;
  return { type: "table", headers, rows: bodyRows };
}

function isTableStart(lines, index) {
  return (
    lines[index]?.trim().startsWith("|") &&
    /^\|?\s*:?-{3,}/.test(lines[index + 1]?.trim() ?? "")
  );
}

function startsSpecialBlock(lines, index) {
  const trimmed = lines[index].trim();
  return (
    /^#{1,4}\s+/.test(trimmed) ||
    /^!\[/.test(trimmed) ||
    /^```/.test(trimmed) ||
    /^-\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed) ||
    trimmed.startsWith("|") ||
    trimmed.startsWith("<CardGroup")
  );
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function safeJoin(root, relativePath) {
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes docs root: ${relativePath}`);
  }
  return candidate;
}

function resolveDocsRoot() {
  const candidates = [
    path.resolve(process.cwd(), "..", "docs"),
    path.resolve(process.cwd(), "apps", "docs"),
    path.resolve(srcDir, "..", "..", "docs"),
    path.resolve(srcDir, "..", "..", "..", "apps", "docs"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "docs.json"))) ?? candidates[0];
}
