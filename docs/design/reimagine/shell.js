/* ============================================================
   INSTRUMENT — shared shell
   Injects the telemetry ticker + nav rail on every page.
   Active page comes from <body data-page="…">.
   ============================================================ */

(function () {
  const I = {
    overview: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="11" width="7" height="10" rx="1"/><rect x="3" y="14" width="8" height="7" rx="1"/></svg>',
    runs: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="5" cy="6" r="1.4" fill="currentColor" stroke="none"/><line x1="10" y1="6" x2="21" y2="6"/><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><line x1="10" y1="12" x2="21" y2="12"/><circle cx="5" cy="18" r="1.4" fill="currentColor" stroke="none"/><line x1="10" y1="18" x2="21" y2="18"/></svg>',
    metrics: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><polyline points="3 17 9 10 13 14 21 5"/><polyline points="15 5 21 5 21 11"/></svg>',
    compare: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="12" height="12" rx="1"/><rect x="9" y="9" width="12" height="12" rx="1"/></svg>',
    datasets: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="5" rx="8" ry="2.6"/><path d="M4 5v14c0 1.4 3.6 2.6 8 2.6s8-1.2 8-2.6V5"/><path d="M4 12c0 1.4 3.6 2.6 8 2.6s8-1.2 8-2.6"/></svg>',
    artifacts: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/></svg>',
    imports: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v11"/><polyline points="7 10 12 15 17 10"/><path d="M4 18h16"/><path d="M4 21h16"/></svg>',
    health: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><polyline points="2 12 6 12 9 4 15 20 18 12 22 12"/></svg>',
    reports: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 2h9l4 4v16H6z"/><line x1="9" y1="11" x2="16" y2="11"/><line x1="9" y1="15" x2="16" y2="15"/></svg>',
    settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.2" fill="var(--bg-void)"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="16" r="2.2" fill="var(--bg-void)"/></svg>',
    api: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><polyline points="4 6 9 12 4 18"/><line x1="12" y1="18" x2="20" y2="18"/></svg>',
  };

  const NAV = [
    { section: "Operate", items: [
      ["overview", "Overview", "overview.html"],
      ["runs", "Runs", "runs.html", "1.8k"],
      ["metrics", "Metrics", "metrics.html"],
      ["compare", "Compare", "#"],
    ]},
    { section: "Data", items: [
      ["datasets", "Datasets", "health.html"],
      ["artifacts", "Artifacts", "#"],
      ["imports", "Imports", "#"],
    ]},
    { section: "System", items: [
      ["health", "Run Health", "health.html", "5", "alert"],
      ["reports", "Reports", "#"],
      ["settings", "Settings", "#"],
      ["api", "API", "#"],
    ]},
  ];

  const MARK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 2 4 14.2h6.2L9.5 22 20 9.4h-6.2L13.5 2z"/></svg>';

  /* ---- rail ---- */
  const rail = document.querySelector(".rail");
  const active = document.body.dataset.page;
  rail.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:0 16px 14px">
      <span class="brandmark">${MARK}</span>
      <span class="brand-name">InstantML</span>
    </div>
    <div class="rail__project">
      <span><span class="mlabel" style="display:block;font-size:9px;margin-bottom:1px">Project</span>atlas-rl</span>
      <span style="color:var(--text-faint)">⌄</span>
    </div>
    ${NAV.map((g) => `
      <div class="rail__section"><span class="mlabel">${g.section}</span></div>
      ${g.items.map(([key, label, href, count, tone]) => `
        <a class="nav-item ${key === active ? "is-active" : ""}" href="${href}" ${key === active ? 'aria-current="page"' : ""}>
          ${I[key]}<span>${label}</span>
          ${count ? `<span class="nav-item__count ${tone === "alert" ? "is-alert" : ""}">${count}</span>` : ""}
        </a>`).join("")}
    `).join("")}
    <div class="rail__foot">
      <span class="avatar">BW</span>
      <span style="flex:1">bwong</span>
      <span style="color:var(--text-faint)">v3.0.0</span>
    </div>`;

  /* ---- ticker ---- */
  const ticker = document.querySelector(".ticker");
  const live = IM.RUNS.filter((r) => r.status === "running");
  ticker.innerHTML = `
    <div class="ticker__brand">
      <span class="ticker__live"><span class="pulse"></span>LIVE ${live.length}</span>
    </div>
    <div class="ticker__feed">
      ${live.map((r, i) => {
        const short = r.name.replace(/^[a-z]+-/, "");
        const delta = r.dRet > 0 ? `<span class="delta-up">▲ ${r.ret.toFixed(1)}</span>`
          : r.dRet < 0 ? `<span class="delta-down">▼ ${r.ret.toFixed(1)}</span>`
          : `<span style="color:var(--text-dim)">— ${r.loss.toFixed(3)}</span>`;
        return `<span class="tick-run"><b>${short}</b><span class="tick-spark" data-run="${r.id}"></span>${delta}</span>`;
      }).join("")}
    </div>
    <div class="ticker__sys">
      <span>INGEST <b id="tk-ingest">1.24M</b> pts/min</span>
      <span>LAG <b style="color:var(--signal)">2.1s</b></span>
      <span id="tk-clock">––:––:–– UTC</span>
    </div>`;

  live.forEach((r) => {
    const el = ticker.querySelector(`[data-run="${r.id}"]`);
    const vals = IM.sparkOf(r.ret ? IM.curvesFor(r).ret : IM.curvesFor(r).loss, 24);
    Charts.spark(el, vals, { w: 52, h: 14, color: "var(--text-faint)" });
  });

  /* live clock + ingest jitter */
  const clock = document.getElementById("tk-clock");
  const tickClock = () => {
    const d = new Date();
    clock.textContent = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
      .map((n) => String(n).padStart(2, "0")).join(":") + " UTC";
  };
  tickClock(); setInterval(tickClock, 1000);
  const ing = document.getElementById("tk-ingest");
  setInterval(() => { ing.textContent = (1.18 + Math.random() * 0.14).toFixed(2) + "M"; }, 2400);
})();
