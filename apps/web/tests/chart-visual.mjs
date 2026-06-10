// Standalone visual harness for the chart features. Imports the REAL charts.js
// (all normalization / smoothing / 5-sig-fig logic lives there) and reproduces
// the exact MetricChart SVG markup + CSS, then screenshots each scenario.
// No Next / Clerk / backend — just the chart logic under test.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, ".."); // apps/web
const outDir = process.env.CHART_SCREENS_DIR || "/tmp/chart-screens";
fs.mkdirSync(outDir, { recursive: true });

// Pull the real series CSS so the screenshots match production styling.
const chartsCss = fs.readFileSync(path.join(webRoot, "app/styles/charts.css"), "utf8");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
/* Mirror the real light theme tokens so charts.css renders faithfully. */
:root{
  --accent:#e0794b;--warm:#caa45a;--surface:#ffffff;--chart-card-bg:#ffffff;
  --muted:#475569;--ink:#344251;--line:#e2e8f0;
  --chart-grid:#e5e7eb;--chart-axis:#cbd5e1;--chart-tick:#94a3b8;
  --chart-tooltip-bg:rgba(255,255,255,0.98);--chart-tooltip-border:rgba(15,23,42,0.1);--chart-tooltip-text:#1e2933;
  --tight-radius:6px;--control-radius:8px;
}
body{margin:0;background:#f3f1ee;font-family:ui-sans-serif,system-ui,sans-serif;color:#1e2630;}
.scenario{background:#fff;margin:0;padding:18px 20px;border:1px solid #e6e2dc;}
.scenario h3{margin:0 0 4px;font-size:15px;}
.scenario p{margin:0 0 10px;font-size:12px;color:#6b7280;}
.chart-area{position:relative;}
.metric-chart{width:760px;height:auto;display:block;}
.axis-label{font-size:11px;fill:#55606b;}
.hover-guide{stroke:#9099a5;stroke-dasharray:4 4;stroke-width:1;}
.hover-ring{fill:none;stroke:#1e2a36;stroke-width:1.5;}
.chart-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:10px;font-size:12px;}
${chartsCss}
</style></head><body>
<div id="root"></div>
<script type="module">
import { normalizeSeries, smoothSeries, chartDomain, axisTicks, formatMetricValue, formatAxisTick, formatAxisValue } from "/src/charts.js";
import { chartColor, chartLineStyleClass, chartStyleIndexesForItems, stableChartIndex } from "/src/chart-colors.js";

const W = 760, H = 420, PAD = 60;
const colorIndexFor = (item, fallback) => stableChartIndex(item?.id ?? item?.identifier ?? item?.name, fallback);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

function renderChart(series, { metricKey, smoothing = 0, identifierField = "name", hoverFrac = null }) {
  const prepared = smoothSeries(series, smoothing);
  const normalized = normalizeSeries(prepared, W, H, PAD, "step", metricKey);
  const useLineStyles = normalized.length > 12;
  const styleIndexes = chartStyleIndexesForItems(normalized);
  const domain = chartDomain(prepared, "step", metricKey);
  const xSpan = Math.max(1e-9, domain.maxX - domain.minX);
  const ySpan = Math.max(1e-9, domain.maxY - domain.minY);
  const xPos = (v) => PAD + ((v - domain.minX) / xSpan) * (W - PAD * 2);
  const yPos = (v) => H - PAD - ((v - domain.minY) / ySpan) * (H - PAD * 2);
  const yTicks = axisTicks(domain.minY, domain.maxY, 5);
  const xTicks = axisTicks(domain.minX, domain.maxX, 5);
  let svg = '<svg class="metric-chart" viewBox="0 0 ' + W + ' ' + H + '">';
  for (const t of yTicks) {
    svg += '<line class="grid-line" x1="'+PAD+'" x2="'+(W-PAD)+'" y1="'+yPos(t)+'" y2="'+yPos(t)+'"/>';
    svg += '<text class="tick-label" x="'+(PAD-10)+'" y="'+(yPos(t)+4)+'" text-anchor="end">'+formatAxisTick(t)+'</text>';
  }
  for (const t of xTicks) {
    svg += '<line class="grid-line vertical" x1="'+xPos(t)+'" x2="'+xPos(t)+'" y1="'+PAD+'" y2="'+(H-PAD)+'"/>';
    svg += '<text class="tick-label" x="'+xPos(t)+'" y="'+(H-22)+'" text-anchor="middle">'+formatAxisValue(t,"step")+'</text>';
  }
  svg += '<line class="axis" x1="'+PAD+'" x2="'+(W-PAD)+'" y1="'+(H-PAD)+'" y2="'+(H-PAD)+'"/>';
  svg += '<line class="axis" x1="'+PAD+'" x2="'+PAD+'" y1="'+PAD+'" y2="'+(H-PAD)+'"/>';

  // hover guide / ring + tooltip data
  let hoverHtml = "";
  let hoverX = null, hoverPoints = [];
  if (hoverFrac !== null) {
    const targetX = domain.minX + xSpan * hoverFrac;
    normalized.forEach((item, i) => {
      const colorIndex = styleIndexes[i] ?? colorIndexFor(item, i);
      const pts = item.normalizedPoints || [];
      let best = null;
      for (const p of pts) if (!best || Math.abs(p.xValue - targetX) < Math.abs(best.xValue - targetX)) best = p;
      if (best) { hoverPoints.push({ item, i, colorIndex, p: best }); }
    });
    if (hoverPoints.length) hoverX = hoverPoints[0].p.x;
  }
  if (hoverX !== null) svg += '<line class="hover-guide" x1="'+hoverX+'" x2="'+hoverX+'" y1="'+PAD+'" y2="'+(H-PAD)+'"/>';

  normalized.forEach((item, i) => {
    const colorIndex = styleIndexes[i] ?? colorIndexFor(item, i);
    const stroke = chartColor(colorIndex);
    const lineStyle = chartLineStyleClass(useLineStyles ? colorIndex : 0);
    svg += '<polyline class="series series-'+(colorIndex%5)+' '+lineStyle+(item.smoothed?" series-raw":"")+'" points="'+item.path+'" style="stroke:'+stroke+'"/>';
    if (item.smoothed && item.smoothPath)
      svg += '<polyline class="series series-'+(colorIndex%5)+' '+lineStyle+' series-smooth" points="'+item.smoothPath+'" style="stroke:'+stroke+'"/>';
    if ((item.normalizedPoints?.length ?? 0) <= 2) for (const p of (item.normalizedPoints||[])) {
      svg += '<circle class="series-point point-'+(colorIndex%5)+(item.smoothed?" series-point-raw":"")+'" cx="'+p.x+'" cy="'+(p.displayY ?? p.y)+'" r="2.4" style="fill:'+stroke+';stroke:var(--chart-card-bg)"/>';
    }
  });
  if (hoverPoints.length) {
    const hp = hoverPoints[0].p;
    svg += '<circle class="hover-ring" cx="'+hp.x+'" cy="'+(hp.displayY ?? hp.y)+'" r="8"/>';
  }
  svg += '</svg>';

  let tooltip = "";
  if (hoverPoints.length) {
    const ranked = [...hoverPoints].sort((a, b) => ((b.p.smoothedValue ?? b.p.value) ?? -Infinity) - ((a.p.smoothedValue ?? a.p.value) ?? -Infinity)).slice(0, 8);
    tooltip = '<div class="chart-tooltip-slot is-active"><div class="chart-tooltip chart-tooltip-docked">'
      + '<div class="chart-tooltip-head">Step ' + hoverPoints[0].p.step + '</div>'
      + '<div class="chart-tooltip-cols"><span>Raw / EMA</span><span>Name</span></div>'
      + ranked.map(({item,colorIndex,p}) => {
          const id = item[identifierField] ?? item.name;
          const stroke = chartColor(colorIndex);
          const sm = (item.smoothed && Number.isFinite(p.smoothedValue)) ? '<span class="tooltip-raw">raw '+formatMetricValue(p.value)+'</span><em class="tooltip-smoothed">EMA '+formatMetricValue(p.smoothedValue)+'</em>' : formatMetricValue(p.value);
          return '<span class="chart-tooltip-row"><b style="color:'+stroke+'">'+sm+'</b>'
            + '<span class="chart-tooltip-name"><i class="legend-line '+chartLineStyleClass(useLineStyles ? colorIndex : 0)+'" style="background-color:'+stroke+';color:'+stroke+'"></i> '+escapeHtml(id)+'</span></span>';
        }).join("")
      + '<div class="chart-tooltip-more'+(hoverPoints.length > ranked.length ? '' : ' chart-tooltip-more-placeholder')+'">Showing '+ranked.length+' of '+hoverPoints.length+'</div>'
      + '</div></div>';
  } else {
    tooltip = '<div class="chart-tooltip-slot"><div class="chart-tooltip chart-tooltip-docked chart-tooltip-placeholder">'
      + '<div class="chart-tooltip-head">Step</div>'
      + '<div class="chart-tooltip-cols"><span>Value</span><span>Name</span></div>'
      + Array.from({ length: 8 }, () => '<span class="chart-tooltip-row"><b>0.0000</b><span class="chart-tooltip-name"><i class="legend-line"></i> run-name-placeholder</span></span>').join("")
      + '<div class="chart-tooltip-more">Showing 8 of 100</div>'
      + '</div></div>';
  }

  const legendItems = normalized.length <= 12 ? normalized : normalized.slice(0, 8);
  const legend = '<div class="chart-legend">' + legendItems.map((item,i) => {
    const colorIndex = styleIndexes[i] ?? colorIndexFor(item, i);
    const stroke = chartColor(colorIndex);
    return '<span class="legend-chip"><i class="legend-line '+chartLineStyleClass(useLineStyles ? colorIndex : 0)+'" style="background-color:'+stroke+';color:'+stroke+'"></i>'+escapeHtml(item[identifierField] ?? item.name)+'</span>';
  }).join("") + (normalized.length > legendItems.length ? '<span class="legend-chip legend-overflow">+'+(normalized.length - legendItems.length)+' more plotted</span>' : '') + '</div>';
  return '<div class="chart-area">'+legend+'<div class="metric-chart-frame">'+svg+'</div>'+tooltip+'</div>';
}

// ---- seeded scenario data ----
function rng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/0xffffffff;};}
function makeSeries(defs, gen){
  return defs.map((d,idx)=>{
    const r=rng(d.seed); const points=[];
    for(let step=0;step<d.steps;step++) points.push({key:"m",step,value:gen(step,d,r,idx),created_at:new Date(Date.UTC(2026,0,1,0,0,step)).toISOString()});
    return {id:d.name,name:d.name,notes:d.notes,tags:(d.tags||[]).join(", "),group:"all",points};
  });
}

const tinyDefs=[
  {name:"baseline",seed:11,steps:6,tags:["baseline"],notes:"1node baseline"},
  {name:"bottleneck-512",seed:22,steps:6,tags:["bneck-512"],notes:"voice encoder bottleneck 512"},
  {name:"12-layer",seed:33,steps:6,tags:["enc-12"],notes:"voice encoder 12 layers"},
];
// 3 runs, 6 points each, ALL values < 0.01 (the reported squish case)
const tiny = makeSeries(tinyDefs,(step,d)=> 0.001 + d.seed*0.00003 + 0.007*(1-step/6));
// micro ~1e-5
const micro = makeSeries(tinyDefs,(step,d)=> 0.00001 + d.seed*0.0000002 + 0.00002*(1-step/6));
// flat single value
const flat = makeSeries([{name:"const",seed:7,steps:1,tags:["c"],notes:"single point"}],()=>0.00004);
// noisy audio loss for smoothing
const audioDefs=[
  {name:"baseline",seed:101,steps:80,tags:["baseline"],notes:"1node baseline"},
  {name:"bottleneck-512",seed:202,steps:80,tags:["bneck-512"],notes:"voice encoder bottleneck 512"},
  {name:"12-layer",seed:303,steps:80,tags:["enc-12"],notes:"voice encoder 12 layers"},
];
const audio = audioDefs.map((d)=>{
  const r=rng(d.seed); let v=2.9; const points=[];
  for(let step=0;step<d.steps;step++){ v=Math.max(2.6, v-0.0028-r()*0.0008+(r()-0.5)*0.03); points.push({key:"m",step,value:Number(v.toFixed(5)),created_at:new Date(Date.UTC(2026,0,1,0,0,step)).toISOString()}); }
  return {id:d.name,name:d.name,notes:d.notes,tags:(d.tags||[]).join(", "),group:"all",points};
});
const dense = Array.from({length:18},(_,idx)=>{
  const r=rng(600+idx); let v=2.4 + idx * 0.012; const points=[];
  for(let step=0;step<50;step++){ v=Math.max(1.7, v-0.004-r()*0.001+(r()-0.5)*0.025); points.push({key:"m",step,value:Number(v.toFixed(5)),created_at:new Date(Date.UTC(2026,0,1,0,0,step)).toISOString()}); }
  return {id:"dense-"+String(idx+1).padStart(2,"0"),name:"dense-"+String(idx+1).padStart(2,"0"),notes:"dense run "+(idx+1),tags:"dense",group:"all",points};
});

const scenarios = [
  {id:"01-tiny-loss",title:"Tiny magnitude (all values < 0.01)",desc:"3 runs / 6 points each, train/loss ~0.001–0.009 — must fill the plot, not squish to the floor.",chart:()=>renderChart(tiny,{metricKey:"train/loss"})},
  {id:"02-micro-1e5",title:"Micro magnitude (~1e-5)",desc:"Values around 0.00001–0.00003 — y-axis ticks keep 5 sig figs and the curve is normalized.",chart:()=>renderChart(micro,{metricKey:"train/micro"})},
  {id:"03-flat-single",title:"Single / flat value",desc:"One point at 0.00004 — opens a magnitude-relative window so the marker sits mid-chart.",chart:()=>renderChart(flat,{metricKey:"train/loss",hoverFrac:0.5})},
  {id:"04-audio-no-smooth",title:"Noisy curve, no smoothing",desc:"train/audio_loss, smoothing 0.",chart:()=>renderChart(audio,{metricKey:"train/audio_loss",smoothing:0})},
  {id:"05-audio-smoothed",title:"EMA smoothing overlay",desc:"smoothing 70 — raw data faded, smoothed curve opaque on top.",chart:()=>renderChart(audio,{metricKey:"train/audio_loss",smoothing:70})},
  {id:"06-hover-smoothed",title:"Hover tooltip (run, raw, EMA, identifier)",desc:"Tooltip labels raw and EMA values explicitly.",chart:()=>renderChart(audio,{metricKey:"train/audio_loss",smoothing:60,hoverFrac:0.55})},
  {id:"07-identifier-tags",title:"Identifier = Tags",desc:"Legend + tooltip use run tags as the identifier.",chart:()=>renderChart(audio,{metricKey:"train/audio_loss",smoothing:60,identifierField:"tags",hoverFrac:0.55})},
  {id:"08-identifier-notes",title:"Identifier = Notes",desc:"Legend + tooltip use run notes as the identifier.",chart:()=>renderChart(audio,{metricKey:"train/audio_loss",smoothing:60,identifierField:"notes",hoverFrac:0.55})},
  {id:"09-dense-overflow",title:"Dense comparison with overflow",desc:"18 runs force legend overflow, repeated line styles, and tooltip row disclosure.",chart:()=>renderChart(dense,{metricKey:"train/audio_loss",smoothing:50,hoverFrac:0.5})},
];

const root = document.getElementById("root");
for (const s of scenarios) {
  const div = document.createElement("div");
  div.className = "scenario";
  div.id = s.id;
  div.innerHTML = '<h3>'+escapeHtml(s.title)+'</h3><p>'+escapeHtml(s.desc)+'</p>'+s.chart();
  root.appendChild(div);
}
window.__SCENARIOS__ = scenarios.map(s=>s.id);
window.__READY__ = true;
</script></body></html>`;

// ---- serve apps/web statically so /src/charts.js loads, plus our page ----
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }
  const filePath = path.join(webRoot, url);
  if (!filePath.startsWith(webRoot) || !fs.existsSync(filePath)) {
    res.writeHead(404); res.end("not found"); return;
  }
  const ext = path.extname(filePath);
  const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(fs.readFileSync(filePath));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 860, height: 1200 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 15000 });
  const ids = await page.evaluate(() => window.__SCENARIOS__);
  for (const id of ids) {
    await page.locator(`[id="${id}"]`).screenshot({ path: path.join(outDir, id + ".png") });
    console.log("[visual] captured", id);
  }
  await page.screenshot({ path: path.join(outDir, "00-all.png"), fullPage: true });
  if (errors.length) {
    console.error("[visual] CONSOLE ERRORS:", JSON.stringify(errors, null, 2));
    throw new Error(`Chart visual harness captured ${errors.length} console/page error(s).`);
  } else {
    console.log("[visual] no console errors");
  }
  console.log("[visual] DONE ->", outDir);
} finally {
  await browser.close();
  server.close();
}
