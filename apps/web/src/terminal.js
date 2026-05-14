const ANSI_PATTERN = /\x1b\[([0-9;]*)m/g;
const FG_CLASSES = {
  30: "ansi-fg-black",
  31: "ansi-fg-red",
  32: "ansi-fg-green",
  33: "ansi-fg-yellow",
  34: "ansi-fg-blue",
  35: "ansi-fg-magenta",
  36: "ansi-fg-cyan",
  37: "ansi-fg-white",
  90: "ansi-fg-bright-black",
  91: "ansi-fg-bright-red",
  92: "ansi-fg-bright-green",
  93: "ansi-fg-bright-yellow",
  94: "ansi-fg-bright-blue",
  95: "ansi-fg-bright-magenta",
  96: "ansi-fg-bright-cyan",
  97: "ansi-fg-bright-white",
};

export function ansiTokens(input) {
  const text = String(input ?? "");
  const tokens = [];
  let index = 0;
  let classNames = [];
  for (const match of text.matchAll(ANSI_PATTERN)) {
    const offset = match.index ?? 0;
    if (offset > index) tokens.push({ text: text.slice(index, offset), className: classNames.join(" ") });
    classNames = applyAnsiCodes(classNames, match[1]);
    index = offset + match[0].length;
  }
  if (index < text.length) tokens.push({ text: text.slice(index), className: classNames.join(" ") });
  return tokens.length ? tokens : [{ text, className: "" }];
}

export function terminalWindow(rowCount, scrollTop, rowHeight, viewportHeight, overscan = 8) {
  const safeRowCount = Math.max(0, Number(rowCount) || 0);
  const safeRowHeight = Math.max(1, Number(rowHeight) || 1);
  const safeViewport = Math.max(safeRowHeight, Number(viewportHeight) || safeRowHeight);
  const first = Math.floor(Math.max(0, Number(scrollTop) || 0) / safeRowHeight);
  const visible = Math.ceil(safeViewport / safeRowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(safeRowCount, first + visible + overscan);
  return {
    start,
    end,
    offsetTop: start * safeRowHeight,
    totalHeight: safeRowCount * safeRowHeight,
  };
}

function applyAnsiCodes(current, rawCodes) {
  const codes = rawCodes ? rawCodes.split(";").map((part) => Number(part || 0)) : [0];
  let next = [...current];
  for (const code of codes) {
    if (code === 0) next = [];
    else if (code === 1) next = replaceClass(next, "ansi-bold", /^ansi-bold$/);
    else if (code === 2) next = replaceClass(next, "ansi-dim", /^ansi-dim$/);
    else if (code === 22) next = next.filter((item) => item !== "ansi-bold" && item !== "ansi-dim");
    else if (code === 39) next = next.filter((item) => !item.startsWith("ansi-fg-"));
    else if (FG_CLASSES[code]) next = replaceClass(next, FG_CLASSES[code], /^ansi-fg-/);
  }
  return next;
}

function replaceClass(values, value, pattern) {
  return [...values.filter((item) => !pattern.test(item)), value];
}
