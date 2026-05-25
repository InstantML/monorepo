function isWorkspaceViewSummary(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.name === "string",
  );
}

function isWorkspaceViewRow(value) {
  return Boolean(
    isWorkspaceViewSummary(value) &&
      "payload" in value &&
      typeof value.payload === "object" &&
      value.payload !== null &&
      !Array.isArray(value.payload),
  );
}

export function workspaceViewSummariesFromPayload(payload) {
  const maybeCurrent = payload?.workspace_views;
  const maybeLegacy = payload?.views;
  const rows = Array.isArray(maybeCurrent) ? maybeCurrent : Array.isArray(maybeLegacy) ? maybeLegacy : [];
  return rows.filter(isWorkspaceViewSummary);
}

export function workspaceViewFromPayload(payload) {
  const row = payload?.workspace_view ?? payload?.view;
  return isWorkspaceViewRow(row) ? row : null;
}
