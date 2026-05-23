import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { docsImagesRoot } from "../../../../src/docs";

type AssetParams = {
  params: Promise<{ path?: string[] }>;
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

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    const body = await readFile(filePath);
    return new Response(body, {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": contentTypeFor(filePath, body),
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function contentTypeFor(filePath: string, body: Buffer) {
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return "image/png";
  return contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
