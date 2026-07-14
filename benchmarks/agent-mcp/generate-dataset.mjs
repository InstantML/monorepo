#!/usr/bin/env node
// Deterministic benchmark dataset generator for the InstantML-vs-W&B MCP comparison.
// Writes dataset.json (runs + metric series) and ground-truth.json (graded answers).
// Fixed seed => identical data on every regeneration, loggable to both trackers.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260708);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const round = (v, d = 4) => Number(v.toFixed(d));

const PROJECT = "mcp-bench-cartpole";
const DISTRACTOR_PROJECT = "mcp-bench-scratch";
const N_RUNS = 30;
const MAX_STEP = 120;
const EVAL_EVERY = 10;

const LRS = [0.0001, 0.0003, 0.001, 0.003];
const BATCH_SIZES = [32, 64, 128];
const OPTIMIZERS = ["adam", "sgd"];

const runs = [];
for (let i = 0; i < N_RUNS; i++) {
  const lr = pick(LRS);
  const batch_size = pick(BATCH_SIZES);
  const optimizer = pick(OPTIMIZERS);
  const seed = 1 + Math.floor(rand() * 100);
  const warmup_steps = pick([0, 10, 20]);
  const group = i < 6 ? "baseline" : i < 22 ? "candidate" : "ablation";
  const failed = rand() < 0.13;
  const lastStep = failed ? 20 + Math.floor(rand() * 40) : MAX_STEP;

  // Quality skill: adam + mid lr + bigger batch trains better, plus noise.
  const lrQuality = { 0.0001: 0.55, 0.0003: 0.9, 0.001: 0.75, 0.003: 0.4 }[lr];
  const skill =
    lrQuality *
    (optimizer === "adam" ? 1.0 : 0.72) *
    (0.85 + 0.15 * (batch_size / 128)) *
    (0.9 + 0.2 * rand());
  const ceiling = 500 * skill;
  const rate = 0.02 + 0.02 * skill;

  const name = `ppo-${optimizer}-lr${lr}-bs${batch_size}-s${seed}`;
  const series = { "train/loss": [], "eval/return_mean": [], "eval/return_std": [], lr: [] };
  for (let step = 1; step <= lastStep; step++) {
    const loss = 2.2 * Math.exp(-0.03 * step * (0.5 + skill)) + 0.08 + 0.06 * rand();
    series["train/loss"].push([step, round(loss)]);
    const sched = step <= warmup_steps ? (lr * step) / Math.max(warmup_steps, 1) : lr;
    series.lr.push([step, round(sched, 6)]);
    if (step % EVAL_EVERY === 0) {
      const ret = ceiling * (1 - Math.exp(-rate * step)) * (0.93 + 0.14 * rand()) + 8 * rand();
      series["eval/return_mean"].push([step, round(ret, 2)]);
      series["eval/return_std"].push([step, round(10 + 30 * rand() * (1 - step / MAX_STEP), 2)]);
    }
  }

  runs.push({
    project: PROJECT,
    name,
    status: failed ? "failed" : "finished",
    tags: [group, optimizer],
    notes: `Benchmark ${group} run ${i + 1}: PPO on cartpole, ${optimizer}, lr=${lr}.`,
    config: { algo: "ppo", env: "cartpole", lr, batch_size, optimizer, seed, warmup_steps },
    series,
  });
}

// Distractor project so project-scoping actually matters.
const distractors = [0, 1, 2].map((i) => ({
  project: DISTRACTOR_PROJECT,
  name: `scratch-sweep-${i}`,
  status: "finished",
  tags: ["scratch"],
  notes: "Throwaway smoke run.",
  config: { algo: "dqn", env: "cartpole", lr: 0.01, batch_size: 16, optimizer: "sgd", seed: i },
  series: { "train/loss": [[1, 2.0], [2, 1.9], [3, 1.85]] },
}));

const dataset = { projects: [PROJECT, DISTRACTOR_PROJECT], runs: [...runs, ...distractors] };

// ---- Ground truth (computed, not hand-written) ----
const finished = runs.filter((r) => r.status === "finished");
const finalRet = (r) => {
  const s = r.series["eval/return_mean"];
  return s.length ? s[s.length - 1][1] : -Infinity;
};
const ranked = [...finished].sort((a, b) => finalRet(b) - finalRet(a));
const best = ranked[0];
const baselineRef = finished.find((r) => r.tags.includes("baseline") && r.name !== best.name);

const avgBy = (opt) => {
  const rs = finished.filter((r) => r.config.optimizer === opt);
  return rs.reduce((s, r) => s + finalRet(r), 0) / rs.length;
};
const lossBelow = (r, thresh) => r.series["train/loss"].find(([, v]) => v < thresh)?.[0] ?? null;

const groundTruth = {
  project: PROJECT,
  n_runs: runs.length,
  n_failed: runs.filter((r) => r.status === "failed").length,
  best_run: { name: best.name, final_return: finalRet(best), lr: best.config.lr },
  top3: ranked.slice(0, 3).map((r) => ({ name: r.name, final_return: finalRet(r) })),
  optimizer_avg: {
    adam: round(avgBy("adam"), 2),
    sgd: round(avgBy("sgd"), 2),
    winner: avgBy("adam") > avgBy("sgd") ? "adam" : "sgd",
  },
  best_loss_below_0_5_step: lossBelow(best, 0.5),
  config_diff_pair: {
    a: best.name,
    b: baselineRef.name,
    diffs: Object.fromEntries(
      Object.keys(best.config)
        .filter((k) => best.config[k] !== baselineRef.config[k])
        .map((k) => [k, { a: best.config[k], b: baselineRef.config[k] }]),
    ),
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "dataset.json"), JSON.stringify(dataset, null, 2));
writeFileSync(join(OUT_DIR, "ground-truth.json"), JSON.stringify(groundTruth, null, 2));
console.log(
  `wrote ${dataset.runs.length} runs (${groundTruth.n_failed} failed); best=${best.name} final=${finalRet(best)}`,
);
