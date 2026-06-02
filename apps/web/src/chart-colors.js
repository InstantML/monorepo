export const CHART_PALETTE = [
  "#2f80ed",
  "#12a67a",
  "#d65f74",
  "#e0a33f",
  "#7c5cc4",
  "#3b9ba7",
  "#8a96a8",
  "#d97745",
  "#4f6fb4",
  "#7d9857",
  "#b46ba8",
  "#607080",
];

export function chartColor(index = 0) {
  return CHART_PALETTE[Math.abs(Number(index) || 0) % CHART_PALETTE.length];
}

export function stableChartIndex(value, fallback = 0) {
  const source = String(value ?? "");
  if (!source) return Math.abs(Number(fallback) || 0) % (CHART_PALETTE.length * 4);
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % (CHART_PALETTE.length * 4);
}

export function chartStyleIndexesForItems(items = [], identityForItem = defaultChartIdentity) {
  const list = Array.isArray(items) ? items : [];
  const useLineStyles = list.length > CHART_PALETTE.length;
  const slotCount = CHART_PALETTE.length * 4;
  const used = new Set();
  return list.map((item, index) => {
    const preferred = stableChartIndex(identityForItem(item, index), index);
    const limit = useLineStyles ? slotCount : CHART_PALETTE.length;
    const start = useLineStyles ? preferred : preferred % CHART_PALETTE.length;
    const next = firstAvailableChartSlot(start, limit, used);
    used.add(next);
    return next;
  });
}

export function chartLineStyleClass(index = 0) {
  return `line-style-${Math.floor((Math.abs(Number(index) || 0) % (CHART_PALETTE.length * 4)) / CHART_PALETTE.length)}`;
}

export function chartCanvasDashArray(index = 0) {
  const cycle = Math.floor((Math.abs(Number(index) || 0) % (CHART_PALETTE.length * 4)) / CHART_PALETTE.length);
  if (cycle === 1) return [6, 4];
  if (cycle === 2) return [2, 4];
  if (cycle === 3) return [9, 3, 2, 3];
  return [];
}

export function chartSvgDashAttr(index = 0) {
  const dash = chartCanvasDashArray(index);
  return dash.length ? ` stroke-dasharray="${dash.join(" ")}"` : "";
}

function defaultChartIdentity(item) {
  return item?.id ?? item?.identifier ?? item?.name;
}

function firstAvailableChartSlot(start, limit, used) {
  if (used.size >= limit) return start % limit;
  for (let offset = 0; offset < limit; offset += 1) {
    const candidate = (start + offset) % limit;
    if (!used.has(candidate)) return candidate;
  }
  return start % limit;
}
