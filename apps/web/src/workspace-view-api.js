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
  const maybeCurrent = payload?.views;
  const maybeLegacy = payload?.workspace_views;
  const rows = Array.isArray(maybeCurrent) ? maybeCurrent : Array.isArray(maybeLegacy) ? maybeLegacy : [];
  return rows.filter(isWorkspaceViewSummary);
}

export function workspaceViewFromPayload(payload) {
  const row = payload?.view ?? payload?.workspace_view;
  return isWorkspaceViewRow(row) ? row : null;
}
