import { axisTicks, formatAxisTick, formatAxisValue } from "./charts.js";

export const CHART_EXPORT_MAX_SERIES = 120;
export const CHART_EXPORT_MAX_POINTS = 20_000;

const EXPORT_PALETTE = [
  "#dc5b55",
  "#5d89dd",
  "#2f9d8f",
  "#c07a2d",
  "#8b7cf6",
  "#2ec4b6",
  "#e45f8c",
  "#7bc96f",
  "#14b8a6",
  "#f4a261",
  "#6b7280",
  "#94a3b8",
];

/**
 * @param {Array<Record<string, any>>} [series]
 * @param {{ seriesLimit?: number, pointLimit?: number }} [options]
 */
export function chartExportStats(series = [], options = {}) {
  const seriesLimit = options.seriesLimit ?? Number.POSITIVE_INFINITY;
  const pointLimit = options.pointLimit ?? Number.POSITIVE_INFINITY;
  let points = 0;
  const seriesCount = series?.length ?? 0;
  for (const item of series ?? []) {
    points += item?.normalizedPoints?.length ?? 0;
    if (seriesCount > seriesLimit || points > pointLimit) break;
  }
  return { series: seriesCount, points };
}

/**
 * @param {Array<Record<string, any>>} [series]
 */
export function chartExportBlockedReason(series = []) {
  const stats = chartExportStats(series, { seriesLimit: CHART_EXPORT_MAX_SERIES, pointLimit: CHART_EXPORT_MAX_POINTS });
  if (!stats.points) return "No plotted points to export.";
  if (stats.series > CHART_EXPORT_MAX_SERIES) {
    return `Chart export supports up to ${CHART_EXPORT_MAX_SERIES} plotted series. Narrow the run selection first.`;
  }
  if (stats.points > CHART_EXPORT_MAX_POINTS) {
    return `Chart export supports up to ${CHART_EXPORT_MAX_POINTS.toLocaleString()} plotted points. Narrow the range or selection first.`;
  }
  return "";
}

export function safeExportFilename(value, fallback = "export") {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || fallback;
}

/**
 * @param {{ metricKey?: string, series?: Array<Record<string, any>>, xMode?: string }} [options]
 */
export function chartSeriesToCsv({ metricKey = "", series = [], xMode = "step" } = {}) {
  assertChartExportAllowed(series);
  const rows = [["metric_key", "series_id", "series_type", "run_id", "run_name", "group", "source_count", "step", "value", "created_at", "smoothed_value", "x_mode", "x_value"]];
  for (const item of series ?? []) {
    const seriesType = item.seriesType === "aggregate" ? "aggregate" : "run";
    const runId = seriesType === "run" ? (item.id ?? "") : "";
    for (const point of item.normalizedPoints ?? []) {
      rows.push([
        metricKey,
        item.id ?? "",
        seriesType,
        runId,
        item.identifier ?? item.name ?? "",
        item.group ?? "",
        Number.isFinite(item.sourceRunCount) ? item.sourceRunCount : "",
        point.step ?? "",
        point.value ?? "",
        point.created_at ?? "",
        Number.isFinite(point.smoothedValue) ? point.smoothedValue : "",
        xMode,
        point.xValue ?? "",
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

/**
 * @param {{ metricKey?: string, series?: Array<Record<string, any>>, width?: number, height?: number, padding?: number, xMode?: string }} [options]
 */
export function chartSeriesToSvg({ metricKey = "", series = [], width = 560, height = 360, padding = 28, xMode = "step" } = {}) {
  assertChartExportAllowed(series);
  const safeWidth = Math.max(120, Number(width) || 560);
  const safeHeight = Math.max(120, Number(height) || 360);
  const maxPadding = Math.max(12, Math.floor((Math.min(safeWidth, safeHeight) - 2) / 2));
  const safePadding = Math.min(Math.max(12, Number(padding) || 28), maxPadding);
  const domain = series.find((item) => item?.domain)?.domain;
  const xTicks = domain ? axisTicks(domain.minX, domain.maxX, 5) : [];
  const yTicks = domain ? axisTicks(domain.minY, domain.maxY, 5) : [];
  const xSpan = domain ? (domain.maxX - domain.minX) || 1 : 1;
  const ySpan = domain ? (domain.maxY - domain.minY) || 1 : 1;
  const xPos = (value) => safePadding + ((value - domain.minX) / xSpan) * (safeWidth - safePadding * 2);
  const yPos = (value) => safeHeight - safePadding - ((value - domain.minY) / ySpan) * (safeHeight - safePadding * 2);
  const title = metricKey || "metric";
  const paths = [];
  const legendItems = [];
  for (const [index, item] of (series ?? []).entries()) {
    const color = EXPORT_PALETTE[index % EXPORT_PALETTE.length];
    if (index < 8) {
      const label = item.identifier ?? item.name ?? item.id ?? `series ${index + 1}`;
      legendItems.push(`<g transform="translate(0 ${index * 14})"><line x1="0" x2="10" y1="0" y2="0" stroke="${color}" stroke-width="2"/><text x="14" y="3.5" font-size="10" fill="#243241">${xmlText(label)}</text></g>`);
    }
    if (item.path) {
      paths.push(`<polyline points="${xmlAttr(item.path)}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="${item.smoothed ? "0.32" : "0.9"}"/>`);
    }
    if (item.smoothed && item.smoothPath) {
      paths.push(`<polyline points="${xmlAttr(item.smoothPath)}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>`);
    }
    if ((item.normalizedPoints?.length ?? 0) === 1) {
      const point = item.normalizedPoints[0];
      paths.push(`<circle cx="${numberAttr(point.x)}" cy="${numberAttr(point.displayY ?? point.y)}" r="2.8" fill="${color}"/>`);
    }
  }
  const grid = domain ? [
    ...yTicks.map((tick) => `<g><line x1="${safePadding}" x2="${safeWidth - safePadding}" y1="${numberAttr(yPos(tick))}" y2="${numberAttr(yPos(tick))}" stroke="#e5edf4"/><text x="${safePadding - 6}" y="${numberAttr(yPos(tick) + 4)}" text-anchor="end" font-size="10" fill="#536171">${xmlText(formatAxisTick(tick))}</text></g>`),
    ...xTicks.map((tick) => `<g><line x1="${numberAttr(xPos(tick))}" x2="${numberAttr(xPos(tick))}" y1="${safePadding}" y2="${safeHeight - safePadding}" stroke="#e5edf4"/><text x="${numberAttr(xPos(tick))}" y="${safeHeight - 10}" text-anchor="middle" font-size="10" fill="#536171">${xmlText(formatAxisValue(tick, xMode))}</text></g>`),
    `<line x1="${safePadding}" x2="${safeWidth - safePadding}" y1="${safeHeight - safePadding}" y2="${safeHeight - safePadding}" stroke="#7b8998"/>`,
    `<line x1="${safePadding}" x2="${safePadding}" y1="${safePadding}" y2="${safeHeight - safePadding}" stroke="#7b8998"/>`,
  ] : [];
  const legend = legendItems.length ? [
    `<g transform="translate(${safePadding} 28)" font-family="Inter, Arial, sans-serif">`,
    `<rect x="-6" y="-10" width="${Math.min(280, safeWidth - safePadding * 2)}" height="${Math.min(124, legendItems.length * 14 + 8)}" rx="4" fill="#ffffff" opacity="0.88"/>`,
    legendItems.join(""),
    (series.length > legendItems.length ? `<text x="14" y="${legendItems.length * 14 + 3.5}" font-size="10" fill="#536171">+ ${series.length - legendItems.length} more plotted</text>` : ""),
    `</g>`,
  ].join("") : "";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}" role="img" aria-label="${xmlAttr(title)} chart">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${safePadding}" y="17" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700" fill="#111922">${xmlText(title)}</text>`,
    `<g font-family="Inter, Arial, sans-serif">${grid.join("")}${paths.join("")}</g>`,
    legend,
    `</svg>`,
  ].join("");
}

export function downloadTextFile(filename, content, type) {
  downloadBlob(new Blob([content], { type }), filename);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function filenameFromContentDisposition(header) {
  const value = String(header ?? "");
  const extended = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (extended) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      return "";
    }
  }
  const quoted = value.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1];
  const bare = value.match(/filename=([^;]+)/i);
  return bare ? bare[1].trim() : "";
}

function csvCell(rawValue) {
  const raw = protectCsvFormula(String(rawValue ?? ""));
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll("\"", "\"\"")}"` : raw;
}

function protectCsvFormula(raw) {
  if (!raw) return "";
  if (raw.startsWith("\t") || raw.startsWith("\r") || raw.startsWith("\n")) return `'${raw}`;
  const firstMeaningful = [...raw].find((char) => !isCsvFormulaPadding(char)) ?? "";
  return ["=", "+", "-", "@"].includes(firstMeaningful)
    ? `'${raw}`
    : raw;
}

function assertChartExportAllowed(series) {
  const reason = chartExportBlockedReason(series);
  if (reason) throw new Error(reason);
}

function isCsvFormulaPadding(char) {
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint <= 0x20 || codePoint === 0x7f || codePoint === 0xfeff || /\s/u.test(char);
}

function xmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function xmlAttr(value) {
  return xmlText(value).replaceAll("\"", "&quot;");
}

function numberAttr(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "0.00";
}
