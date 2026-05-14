import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalArtifactStore } from "../src/artifact-store.js";

test("local artifact store reads only real files inside the storage root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rlobs-artifacts-"));
  const root = path.join(dir, "artifacts");
  fs.mkdirSync(root, { recursive: true });
  const store = createLocalArtifactStore(root);

  const stored = store.writeBase64({ name: "../metrics.txt", content_base64: Buffer.from("ok").toString("base64") });
  assert.equal(store.read(stored).toString(), "ok");
  assert.match(path.basename(stored.storage_path), /^[0-9a-f-]+-metrics\.txt$/);
  store.remove(stored.storage_path);
  assert.equal(fs.existsSync(stored.storage_path), false);
  store.remove(null);

  assert.throws(() => store.read({ storage_path: path.join(root, "missing.txt") }), /artifact file not found/);

  const outside = path.join(dir, "outside.txt");
  const link = path.join(root, "outside-link.txt");
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, link);
  assert.throws(() => store.read({ storage_path: link }), /artifact file not found/);

  fs.rmSync(dir, { recursive: true, force: true });
});
