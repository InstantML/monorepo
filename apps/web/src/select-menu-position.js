export function selectMenuViewportPosition({
  anchorRect,
  triggerRect,
  viewportWidth,
  menuAlign = "left",
  viewportPadding = 12,
  minWidth = 196,
  maxWidth = 280,
}) {
  const safeViewportWidth = Math.max(1, Number(viewportWidth) || 0);
  const padding = Math.max(0, Math.min(Number(viewportPadding) || 0, Math.floor(safeViewportWidth / 2)));
  const availableWidth = Math.max(1, safeViewportWidth - padding * 2);
  const minimumWidth = Math.min(Math.max(1, Number(minWidth) || 1), availableWidth);
  const maximumWidth = Math.max(minimumWidth, Math.min(Number(maxWidth) || minimumWidth, availableWidth));
  const triggerWidth = Math.max(0, Number(triggerRect?.width) || 0);
  const width = Math.min(Math.max(triggerWidth, minimumWidth), maximumWidth);
  const triggerLeft = Number(triggerRect?.left) || 0;
  const triggerRight = Number(triggerRect?.right) || triggerLeft + triggerWidth;
  const preferredViewportLeft = menuAlign === "right" ? triggerRight - width : triggerLeft;
  const viewportLeft = Math.min(
    Math.max(preferredViewportLeft, padding),
    safeViewportWidth - padding - width,
  );
  const anchorLeft = Number(anchorRect?.left) || 0;

  return {
    left: Math.round(viewportLeft - anchorLeft),
    width: Math.round(width),
  };
}
