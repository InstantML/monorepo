function pythonString(value) {
  return JSON.stringify(String(value));
}

function pythonLiteral(value, indent = 0) {
  const pad = " ".repeat(indent);
  const nextPad = " ".repeat(indent + 4);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";
  if (typeof value === "string") return pythonString(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => `${nextPad}${pythonLiteral(item, indent + 4)},`).join("\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([key, item]) => `${nextPad}${pythonString(key)}: ${pythonLiteral(item, indent + 4)},`).join("\n")}\n${pad}}`;
  }
  return pythonString(value);
}

function stableJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rightRotate(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(words[index - 15], 7)
        ^ rightRotate(words[index - 15], 18)
        ^ (words[index - 15] >>> 3);
      const s1 = rightRotate(words[index - 2], 17)
        ^ rightRotate(words[index - 2], 19)
        ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((part) => part.toString(16).padStart(8, "0")).join("");
}

export function checkpointStep(artifact) {
  if (typeof artifact?.step === "number" && Number.isFinite(artifact.step)) return artifact.step;
  const checkpoint = artifact?.metadata?.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const step = checkpoint.step;
  return typeof step === "number" && Number.isFinite(step) ? step : null;
}

function checkpointFileName(artifact) {
  const fallback = artifact?.id ? `${artifact.id}.ckpt` : "checkpoint.ckpt";
  const raw = String(artifact?.name || fallback).split(/[\\/]/).pop() || fallback;
  const clean = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (clean || fallback).slice(0, 96);
}

export function buildCheckpointResumeCode(artifact, run, options = {}) {
  const baseUrl = options.baseUrl || "http://127.0.0.1:8000";
  const apiKey = options.apiKey || "YOUR_INSTANTML_API_KEY";
  const step = checkpointStep(artifact);
  const checkpointRef = {
    source_run_id: run.id,
    source_project: run.project,
    checkpoint_id: artifact.id,
    checkpoint_name: artifact.name,
    checkpoint_step: step,
  };
  const config = {
    ...run.config,
    resume_from_checkpoint: checkpointRef,
  };
  const metadata = {
    resumed_from_checkpoint: checkpointRef,
  };
  const stepSuffix = step === null || step === undefined ? "" : `-step-${step}`;
  const runName = `resume-from-${run.name}${stepSuffix}`;
  const downloadPath = `checkpoints/${checkpointFileName(artifact)}`;

  return `import instantml as im\n\napi = im.Api(base_url=${pythonString(baseUrl)}, api_key=${pythonString(apiKey)})\ncheckpoint_path = api.download_artifact(\n    ${pythonString(artifact.id)},\n    ${pythonString(downloadPath)},\n)\n\nrun = im.init(\n    project="checkpoints",\n    name=${pythonString(runName)},\n    config=${pythonLiteral(config, 4)},\n    tags=["resumed", "checkpoint"],\n    metadata=${pythonLiteral(metadata, 4)},\n)\n\n# Load checkpoint_path with your framework, then continue training and logging to run.\n`;
}

export function defaultForkRunName(artifact, run) {
  const step = checkpointStep(artifact);
  const stepSuffix = step === null || step === undefined ? "" : `-step-${step}`;
  return `fork-of-${run?.name || "run"}${stepSuffix}`;
}

export function buildCheckpointForkBody(artifact, run, options = {}) {
  const step = checkpointStep(artifact);
  const metadata = {};
  const reason = typeof options.reason === "string" ? options.reason.trim() : "";
  if (reason) metadata.reason = reason;
  const body = {
    name: options.name || defaultForkRunName(artifact, run),
    checkpoint_artifact_id: artifact?.id,
    inherit_config: options.inheritConfig !== false,
    metadata,
  };
  if (step !== null && step !== undefined) body.step = step;
  if (Array.isArray(options.tags) && options.tags.length) body.tags = options.tags;
  return body;
}

export function checkpointForkIdempotencyKey(artifact, run, body) {
  const source = {
    artifact_id: artifact?.id ?? "",
    body,
    run_id: run?.id ?? "",
  };
  return `instantml-fork-${sha256Hex(stableJson(source)).slice(0, 32)}`;
}
