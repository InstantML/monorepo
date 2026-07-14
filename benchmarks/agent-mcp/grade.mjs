#!/usr/bin/env node
// Grades benchmark transcripts and prints a per-side comparison table.
// Usage: node grade.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const RUNS = join(DIR, "runs");
const { tasks } = JSON.parse(readFileSync(join(DIR, "tasks.json"), "utf8"));

function parseTranscript(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let toolCalls = 0;
  let toolErrors = 0;
  const toolNames = [];
  let result = null;
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "tool_use") {
          toolCalls++;
          toolNames.push(block.name);
        }
      }
    }
    if (ev.type === "user" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "tool_result" && block.is_error) toolErrors++;
      }
    }
    if (ev.type === "result") result = ev;
  }
  return { toolCalls, toolErrors, toolNames, result };
}

function grade(grader, text) {
  if (!text) return { score: 0, detail: "no answer" };
  if (grader.type === "regex_all") {
    const hits = grader.patterns.filter((p) => new RegExp(p, "i").test(text));
    if (grader.reject?.some((p) => new RegExp(p, "i").test(text)))
      return { score: 0, detail: "rejected pattern matched" };
    return {
      score: hits.length / grader.patterns.length,
      detail: `${hits.length}/${grader.patterns.length} patterns`,
    };
  }
  if (grader.type === "ordered_names") {
    const idx = grader.names.map((n) => text.indexOf(n));
    if (idx.some((i) => i < 0))
      return { score: idx.filter((i) => i >= 0).length / grader.names.length, detail: "missing names" };
    const ordered = idx.every((v, i) => i === 0 || v > idx[i - 1]);
    return { score: ordered ? 1 : 0.7, detail: ordered ? "all in order" : "present, wrong order" };
  }
  return { score: 0, detail: "unknown grader" };
}

const trialSuffixes = [...new Set(
  readdirSync(RUNS)
    .map((f) => f.match(/^(?:instantml|wandb)-.+?(\.t\d+)?\.jsonl$/))
    .filter(Boolean)
    .map((m) => m[1] ?? ""),
)].sort();

const rows = [];
for (const side of ["instantml", "wandb"]) {
  for (const task of tasks) {
    for (const suffix of trialSuffixes) {
    const base = join(RUNS, `${side}-${task.id}${suffix}`);
    let t;
    try {
      t = parseTranscript(`${base}.jsonl`);
    } catch {
      continue;
    }
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(`${base}.meta.json`, "utf8"));
    } catch {}
    const answer = t.result?.result ?? "";
    const g = grade(task.grader, answer);
    const usage = t.result?.usage ?? {};
    rows.push({
      side,
      task: task.id,
      trial: suffix ? suffix.slice(2) : "1",
      score: Number(g.score.toFixed(2)),
      correct: g.score === 1,
      tool_calls: t.toolCalls,
      tool_errors: t.toolErrors,
      num_turns: t.result?.num_turns ?? null,
      wall_s: meta.wall_ms ? Number((meta.wall_ms / 1000).toFixed(1)) : null,
      tokens_out: usage.output_tokens ?? null,
      cost_usd: t.result?.total_cost_usd ?? null,
      grade_detail: g.detail,
      tools_used: t.toolNames,
      answer: String(answer).slice(0, 400),
    });
    }
  }
}

writeFileSync(join(DIR, "results.json"), JSON.stringify(rows, null, 2));

const bySide = (side) => rows.filter((r) => r.side === side);
function summarize(side) {
  const rs = bySide(side);
  if (!rs.length) return null;
  const sum = (k) => rs.reduce((s, r) => s + (r[k] ?? 0), 0);
  return {
    side,
    tasks: rs.length,
    correct: rs.filter((r) => r.correct).length,
    avg_score: Number((sum("score") / rs.length).toFixed(2)),
    tool_calls: sum("tool_calls"),
    tool_errors: sum("tool_errors"),
    total_wall_s: Number(sum("wall_s").toFixed(1)),
    total_tokens_out: sum("tokens_out"),
    total_cost_usd: Number(sum("cost_usd").toFixed(4)),
  };
}

console.log(JSON.stringify({ summary: [summarize("instantml"), summarize("wandb")].filter(Boolean), rows }, null, 2));
