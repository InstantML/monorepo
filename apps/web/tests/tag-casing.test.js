import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.join(__dirname, "..", "app", "styles");

// Tag-family elements (pills, chips, badges, tags, ribbons, status labels)
// must never render in all caps. Eyebrows, table headers, and other
// micro-labels keep their own treatment and are out of scope here.
const TAG_SELECTOR = /pill|chip|badge|__tag\b|\btag\b|ribbon|workspace-run-status|callout-label/i;

function* rules(css) {
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = rule.exec(css); match; match = rule.exec(css)) {
    yield { selector: match[1].trim(), body: match[2] };
  }
}

test("tag-family selectors never uppercase their labels", () => {
  const offenders = [];
  for (const file of fs.readdirSync(stylesDir).filter((name) => name.endsWith(".css"))) {
    const css = fs.readFileSync(path.join(stylesDir, file), "utf8");
    for (const { selector, body } of rules(css)) {
      if (!TAG_SELECTOR.test(selector)) continue;
      if (/text-transform\s*:\s*uppercase/.test(body)) offenders.push(`${file}: ${selector}`);
    }
  }
  assert.deepEqual(offenders, [], `tags must not be all caps:\n${offenders.join("\n")}`);
});

test("run status chips render title case, not caps", () => {
  const instrument = fs.readFileSync(path.join(stylesDir, "instrument.css"), "utf8");
  assert.match(instrument, /\.pill \{[^}]*text-transform: capitalize/);
  assert.doesNotMatch(instrument, /\.workspace-run-status \{[^}]*text-transform: uppercase/);

  const dashboardRuns = fs.readFileSync(path.join(stylesDir, "dashboard-runs.css"), "utf8");
  assert.match(dashboardRuns, /\.workspace-run-status \{[^}]*text-transform: capitalize/);
});
