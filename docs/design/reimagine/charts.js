/* ============================================================
   INSTRUMENT — chart engine
   Hand-rolled SVG. Hairline grids, mono axis type, phosphor
   glow on live series, shared crosshair tooltip.
   ============================================================ */

(function () {
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const FMT = {
    si(v) {
      if (v === 0) return "0";
      const a = Math.abs(v);
      if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
      if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
      if (a < 0.01) return v.toExponential(1);
      if (a < 1) return v.toFixed(3);
      return v.toFixed(a < 10 ? 2 : 1);
    },
  };

  /* shared tooltip ------------------------------------------------ */
  let tip;
  function getTip() {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "chart-tip";
      document.body.appendChild(tip);
    }
    return tip;
  }

  function ema(points, alpha) {
    if (!alpha) return points;
    let prev = points[0][1];
    return points.map(([x, y]) => {
      prev = alpha * prev + (1 - alpha) * y;
      return [x, prev];
    });
  }

  /* ============================================================
     Line chart
     opts: { series:[{name,color,points,live,dash}], height, yFmt,
             smooth(0..1), area(bool), band:[lo,hi], yLabel, logY }
     ============================================================ */
  function line(el, opts) {
    const render = () => {
      const W = el.clientWidth || 300;
      const H = opts.height || 180;
      const padL = 50, padR = 10, padT = 10, padB = 22;
      const pw = W - padL - padR, ph = H - padT - padB;

      const series = opts.series.map((s) => ({ ...s, pts: ema(s.points, opts.smooth || 0) }));
      const thr = opts.band == null ? null : (Array.isArray(opts.band) ? opts.band[0] : opts.band);
      const allX = series.flatMap((s) => s.pts.map((p) => p[0]));
      const allY = series.flatMap((s) => s.pts.map((p) => p[1]));
      if (thr != null) allY.push(thr);
      let x0 = Math.min(...allX), x1 = Math.max(...allX);
      let y0 = Math.min(...allY), y1 = Math.max(...allY);
      if (y0 === y1) { y0 -= 1; y1 += 1; }
      const dataMin = y0;
      const yPad = (y1 - y0) * 0.08;
      y0 -= yPad; y1 += yPad;
      if (dataMin >= 0 && y0 < 0) y0 = 0;   // never imply negative values for non-negative metrics

      const X = (v) => padL + ((v - x0) / (x1 - x0 || 1)) * pw;
      const Y = (v) => padT + ph - ((v - y0) / (y1 - y0)) * ph;

      let g = "";
      // gridlines + y ticks
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i++) {
        const v = y0 + ((y1 - y0) * i) / yTicks;
        const y = Y(v);
        g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${css("--line-grid")}" stroke-width="1"/>`;
        g += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" class="axis">${(opts.yFmt || FMT.si)(v)}</text>`;
      }
      // x ticks
      const xTicks = Math.max(2, Math.floor(pw / 110));
      for (let i = 0; i <= xTicks; i++) {
        const v = x0 + ((x1 - x0) * i) / xTicks;
        g += `<text x="${X(v)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === xTicks ? "end" : "middle"}" class="axis">${FMT.si(v)}</text>`;
      }
      // threshold band: from the threshold line to the top of the plot
      if (thr != null) {
        g += `<rect x="${padL}" y="${padT}" width="${pw}" height="${Math.max(0, Y(thr) - padT)}" fill="${css("--crit")}" opacity="0.07"/>`;
        g += `<line x1="${padL}" y1="${Y(thr)}" x2="${W - padR}" y2="${Y(thr)}" stroke="${css("--crit")}" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>`;
      }

      let defs = "";
      let paths = "";
      series.forEach((s, si) => {
        const d = s.pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
        if (opts.area && si === 0) {
          const aid = `a${Math.floor(Math.random() * 1e9)}`;
          defs += `<linearGradient id="${aid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${s.color}" stop-opacity="0.18"/>
            <stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
          paths += `<path d="${d}L${X(s.pts[s.pts.length - 1][0])},${padT + ph}L${X(s.pts[0][0])},${padT + ph}Z" fill="url(#${aid})"/>`;
        }
        const glow = s.live ? `style="filter:drop-shadow(0 0 3px ${s.color})"` : "";
        const dash = s.dash ? `stroke-dasharray="${s.dash}"` : "";
        paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.live ? 1.6 : 1.3}" ${dash} ${glow} stroke-linejoin="round"/>`;
        if (s.live) {
          const last = s.pts[s.pts.length - 1];
          paths += `<circle cx="${X(last[0])}" cy="${Y(last[1])}" r="2.6" fill="${s.color}"/>`;
        }
      });

      el.setAttribute("role", "img");
      if (!el.getAttribute("aria-label")) {
        el.setAttribute("aria-label", `Line chart: ${series.map((s) => s.name).join(", ")}`);
      }
      el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <defs>${defs}</defs>
        <style>.axis{font:10px "Spline Sans Mono",monospace;fill:${css("--text-dim")};letter-spacing:.04em}</style>
        ${g}${paths}
        <line class="xh" x1="0" y1="${padT}" x2="0" y2="${padT + ph}" stroke="${css("--text-dim")}" stroke-width="1" stroke-dasharray="2 3" opacity="0"/>
      </svg>`;

      /* crosshair + tooltip */
      const svg = el.querySelector("svg");
      const xh = svg.querySelector(".xh");
      svg.addEventListener("mousemove", (e) => {
        const r = svg.getBoundingClientRect();
        const mx = e.clientX - r.left;
        if (mx < padL || mx > W - padR) { xh.setAttribute("opacity", 0); getTip().classList.remove("is-on"); return; }
        xh.setAttribute("x1", mx); xh.setAttribute("x2", mx);
        xh.setAttribute("opacity", 0.6);
        const xv = x0 + ((mx - padL) / pw) * (x1 - x0);
        let rows = "";
        series.forEach((s) => {
          let best = s.pts[0];
          for (const p of s.pts) if (Math.abs(p[0] - xv) < Math.abs(best[0] - xv)) best = p;
          rows += `<div class="chart-tip__row"><i style="background:${s.color}"></i><span>${s.name}</span><b>${(opts.yFmt || FMT.si)(best[1])}</b></div>`;
        });
        const t = getTip();
        t.innerHTML = `<div class="chart-tip__step">STEP ${FMT.si(xv)}</div>${rows}`;
        t.classList.add("is-on");
        const tw = t.offsetWidth;
        t.style.left = Math.min(e.clientX + 14, window.innerWidth - tw - 12) + "px";
        t.style.top = e.clientY + 14 + "px";
      });
      svg.addEventListener("mouseleave", () => { xh.setAttribute("opacity", 0); getTip().classList.remove("is-on"); });
    };
    render();
    new ResizeObserver(render).observe(el);
  }

  /* ============================================================
     Sparkline — tiny inline trend
     ============================================================ */
  function spark(el, values, o = {}) {
    const w = o.w || 72, h = o.h || 18;
    const min = Math.min(...values), max = Math.max(...values);
    const X = (i) => (i / (values.length - 1)) * (w - 4) + 2;
    const Y = (v) => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
    const d = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const color = o.color || css("--text-dim");
    const dot = o.live
      ? `<circle cx="${X(values.length - 1)}" cy="${Y(values[values.length - 1])}" r="2" fill="${color}"/>`
      : "";
    el.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round" opacity="${o.live ? 1 : 0.7}"/>${dot}</svg>`;
  }

  /* ============================================================
     Histogram — value distribution bars
     ============================================================ */
  function hist(el, bins, o = {}) {
    const render = () => {
      const W = el.clientWidth || 200, H = o.height || 96;
      const max = Math.max(...bins);
      const bw = W / bins.length;
      const color = o.color || css("--s2");
      let bars = "";
      bins.forEach((b, i) => {
        const bh = (b / max) * (H - 14);
        bars += `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="${o.ghost ? 0.25 : 0.8}" rx="1"/>`;
      });
      el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bars}</svg>`;
    };
    render();
    new ResizeObserver(render).observe(el);
  }

  /* ============================================================
     Range scrubber — full-extent mini chart with a window
     ============================================================ */
  function scrub(el, points, o = {}) {
    const render = () => {
      const W = el.clientWidth || 300, H = o.height || 44;
      const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      const X = (v) => ((v - x0) / (x1 - x0 || 1)) * (W - 2) + 1;
      const Y = (v) => H - 6 - ((v - y0) / (y1 - y0 || 1)) * (H - 12);
      const d = points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
      const [w0, w1] = o.window || [0.55, 1];
      const wx = W * w0, ww = W * (w1 - w0);
      el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <path d="${d}" fill="none" stroke="${css("--text-dim")}" stroke-width="1" opacity="0.8"/>
        <rect x="${wx}" y="1" width="${ww}" height="${H - 2}" fill="${css("--signal")}" opacity="0.07"/>
        <rect x="${wx}" y="1" width="${ww}" height="${H - 2}" fill="none" stroke="${css("--signal")}" opacity="0.5" stroke-width="1"/>
        <rect x="${wx - 2}" y="${H / 2 - 7}" width="4" height="14" rx="1.5" fill="${css("--signal")}"/>
        <rect x="${wx + ww - 2}" y="${H / 2 - 7}" width="4" height="14" rx="1.5" fill="${css("--signal")}"/>
      </svg>`;
    };
    render();
    new ResizeObserver(render).observe(el);
  }

  window.Charts = { line, spark, hist, scrub, FMT };
})();
