import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { NotFoundError, ValidationError } from "./db.js";

export function createLocalArtifactStore(root) {
  const storageRoot = path.resolve(root);
  return {
    root: storageRoot,
    writeBase64(input) {
      const name = requireNonEmpty(input.name, "artifact name");
      const contentBase64 = requireNonEmpty(input.content_base64, "content_base64");
      const buffer = Buffer.from(contentBase64, "base64");
      if (buffer.length === 0) throw new ValidationError("content_base64 must decode to bytes");
      fs.mkdirSync(storageRoot, { recursive: true });
      const storageName = `${randomUUID()}-${sanitizeName(name)}`;
      const storagePath = path.join(storageRoot, storageName);
      fs.writeFileSync(storagePath, buffer);
      return {
        uri: `rlobs://artifacts/${storageName}`,
        storage_path: storagePath,
        size_bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    },
    read(artifact) {
      if (!artifact.storage_path) throw new NotFoundError("artifact file not found");
      const resolved = path.resolve(artifact.storage_path);
      const realRoot = realPathOrNull(storageRoot);
      const realTarget = realPathOrNull(resolved);
      if (!realRoot || !realTarget || !isWithinRoot(realRoot, realTarget)) throw new NotFoundError("artifact file not found");
      return fs.readFileSync(realTarget);
    },
    remove(storagePath) {
      if (storagePath) fs.rmSync(storagePath, { force: true });
    },
  };
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realPathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function sanitizeName(name) {
  return path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
}

function requireNonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be a non-empty string`);
  return value.trim();
}
