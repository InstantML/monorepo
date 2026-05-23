import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

export async function loadDocsConfig() {
  return JSON.parse(await readFile(path.join(docsRoot, "docs.json"), "utf8"));
}

export async function loadDocsPage(slug = []) {
  const pagePath = docsPathForSlug(slug);
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
      const items = [];
      while (index < lines.length && /^-\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^-\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
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

async function loadApiReferenceEndpoints() {
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
      });
    }
  }
  return endpoints.sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
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
