/**
 * Thin client helpers for the /api/reports surface. Mirrors the shape
 * established by workspace-view-api.js — the dashboard already owns an
 * `ApiClient` instance, so these helpers expect to be passed one rather
 * than constructing their own.
 */

function isReportSummary(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.title === "string",
  );
}

function isReportRow(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.title === "string" &&
      Array.isArray(value.blocks),
  );
}

export function reportSummariesFromPayload(payload) {
  const rows = Array.isArray(payload?.reports) ? payload.reports : [];
  return rows.filter(isReportSummary);
}

export function reportFromPayload(payload) {
  const row = payload?.report;
  return isReportRow(row) ? row : null;
}

export async function listReports(api, query = {}) {
  const params = new URLSearchParams();
  if (query.limit) params.set("limit", String(query.limit));
  if (query.offset) params.set("offset", String(query.offset));
  if (query.project) params.set("project", String(query.project));
  const search = params.toString();
  const path = search ? `/api/reports?${search}` : "/api/reports";
  const payload = await api.get(path);
  return {
    reports: reportSummariesFromPayload(payload),
    limit: typeof payload?.limit === "number" ? payload.limit : 0,
    offset: typeof payload?.offset === "number" ? payload.offset : 0,
    total: typeof payload?.total === "number" ? payload.total : 0,
  };
}

export async function createReport(api, body) {
  const payload = await api.post("/api/reports", body);
  return reportFromPayload(payload);
}

export async function fetchReport(api, reportId, { shareToken } = {}) {
  const params = new URLSearchParams();
  if (shareToken) params.set("share", shareToken);
  const search = params.toString();
  const path = search
    ? `/api/reports/${reportId}?${search}`
    : `/api/reports/${reportId}`;
  const payload = await api.get(path);
  return reportFromPayload(payload);
}

export async function patchReport(api, reportId, body) {
  const payload = await api.patch(`/api/reports/${reportId}`, body);
  return reportFromPayload(payload);
}

export async function deleteReport(api, reportId) {
  const payload = await api.request(`/api/reports/${reportId}`, {
    method: "DELETE",
  });
  return reportFromPayload(payload);
}

export async function rotateReportShareToken(api, reportId) {
  const payload = await api.post(`/api/reports/${reportId}/share`, {});
  return reportFromPayload(payload);
}

export function reportMarkdownUrl(reportId, { shareToken } = {}) {
  const params = new URLSearchParams();
  if (shareToken) params.set("share", shareToken);
  const search = params.toString();
  return search
    ? `/api/reports/${reportId}/markdown?${search}`
    : `/api/reports/${reportId}/markdown`;
}
