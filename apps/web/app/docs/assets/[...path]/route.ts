import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { docsImagesRoot } from "../../../../src/docs";

type AssetParams = {
  params: Promise<{ path?: string[] }>;
};
type CachedAsset = {
  body: Buffer;
  contentType: string;
  isSvg: boolean;
  lastAccess: number;
  mtimeMs: number;
  size: number;
};

const contentTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ASSET_CACHE_ENTRIES = 64;
const assetCache = new Map<string, CachedAsset>();

export async function GET(_request: Request, { params }: AssetParams) {
  const { path: assetPath = [] } = await params;
  if (!assetPath.length || assetPath[0] !== "images") {
    return new Response("Not found", { status: 404 });
  }

  const safeSegments = assetPath.slice(1);
  if (safeSegments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))) {
    return new Response("Not found", { status: 404 });
  }

  const filePath = path.resolve(docsImagesRoot, ...safeSegments);
  if (filePath !== docsImagesRoot && !filePath.startsWith(`${docsImagesRoot}${path.sep}`)) {
    return new Response("Not found", { status: 404 });
  }

  const asset = await loadDocsAsset(filePath);
  if (!asset) return new Response("Not found", { status: 404 });

  try {
    const headers = new Headers({
      "Cache-Control": "public, max-age=3600",
      "Content-Type": asset.contentType,
    });
    if (asset.isSvg) {
      headers.set("Content-Disposition", "attachment");
      headers.set("Content-Security-Policy", "sandbox");
      headers.set("X-Content-Type-Options", "nosniff");
    }
    return new Response(asset.body, {
      headers,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function loadDocsAsset(filePath: string): Promise<CachedAsset | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const cached = assetCache.get(filePath);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      cached.lastAccess = Date.now();
      return cached;
    }
    const body = await readFile(filePath);
    const asset = {
      body,
      contentType: contentTypeFor(filePath, body),
      isSvg: path.extname(filePath).toLowerCase() === ".svg",
      lastAccess: Date.now(),
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
    assetCache.set(filePath, asset);
    pruneAssetCache();
    return asset;
  } catch {
    return null;
  }
}

function pruneAssetCache() {
  if (assetCache.size <= MAX_ASSET_CACHE_ENTRIES) return;
  const [oldestPath] = [...assetCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0] ?? [];
  if (oldestPath) assetCache.delete(oldestPath);
}

function contentTypeFor(filePath: string, body: Buffer) {
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return "image/png";
  return contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
