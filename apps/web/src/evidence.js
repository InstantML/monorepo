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
