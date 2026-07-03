// JSON-LD is embedded with dangerouslySetInnerHTML, so escape `<` (script
// breakout) and U+2028/U+2029 (invalid in JS string contexts) before inlining.
export function serializeJsonLd(data) {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
