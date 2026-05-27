# Agent-authored reports

The InstantML MCP server (`tools/mcp-server.mjs`) exposes the Reports surface
to agents so they can compose a Notion-style document — prose, code, callouts,
and live chart panels — the same way a human does in the dashboard.

## Tools

| Tool                              | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `tracker.list_reports`            | List reports in the org. Filter by `project`, paginate with `limit`.    |
| `tracker.get_report`              | Fetch one report including its `blocks` array. Accepts `share_token`.   |
| `tracker.create_report`           | Create a new report from a title + ordered `blocks` array.              |
| `tracker.update_report`           | Patch any of title / description / visibility / blocks.                 |
| `tracker.delete_report`           | Delete a report.                                                        |
| `tracker.refresh_llm_summary`     | Re-run the LLM summarizer for an `llm_summary` block at a given index.  |
| `tracker.share_report`            | Generate or rotate a share token; returns `share_token` and `share_url`.|
| `tracker.report_block_schema`     | Return a canonical JSON example covering every supported block kind.    |

Always call `tracker.report_block_schema` first if you are unsure about the
exact field names — it is the authoritative reference for the block shapes
the API will accept.

## Block kinds

Every block carries a `kind` discriminator. The supported kinds are:

- `heading` (`level: 1 | 2 | 3`, `text`)
- `paragraph` (`text`)
- `markdown` (`text` — supports GitHub-flavored markdown)
- `code` (`language`, `code`)
- `callout` (`variant: "info" | "warn" | "success"`, `text`)
- `horizontal_rule`
- `image` (`url`, `caption?`)
- `panel_grid` (live charts — see below)
- `llm_summary` (`panelgrid_index`, `angle`)

A `panel_grid` is the load-bearing live-data block. It owns:

- `runsets[]` — each is `{ name, projects[], pinned_run_ids? }`. Runs are
  resolved at render time by unioning the projects query with the pinned IDs
  (UUID or `project/run-name` shorthand). Capped at 50 runs per panel.
- `panels[]` — each is one of four types, all referencing a runset by index:
  - `{ type: "line", metric_key, runset_index, smoothing? }`
  - `{ type: "bar", metric_key, runset_index, group_by? }`
  - `{ type: "scalar", metric_key, runset_index, agg: "min" | "max" | "mean" | "latest" }`
  - `{ type: "scatter", x_metric, y_metric, runset_index, color_by? }`

## 10-line example

```js
// Agent flow: scan a project, then file a recap report from its recent runs.
const runs = await call("tracker.list_runs", { project_id: "proj-a", limit: 10 });
const report = await call("tracker.create_report", {
  title: `Weekly recap · ${new Date().toISOString().slice(0, 10)}`,
  description: "Auto-generated from the last 10 runs in proj-a.",
  visibility: "org",
  blocks: [
    { kind: "heading", level: 1, text: "Weekly recap" },
    { kind: "paragraph", text: "Live charts pull current values on every page load." },
    { kind: "panel_grid", runsets: [{ name: "recent", projects: ["proj-a"], limit: 10 }],
      panels: [{ type: "line", metric_key: "train/loss", runset_index: 0 }] },
    { kind: "llm_summary", panelgrid_index: 2, angle: "what-worked" },
  ],
});
```

After creation, call `tracker.refresh_llm_summary` on the `llm_summary`
block index to populate it; call `tracker.share_report` to mint a public
link for teammates.
