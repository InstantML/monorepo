/**
 * Build the unfiltered evidence sections. Split from the search filter so
 * consumers can cache this per (artifacts, objects) — item construction
 * JSON.stringifies every object's metadata for searchText, which is too
 * expensive to redo on every search keystroke.
 * @param {{ artifacts?: any[], objects?: any[] }} input
 */
export function buildEvidenceSectionItems({ artifacts = [], objects = [] } = {}) {
  return [
    {
      id: "checkpoints",
      label: "Checkpoints",
      items: artifacts
        .filter((artifact) => artifact?.type === "checkpoint")
        .map((artifact) => artifactItem(artifact, "checkpoint")),
    },
    {
      id: "objects",
      label: "Media and rich objects",
      items: [
        ...objects.map((object) => objectItem(object)),
        ...artifacts
          .filter((artifact) => artifact?.type === "rollout")
          .map((artifact) => artifactItem(artifact, "media")),
      ],
    },
    {
      id: "files",
      label: "Files",
      items: artifacts
        .filter((artifact) => artifact?.type !== "checkpoint" && artifact?.type !== "rollout")
        .map((artifact) => artifactItem(artifact, "file")),
    },
  ];
}

/**
 * Filter prebuilt sections by the search query without rebuilding the items.
 * @template {{ items: { searchText: string }[] }} T
 * @param {T[]} sections
 * @param {string} [search]
 * @returns {T[]}
 */
export function filterEvidenceSections(sections, search = "") {
  const query = String(search ?? "").trim().toLowerCase();
  if (!query) return sections;
  return sections.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.searchText.includes(query)),
  }));
}

/**
 * @param {{ artifacts?: any[], objects?: any[], search?: string }} input
 */
export function buildEvidenceSections({ artifacts = [], objects = [], search = "" } = {}) {
  return filterEvidenceSections(buildEvidenceSectionItems({ artifacts, objects }), search);
}

/**
 * Group raw run artifacts that share a name so the UI can render one row per
 * name with an expandable history. The entry with the highest numeric step
 * wins as `latest`; when no entry in a group carries a step the first item in
 * input order wins (run artifact lists arrive newest-first from the API).
 *
 * @param {any[]} artifacts
 * @returns {Array<{ name: string, latest: any, older: any[], count: number }>}
 */
export function groupArtifactsByName(artifacts = []) {
  const groups = [];
  const byName = new Map();
  for (const artifact of artifacts ?? []) {
    if (!artifact) continue;
    const name = String(artifact.name ?? "");
    let entries = byName.get(name);
    if (!entries) {
      entries = [];
      byName.set(name, entries);
      groups.push({ name, entries });
    }
    entries.push(artifact);
  }
  return groups.map(({ name, entries }) => {
    let latest = entries[0];
    for (const entry of entries) {
      const latestStep = typeof latest.step === "number" ? latest.step : null;
      const entryStep = typeof entry.step === "number" ? entry.step : null;
      if (entryStep !== null && (latestStep === null || entryStep > latestStep)) latest = entry;
    }
    return { name, latest, older: entries.filter((entry) => entry !== latest), count: entries.length };
  });
}

/**
 * @param {Array<{ items: any[] }>} sections
 */
export function firstEvidenceItem(sections) {
  for (const section of sections ?? []) {
    const item = section.items?.[0];
    if (item) return item;
  }
  return null;
}

function artifactItem(artifact, kind) {
  const name = String(artifact?.name ?? "artifact");
  const type = String(artifact?.type ?? "file");
  const uri = String(artifact?.uri ?? "");
  return {
    id: `artifact:${artifact?.id}`,
    kind,
    label: name,
    detail: artifact?.step === null || artifact?.step === undefined ? type : `${type} · step ${artifact.step}`,
    artifact,
    object: null,
    searchText: `${name} ${type} ${uri}`.toLowerCase(),
  };
}

function objectItem(object) {
  const key = String(object?.key ?? "object");
  const kind = String(object?.kind ?? "object");
  return {
    id: `object:${object?.id}`,
    kind: "object",
    label: key,
    detail: object?.step === null || object?.step === undefined ? kind : `${kind} · step ${object.step}`,
    artifact: null,
    object,
    searchText: `${key} ${kind} ${JSON.stringify(object?.metadata ?? {})}`.toLowerCase(),
  };
}

// AR4: artifact text previews. Conservative extension/mime detection — only
// formats that render usefully as monospace text. Media kinds win (an
// image/audio/video preview is richer than bytes).
const TEXT_PREVIEW_EXTENSIONS = {
  csv: "csv",
  tsv: "csv",
  json: "json",
  jsonl: "json",
  txt: "text",
  md: "text",
  log: "text",
  yaml: "text",
  yml: "text",
};

/**
 * @param {{ name?: string, uri?: string, mime_type?: string | null, metadata?: Record<string, any> | null }} [artifact]
 * @returns {"csv" | "json" | "text" | ""}
 */
export function artifactTextPreviewKind(artifact = {}) {
  const mime = String(artifact.mime_type ?? artifact.metadata?.mime_type ?? artifact.metadata?.content_type ?? "").toLowerCase();
  if (mime.includes("csv")) return "csv";
  if (mime.includes("json")) return "json";
  if (mime.startsWith("text/")) return "text";
  const name = `${artifact.name ?? ""} ${artifact.uri ?? ""}`.toLowerCase();
  const match = name.match(/\.([a-z0-9]+)(?:$|[?#\s])/g);
  for (const token of match ?? []) {
    const ext = token.replace(/^\./, "").replace(/[?#\s]+$/, "");
    if (TEXT_PREVIEW_EXTENSIONS[ext]) return TEXT_PREVIEW_EXTENSIONS[ext];
  }
  return "";
}

/**
 * Bound a fetched text blob for inline display. Returns the clipped text plus
 * whether anything was cut, so the UI can say "showing the first N lines".
 * @param {string} text
 * @param {{ maxLines?: number, maxChars?: number }} [limits]
 */
export function truncateTextPreview(text, { maxLines = 40, maxChars = 16_384 } = {}) {
  const raw = String(text ?? "");
  let clipped = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  let truncated = raw.length > maxChars;
  const lines = clipped.split("\n");
  if (lines.length > maxLines) {
    clipped = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  return { text: clipped, truncated };
}

/**
 * Pretty-print a complete JSON document for preview. Returns null when the
 * payload is not valid standalone JSON (e.g. jsonl or a truncated read) — the
 * caller falls back to the raw text.
 * @param {string} raw
 */
export function formatJsonPreview(raw) {
  try {
    return JSON.stringify(JSON.parse(String(raw ?? "")), null, 2);
  } catch {
    return null;
  }
}
