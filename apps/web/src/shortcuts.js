const TEXT_INPUT_TYPES = new Set([
  "",
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

export function platformModifierLabel(platform = "") {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "Cmd" : "Ctrl";
}

export function isEditableElement(target) {
  if (!target || typeof target !== "object") return false;
  const element = target.nodeType === 3 ? target.parentElement : target;
  if (!element || typeof element.closest !== "function") return false;
  if (element.isContentEditable || element.closest("[contenteditable='true']")) return true;
  const tagName = String(element.tagName ?? "").toLowerCase();
  if (tagName === "textarea" || tagName === "select") return true;
  if (tagName !== "input") return false;
  const type = String(element.getAttribute("type") ?? "").toLowerCase();
  return TEXT_INPUT_TYPES.has(type);
}

export function matchesShortcut(event, shortcut, platform = "") {
  const modKey = /Mac|iPhone|iPad|iPod/i.test(platform) ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
  const ctrlOrMeta = Boolean(event.metaKey || event.ctrlKey);
  const key = String(event.key ?? "").toLowerCase();
  switch (shortcut) {
    case "quick-search":
      return ctrlOrMeta && !event.shiftKey && key === "k";
    case "help":
      return !ctrlOrMeta && !event.altKey && (event.key === "?" || (event.shiftKey && key === "/"));
    case "undo":
      return ctrlOrMeta && !event.shiftKey && key === "z";
    case "redo":
      return (ctrlOrMeta && event.shiftKey && key === "z") || (!/Mac|iPhone|iPad|iPod/i.test(platform) && event.ctrlKey && key === "y");
    case "runs-rail":
      return ctrlOrMeta && !event.shiftKey && (event.key === "." || event.code === "Period");
    case "focus-workspace":
      return ctrlOrMeta && !event.shiftKey && key === "j";
    case "platform-mod":
      return modKey;
    default:
      return false;
  }
}
