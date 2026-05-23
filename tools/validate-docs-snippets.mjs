import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = resolve("apps/docs");

const forbiddenSnippetPatterns = [
  {
    pattern: /instantml\s+login\s+--base-url\b/,
    message: "Use `instantml login --api-host`, not `--base-url`.",
  },
  {
    pattern: /ro\.init\([^)]*base_url=["']http:\/\/127\.0\.0\.1:8000["']/s,
    message: "Public docs must not point SDK snippets at a local API.",
  },
  {
    pattern: /run\.log_text\(\s*["'][^"']+["']\s*,/s,
    message: "`Run.log_text` expects a dictionary, for example `run.log_text({\"key\": \"value\"})`.",
  },
  {
    pattern: /run\.log_table\([^)]*rows\s*=/s,
    message: "Preview tables should use `log_table_object(...)` or `ro.Table`, not `log_table(..., rows=...)`.",
  },
];

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      files.push(path);
    }
  }
  return files;
}

export function findSnippetViolations(files, patterns = forbiddenSnippetPatterns) {
  const violations = [];
  for (const file of files) {
    for (const { pattern, message } of patterns) {
      if (pattern.test(file.content)) {
        violations.push({ path: file.path, message });
      }
    }
  }
  return violations;
}

async function main() {
  const files = await listFiles(docsRoot);
  const contents = await Promise.all(
    files.map(async (path) => ({
      path,
      content: await readFile(path, "utf8"),
    })),
  );
  const violations = findSnippetViolations(contents);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(`[docs:snippets] ${violation.path}: ${violation.message}\n`);
    }
    process.exit(1);
  }
  process.stderr.write(`[docs:snippets] OK: checked ${files.length} MDX files.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[docs:snippets] ${err.message ?? err}\n`);
    process.exit(1);
  });
}
