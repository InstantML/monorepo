// Shared placement for point-anchored chart tooltips (.chart-tooltip): prefer
// the right of the anchor and above it, flip when the preferred side would
// leave the bounds, and clamp inside them. Extracted from MetricChart so the
// Insights explorers place their hover tooltips identically to the Runs tab.

const TOOLTIP_OFFSET = 12;
const TOOLTIP_MARGIN = 8;

export type TooltipPlacement = { left: number; top: number; side: "left" | "right"; vertical: "above" | "below" };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function chartTooltipPlacement({
  anchorX,
  anchorY,
  boundsHeight,
  boundsWidth,
  tooltipHeight,
  tooltipWidth,
}: {
  anchorX: number;
  anchorY: number;
  boundsHeight: number;
  boundsWidth: number;
  tooltipHeight: number;
  tooltipWidth: number;
}): TooltipPlacement {
  const width = Math.max(1, tooltipWidth);
  const height = Math.max(1, tooltipHeight);
  const maxLeft = Math.max(TOOLTIP_MARGIN, boundsWidth - width - TOOLTIP_MARGIN);
  const maxTop = Math.max(TOOLTIP_MARGIN, boundsHeight - height - TOOLTIP_MARGIN);
  const rightLeft = anchorX + TOOLTIP_OFFSET;
  const leftLeft = anchorX - width - TOOLTIP_OFFSET;
  const fitsRight = rightLeft + width <= boundsWidth - TOOLTIP_MARGIN;
  const side = fitsRight || leftLeft < TOOLTIP_MARGIN ? "right" : "left";
  const aboveTop = anchorY - height - TOOLTIP_OFFSET;
  const belowTop = anchorY + TOOLTIP_OFFSET;
  const spaceAbove = anchorY - TOOLTIP_MARGIN - TOOLTIP_OFFSET;
  const spaceBelow = boundsHeight - anchorY - TOOLTIP_MARGIN - TOOLTIP_OFFSET;
  const vertical = aboveTop >= TOOLTIP_MARGIN || spaceAbove >= spaceBelow ? "above" : "below";

  return {
    left: Math.round(clamp(side === "right" ? rightLeft : leftLeft, TOOLTIP_MARGIN, maxLeft)),
    top: Math.round(clamp(vertical === "above" ? aboveTop : belowTop, TOOLTIP_MARGIN, maxTop)),
    side,
    vertical,
  };
}
