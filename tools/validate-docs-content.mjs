import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = resolve(repoRoot, "apps/docs");

export const blockedPublicDocsPatterns = [
  "docs/design",
  "docs/product",
  "docs/architecture",
  "docs/users",
  "PRODUCT_STRATEGY.md",
  "TODO.md",
  "AGENTS.md",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "dev:api",
  "web:dev",
  "docker compose",
  "source checkout",
  "local dev",
  "local server",
];

async function listPublicDocsFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listPublicDocsFiles(path)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".mdx") || entry.name === "docs.json" || entry.name === "openapi.json")
    ) {
      files.push(path);
    }
  }
  return files;
}

export function findInternalDocsReferences(files, patterns = blockedPublicDocsPatterns) {
  const violations = [];
  for (const file of files) {
    for (const pattern of patterns) {
      if (file.content.includes(pattern)) {
        violations.push({ path: file.path, pattern });
      }
    }
  }
  return violations;
}

async function main() {
  const files = await listPublicDocsFiles(docsRoot);
  const contents = await Promise.all(
    files.map(async (path) => ({
      path,
      content: await readFile(path, "utf8"),
    })),
  );
  const violations = findInternalDocsReferences(contents);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        `[docs:content] ${violation.path} contains blocked public docs pattern ${violation.pattern}\n`,
      );
    }
    process.exit(1);
  }
  process.stderr.write(`[docs:content] OK: checked ${files.length} public docs files.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[docs:content] ${err.message ?? err}\n`);
    process.exit(1);
  });
}
