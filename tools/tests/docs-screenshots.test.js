import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const docsRoot = path.join(repoRoot, "apps", "docs");
const productDir = path.join(docsRoot, "images", "product");
const productImagePattern = /\/images\/product\/([A-Za-z0-9._-]+\.png)/g;
const expectedScreenshotWidth = 1440;
const expectedScreenshotHeight = 1000;

async function listFiles(dir, extensions) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [entryPath] : [];
  }));
  return files.flat();
}

async function productImageReferences() {
  const docsFiles = await listFiles(docsRoot, [".md", ".mdx"]);
  const references = new Set();
  for (const filePath of docsFiles) {
    const source = await readFile(filePath, "utf8");
    for (const match of source.matchAll(productImagePattern)) {
      references.add(match[1]);
    }
  }
  return references;
}

function pngDimensions(buffer) {
  assert.equal(buffer.toString("ascii", 1, 4), "PNG", "product screenshots must be PNG files");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

test("public docs product screenshot references resolve", async () => {
  const references = await productImageReferences();
  assert.ok(references.size > 0, "expected public docs to reference product screenshots");

  for (const fileName of references) {
    const imagePath = path.join(productDir, fileName);
    const info = await stat(imagePath);
    assert.ok(info.isFile(), `${fileName} should exist`);
  }
});

test("public product screenshots are intentionally referenced", async () => {
  const references = await productImageReferences();
  const productImages = (await readdir(productDir))
    .filter((fileName) => fileName.endsWith(".png"))
    .sort();
  const unused = productImages.filter((fileName) => !references.has(fileName));

  assert.deepEqual(unused, [], `unused public product screenshots: ${unused.join(", ")}`);
});

test("public product screenshots use current dashboard capture dimensions", async () => {
  const productImages = (await readdir(productDir))
    .filter((fileName) => fileName.endsWith(".png"))
    .sort();

  for (const fileName of productImages) {
    const imagePath = path.join(productDir, fileName);
    const [buffer, info] = await Promise.all([readFile(imagePath), stat(imagePath)]);
    const { width, height } = pngDimensions(buffer);

    assert.equal(width, expectedScreenshotWidth, `${fileName} should be a ${expectedScreenshotWidth}px-wide dashboard capture`);
    assert.equal(height, expectedScreenshotHeight, `${fileName} should be a ${expectedScreenshotHeight}px-tall dashboard capture`);
    assert.ok(info.size > 50_000, `${fileName} is suspiciously small for a product screenshot`);
  }
});
