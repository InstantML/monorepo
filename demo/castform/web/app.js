const manifestUrl = "./public/demo-manifest.json";

const app = document.querySelector("#app");

async function loadManifest() {
  const response = await fetch(`${manifestUrl}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Manifest not found (${response.status})`);
  }
  return response.json();
}

function fmt(value, digits = 3) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function tagClass(tag) {
  if (tag === "best") return "tag best";
  if (["overfit", "verbose-regression", "sparse-reward"].includes(tag)) return "tag warn";
  return "tag";
}

function renderMetricCode(metric) {
  return `<code>${escapeHtml(metric).replaceAll("/", "/<wbr>")}</code>`;
}

function activeSession(manifest, key) {
  return manifest.embed_sessions.find((session) => session.key === key) || manifest.embed_sessions[0];
}

function renderRunCard(run) {
  const final = run.final_metrics || {};
  const tags = (run.tags || []).slice(-3).map((tag) => `<span class="${tagClass(tag)}">${tag}</span>`).join("");
  return `
    <article class="run-card">
      <h3>${escapeHtml(run.title || run.name)}</h3>
      <div class="run-meta">
        <span><strong>${escapeHtml(run.model || "model")}</strong></span>
        <span>lr ${fmt(run.learning_rate, 6)} / group ${escapeHtml(String(run.group_size || "n/a"))}</span>
        <span>eval solve <strong>${fmt(final["eval/solve_rate"])}</strong></span>
        <span>eval reward <strong>${fmt(final["eval/reward_mean"])}</strong></span>
      </div>
      <div class="tags">${tags}</div>
    </article>
  `;
}

function renderSidebar(manifest) {
  const runCount = manifest.runs?.length || 0;
  const sessionCount = manifest.embed_sessions?.length || 0;
  return `
    <aside class="sidebar">
      <div class="brand">
        <h1>Castform -> InstantML</h1>
        <span class="status-pill"><span class="dot"></span>Live</span>
      </div>

      <section class="side-card">
        <h2>Castform stream</h2>
        <ol class="step-list">
          <li><span class="step-state">ok</span><span>install castform</span><strong>ready</strong></li>
          <li><span class="step-state">ok</span><span>castform setup</span><strong>ready</strong></li>
          <li><span class="step-state">ok</span><span>castform launch</span><strong>mirrored</strong></li>
          <li><span class="step-state">ok</span><span>InstantML sync</span><strong>${runCount} runs</strong></li>
          <li><span class="step-state">ok</span><span>iframe sessions</span><strong>${sessionCount}</strong></li>
        </ol>
      </section>

      <section class="side-card">
        <h2>Project</h2>
        <div class="metric-row"><span>InstantML</span><strong>${escapeHtml(manifest.project || "n/a")}</strong></div>
        <div class="metric-row"><span>Generated</span><strong>${escapeHtml(shortTime(manifest.generated_at))}</strong></div>
        <div class="metric-row"><span>Parent origin</span><strong>${escapeHtml(manifest.parent_origin || "n/a")}</strong></div>
      </section>

      <section class="side-card">
        <h2>Castform app</h2>
        <div class="code-list">
          ${(manifest.castform?.workflow || []).map((item) => `<code>${escapeHtml(item)}</code>`).join("")}
        </div>
      </section>
    </aside>
  `;
}

function renderApp(manifest, selectedKey) {
  const selected = activeSession(manifest, selectedKey);
  const runs = manifest.runs || [];
  const tabs = manifest.embed_sessions.map((session) => `
    <button
      class="tab"
      type="button"
      data-session-key="${escapeHtml(session.key)}"
      aria-selected="${session.key === selected.key ? "true" : "false"}"
    >${escapeHtml(session.label)}</button>
  `).join("");
  app.innerHTML = `
    <div class="app-shell">
      ${renderSidebar(manifest)}
      <main class="main">
        <header class="topbar">
          <div>
            <h2>Castform training observability</h2>
            <p>
              Live InstantML project data for a Castform-shaped training workflow. The panels below are hosted
              InstantML read-only iframes created from the runs streamed by the demo runner.
            </p>
          </div>
          <div class="top-actions">
            <a class="button" href="${escapeAttr(manifest.castform?.app_home || "https://app.castform.com/home")}" target="_blank" rel="noreferrer">Castform app</a>
            <button class="button primary" type="button" data-refresh>Refresh manifest</button>
          </div>
        </header>

        <section class="run-grid">
          ${runs.map(renderRunCard).join("")}
        </section>

        <section class="content-grid">
          <div class="panel">
            <div class="panel-header">
              <div>
                <h2>InstantML embeds</h2>
                <p>${escapeHtml(selected.description || "")}</p>
              </div>
              <span class="status-pill"><span class="dot"></span>${escapeHtml(shortExpiry(selected.expires_at))}</span>
            </div>
            <div class="tabs" role="tablist" aria-label="Embed sessions">${tabs}</div>
            <div class="iframe-wrap">
              <div class="iframe-shell">
                <iframe
                  title="${escapeAttr(selected.label)}"
                  src="${escapeAttr(selected.iframe_src)}"
                  sandbox="allow-scripts allow-same-origin"
                  referrerpolicy="no-referrer"
                ></iframe>
              </div>
            </div>
          </div>

          <aside class="evidence">
            <section class="side-card">
              <h2>Source mapping</h2>
              <div class="metric-row"><span>Runs</span><strong>${runs.length}</strong></div>
              <div class="metric-row"><span>Session ID</span><strong>${escapeHtml(String(selected.id || "n/a"))}</strong></div>
              <div class="metric-row"><span>Run count</span><strong>${escapeHtml(String(selected.run_count || "n/a"))}</strong></div>
            </section>
            <section class="side-card">
              <h2>Metric focus</h2>
              <div class="code-list">
                ${(manifest.metric_groups || []).slice(0, 7).map(renderMetricCode).join("")}
              </div>
            </section>
            <section class="side-card">
              <h2>Call narrative</h2>
              <div class="metric-row"><span>Best signal</span><strong>eval solve rate</strong></div>
              <div class="metric-row"><span>Failure mode</span><strong>overfit or verbose</strong></div>
              <div class="metric-row"><span>Raw inspector</span><strong>Castform</strong></div>
              <div class="metric-row"><span>Fleet view</span><strong>InstantML</strong></div>
            </section>
          </aside>
        </section>
      </main>
    </div>
  `;
  bind(manifest);
}

function bind(manifest) {
  document.querySelectorAll("[data-session-key]").forEach((button) => {
    button.addEventListener("click", () => renderApp(manifest, button.dataset.sessionKey));
  });
  document.querySelector("[data-refresh]")?.addEventListener("click", async () => {
    app.innerHTML = `<div class="boot-shell"><span class="loader" aria-hidden="true"></span><span>Refreshing manifest...</span></div>`;
    try {
      renderApp(await loadManifest());
    } catch (error) {
      renderEmpty(error);
    }
  });
}

function renderEmpty(error) {
  app.innerHTML = `
    <main class="empty-state">
      <h1>Castform InstantML demo page</h1>
      <p>
        The parent page is running, but it does not have a generated manifest yet.
        Start this server, expose it through an HTTPS tunnel, then run the hosted demo writer.
      </p>
      <pre>python3 demo/castform/serve_web.py --port 5174
python3 demo/castform/run_demo.py --parent-origin https://your-demo-origin.example</pre>
      <p>${escapeHtml(error?.message || "Manifest not found")}</p>
    </main>
  `;
}

function shortTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shortExpiry(value) {
  if (!value) return "expires n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "expires n/a";
  return `expires ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

loadManifest().then((manifest) => renderApp(manifest)).catch(renderEmpty);
