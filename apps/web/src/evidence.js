/**
 * @param {{ artifacts?: any[], objects?: any[], search?: string }} input
 */
export function buildEvidenceSections({ artifacts = [], objects = [], search = "" } = {}) {
  const query = String(search ?? "").trim().toLowerCase();
  const sections = [
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
  if (!query) return sections;
  return sections.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.searchText.includes(query)),
  }));
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
