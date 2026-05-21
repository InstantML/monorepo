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

function checkpointMetadataStep(artifact) {
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
  const step = typeof artifact?.step === "number" && Number.isFinite(artifact.step)
    ? artifact.step
    : checkpointMetadataStep(artifact);
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
