/* ============================================================
   INSTRUMENT — deterministic mock telemetry
   Seeded RNG so every page load renders the same "live" data.
   ============================================================ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Random-walk series generators ------------------------------- */
function genLoss(seed, n, start, floor) {
  const rnd = mulberry32(seed);
  const pts = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    const decay = Math.exp(-i / (n * 0.32));
    v = floor + (start - floor) * decay + (rnd() - 0.5) * 0.09 * decay + (rnd() - 0.5) * 0.012;
    pts.push([i * 250, Math.max(v, floor * 0.92)]);
  }
  return pts;
}

function genReturn(seed, n, ceil) {
  const rnd = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const sig = ceil / (1 + Math.exp(-(x * 9 - 3.4)));
    pts.push([i * 250, Math.max(0, sig + (rnd() - 0.5) * ceil * 0.07)]);
  }
  return pts;
}

function genNoisy(seed, n, base, amp, dipEvery) {
  const rnd = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    let v = base + Math.sin(i / 7) * amp * 0.3 + (rnd() - 0.5) * amp;
    if (dipEvery && i % dipEvery === dipEvery - 3) v -= amp * 2.4;
    pts.push([i * 250, v]);
  }
  return pts;
}

function genSpiky(seed, n, base) {
  const rnd = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const decay = Math.exp(-i / (n * 0.5));
    let v = base * decay + rnd() * 0.4 * decay;
    if (rnd() > 0.93) v += base * decay * (1.5 + rnd());
    pts.push([i * 250, v + 0.05]);
  }
  return pts;
}

function genCosineLR(n, peak) {
  const warm = Math.floor(n * 0.06);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const v = i < warm
      ? peak * (i / warm)
      : peak * 0.5 * (1 + Math.cos(Math.PI * (i - warm) / (n - warm)));
    pts.push([i * 250, v]);
  }
  return pts;
}

function sparkOf(points, k) {
  const step = Math.max(1, Math.floor(points.length / k));
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i][1]);
  return out;
}

/* The fleet ----------------------------------------------------- */
const N = 160;

const RUNS = [
  { id: "run-7f3a", name: "ppo-atlas-70b-rlhf-042", status: "running",  step: 31250, total: 40000, owner: "bwong",  gpus: 64, gpuh: 412.5, tags: ["rlhf", "atlas"], seed: 11, ret: 482.3, loss: 0.412, dRet: +2.1,  started: "07:42:11" },
  { id: "run-9c21", name: "ppo-atlas-70b-rlhf-041", status: "running",  step: 29800, total: 40000, owner: "bwong",  gpus: 64, gpuh: 398.0, tags: ["rlhf", "atlas"], seed: 23, ret: 451.7, loss: 0.448, dRet: +1.4,  started: "07:40:55" },
  { id: "run-b8e0", name: "grpo-mix-13b-curr-007",  status: "running",  step: 18400, total: 60000, owner: "asha",   gpus: 32, gpuh: 188.2, tags: ["grpo", "curriculum"], seed: 37, ret: 318.9, loss: 0.694, dRet: -0.8, started: "04:15:02" },
  { id: "run-4d19", name: "sft-atlas-70b-base-118", status: "running",  step: 51200, total: 52000, owner: "marco",  gpus: 16, gpuh: 96.4,  tags: ["sft"], seed: 41, ret: 0, loss: 1.182, dRet: 0, started: "Tue 22:10" },
  { id: "run-22af", name: "dpo-helio-8b-pref-d12",  status: "running",  step: 9100,  total: 30000, owner: "asha",   gpus: 8,  gpuh: 21.7,  tags: ["dpo", "helio"], seed: 53, ret: 211.4, loss: 0.531, dRet: +4.6, started: "10:02:48" },
  { id: "run-cc73", name: "ppo-atlas-70b-rlhf-040", status: "finished", step: 40000, total: 40000, owner: "bwong",  gpus: 64, gpuh: 540.1, tags: ["rlhf", "atlas"], seed: 61, ret: 446.2, loss: 0.455, dRet: 0, started: "Mon 09:12" },
  { id: "run-e1b4", name: "grpo-mix-13b-curr-006",  status: "crashed",  step: 12700, total: 60000, owner: "asha",   gpus: 32, gpuh: 131.0, tags: ["grpo", "curriculum"], seed: 71, ret: 287.5, loss: 0.731, dRet: 0, started: "Mon 18:33" },
  { id: "run-50dd", name: "dpo-helio-8b-pref-d11",  status: "finished", step: 30000, total: 30000, owner: "marco",  gpus: 8,  gpuh: 72.8,  tags: ["dpo", "helio"], seed: 83, ret: 198.0, loss: 0.561, dRet: 0, started: "Mon 11:47" },
  { id: "run-91c8", name: "sft-helio-8b-clean-094", status: "finished", step: 24000, total: 24000, owner: "yuki",   gpus: 8,  gpuh: 38.2,  tags: ["sft", "helio"], seed: 97, ret: 0, loss: 1.034, dRet: 0, started: "Sun 20:05" },
  { id: "run-a3f7", name: "ppo-atlas-70b-rlhf-039", status: "killed",   step: 8200,  total: 40000, owner: "bwong",  gpus: 64, gpuh: 110.9, tags: ["rlhf", "atlas"], seed: 101, ret: 102.6, loss: 0.892, dRet: 0, started: "Sun 14:30" },
  { id: "run-6e02", name: "grpo-mix-13b-base-005",  status: "finished", step: 60000, total: 60000, owner: "asha",   gpus: 32, gpuh: 612.4, tags: ["grpo"], seed: 113, ret: 301.2, loss: 0.702, dRet: 0, started: "Sat 08:55" },
  { id: "run-flux", name: "dpo-helio-8b-pref-d10",  status: "queued",   step: 0,     total: 30000, owner: "yuki",   gpus: 8,  gpuh: 0,     tags: ["dpo", "helio"], seed: 127, ret: 0, loss: 0, dRet: 0, started: "—" },
];

/* Per-run metric curves (lazy, memoized) ------------------------ */
const CURVES = {};
function curvesFor(run) {
  if (!CURVES[run.id]) {
    const frac = run.total ? Math.max(0.05, run.step / run.total) : 0.05;
    const n = Math.max(12, Math.floor(N * frac));
    CURVES[run.id] = {
      ret:    genReturn(run.seed, n, run.ret || 80).map(([x, y]) => [x, y]),
      loss:   genLoss(run.seed + 1, n, 2.4, run.loss || 0.4),
      lr:     genCosineLR(n, 3e-4),
      grad:   genSpiky(run.seed + 2, n, 8.2),
      gpu:    genNoisy(run.seed + 3, n, 88, 7, 0),
      tput:   genNoisy(run.seed + 4, n, 41200, 2600, 23),
      kl:     genNoisy(run.seed + 5, n, 0.042, 0.018, 0),
      ent:    genLoss(run.seed + 6, n, 4.1, 2.2),
    };
  }
  return CURVES[run.id];
}

/* Alerts -------------------------------------------------------- */
const ALERTS = [
  { sev: "crit", title: "grad_norm spike > 50.0 for 12 consecutive steps", run: "grpo-mix-13b-curr-007", rule: "grad-explosion", time: "2m ago" },
  { sev: "crit", title: "NaN detected in train/loss on rank 14",            run: "grpo-mix-13b-curr-006", rule: "nan-guard",      time: "1h ago" },
  { sev: "warn", title: "Ingest lag 94s behind wall clock",                 run: "ppo-atlas-70b-rlhf-042", rule: "ingest-lag",    time: "11m ago" },
  { sev: "warn", title: "eval/return_mean flat for 2,000 steps",            run: "dpo-helio-8b-pref-d12",  rule: "plateau",       time: "26m ago" },
  { sev: "warn", title: "Checkpoint interval exceeded (last: 4,210 steps)", run: "sft-atlas-70b-base-118", rule: "ckpt-cadence",  time: "38m ago" },
  { sev: "info", title: "New best eval/return_mean: 482.3 (+8.1)",          run: "ppo-atlas-70b-rlhf-042", rule: "new-best",      time: "1h ago" },
  { sev: "info", title: "Dataset prefs-v12 promoted to `latest`",           run: "—",                      rule: "dataset-promote", time: "3h ago" },
];

/* Datasets / drift ---------------------------------------------- */
const DATASETS = [
  { name: "rlhf-prefs-v12",   rows: "4.21M", freshness: "8m",  drift: 0.031, schema: "ok",      runs: 5 },
  { name: "rollouts-atlas-q2",rows: "18.7M", freshness: "2m",  drift: 0.012, schema: "ok",      runs: 9 },
  { name: "sft-clean-mix-v8", rows: "9.85M", freshness: "41m", drift: 0.118, schema: "changed", runs: 3 },
  { name: "eval-holdout-v4",  rows: "212K",  freshness: "3d",  drift: 0.004, schema: "ok",      runs: 14 },
];

const FEATURES = ["reward", "kl_ref", "resp_len", "tok_entropy", "lang:en", "lang:code", "turn_count", "toxicity", "len_ratio", "dup_rate", "null_rate", "vocab_kl"];

function driftMatrix(seed, rows, cols) {
  const rnd = mulberry32(seed);
  const m = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      let v = rnd() * 0.25;
      if (r === 2 && c > 7) v = 0.45 + rnd() * 0.5;   // sft-clean-mix drift story
      if (r === 0 && c === 4) v = 0.38 + rnd() * 0.2;
      row.push(v);
    }
    m.push(row);
  }
  return m;
}

window.IM = { RUNS, ALERTS, DATASETS, FEATURES, curvesFor, sparkOf, driftMatrix, mulberry32 };
