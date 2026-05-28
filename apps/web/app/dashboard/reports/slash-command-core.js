/**
 * Pure-JS core for the slash-command helper. Kept JS so node --test can
 * import it directly without a TS build step. The TS file
 * `slash-command.ts` re-exports these with proper typing.
 */

export function detectSlashTrigger(text, caret) {
  const inactive = { active: false, query: "", triggerOffset: -1 };
  if (typeof text !== "string") return inactive;
  const safeCaret = Math.max(0, Math.min(text.length, caret));
  let lineStart = safeCaret;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart -= 1;
  const lineSoFar = text.slice(lineStart, safeCaret);
  if (lineSoFar.length === 0) return inactive;
  if (lineSoFar[0] !== "/") return inactive;
  if (lineStart > 0 && text[lineStart - 1] === "\\") return inactive;
  const query = lineSoFar.slice(1);
  if (/\s/.test(query)) return inactive;
  return { active: true, query, triggerOffset: lineStart };
}

export function filterBlockPicker(query, entries) {
  const trimmed = (query ?? "").trim().toLowerCase();
  if (!trimmed) return [...entries];
  const scored = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const label = entry.label.toLowerCase();
    const keywords = (entry.keywords ?? []).map((k) => k.toLowerCase());
    let best = 0;
    if (label === trimmed) best = 100;
    else if (label.startsWith(trimmed)) best = 80;
    else if (keywords.some((k) => k.startsWith(trimmed))) best = 70;
    else if (label.includes(trimmed)) best = 50;
    else if (keywords.some((k) => k.includes(trimmed))) best = 40;
    if (best > 0) scored.push({ entry, score: best, index: i });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((row) => row.entry);
}

export const BLOCK_PICKER_CATALOG = Object.freeze([
  { id: "heading-1", label: "Heading 1", hint: "Section title", keywords: ["h1", "title"] },
  { id: "heading-2", label: "Heading 2", hint: "Subsection", keywords: ["h2"] },
  { id: "heading-3", label: "Heading 3", hint: "Sub-subsection", keywords: ["h3"] },
  { id: "paragraph", label: "Paragraph", hint: "Plain prose", keywords: ["text", "p"] },
  { id: "markdown", label: "Markdown", hint: "Raw markdown", keywords: ["md"] },
  { id: "code", label: "Code", hint: "Syntax-highlit snippet", keywords: ["pre", "snippet"] },
  { id: "callout", label: "Callout", hint: "Highlight box", keywords: ["info", "note", "warn"] },
  {
    id: "horizontal_rule",
    label: "Divider",
    hint: "Horizontal rule",
    keywords: ["hr", "rule", "line"],
  },
  { id: "image", label: "Image", hint: "Embed an image URL", keywords: ["picture", "figure"] },
  {
    id: "panel_grid",
    label: "Panel grid",
    hint: "Live runset + charts",
    keywords: ["chart", "panels"],
  },
]);

export function resolvePickerKind(id) {
  switch (id) {
    case "heading-1":
      return { kind: "heading", headingLevel: 1 };
    case "heading-2":
      return { kind: "heading", headingLevel: 2 };
    case "heading-3":
      return { kind: "heading", headingLevel: 3 };
    case "paragraph":
      return { kind: "paragraph" };
    case "markdown":
      return { kind: "markdown" };
    case "code":
      return { kind: "code" };
    case "callout":
      return { kind: "callout" };
    case "horizontal_rule":
      return { kind: "horizontal_rule" };
    case "image":
      return { kind: "image" };
    case "panel_grid":
      return { kind: "panel_grid" };
    default:
      return null;
  }
}
