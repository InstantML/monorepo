"use client";

import { useCallback } from "react";

import type { PanelGridBlockData, RunsetData } from "./types";

type Props = {
  block: PanelGridBlockData;
  readOnly?: boolean;
  onChange?: (next: PanelGridBlockData) => void;
};

/**
 * PanelGrid editor — the load-bearing live-data block. Per the v1 spec,
 * Runsets accept a list of projects (not a single project) so reports can
 * span experiments organized across multiple projects. Only LinePlot panels
 * are supported in v1.
 *
 * The visual rendering of panels (i.e. actual charts) is intentionally out
 * of scope for this v1 PR — the block stores the query specification and
 * a placeholder card. The chart-rendering wire-up reuses the existing
 * metrics-series infrastructure and lands as a follow-up once we've sorted
 * how to host these embeds inside Notion-style document flow.
 */
export function PanelGridBlock({ block, readOnly = false, onChange }: Props) {
  const updateRunset = useCallback(
    (index: number, patch: Partial<RunsetData>) => {
      if (!onChange) return;
      const runsets = block.runsets.map((runset, current) =>
        current === index ? { ...runset, ...patch } : runset,
      );
      onChange({ ...block, runsets });
    },
    [block, onChange],
  );
  const addRunset = useCallback(() => {
    if (!onChange) return;
    onChange({
      ...block,
      runsets: [
        ...block.runsets,
        { name: `runset-${block.runsets.length + 1}`, projects: [] },
      ],
    });
  }, [block, onChange]);
  const removeRunset = useCallback(
    (index: number) => {
      if (!onChange) return;
      onChange({
        ...block,
        runsets: block.runsets.filter((_, current) => current !== index),
      });
    },
    [block, onChange],
  );
  const addLinePanel = useCallback(() => {
    if (!onChange) return;
    onChange({
      ...block,
      panels: [
        ...block.panels,
        { type: "line", metric_key: "loss", runset_index: 0 },
      ],
    });
  }, [block, onChange]);
  const updatePanel = useCallback(
    (index: number, patch: Partial<PanelGridBlockData["panels"][number]>) => {
      if (!onChange) return;
      const panels = block.panels.map((panel, current) =>
        current === index ? { ...panel, ...patch } : panel,
      );
      onChange({ ...block, panels });
    },
    [block, onChange],
  );
  const removePanel = useCallback(
    (index: number) => {
      if (!onChange) return;
      onChange({
        ...block,
        panels: block.panels.filter((_, current) => current !== index),
      });
    },
    [block, onChange],
  );
  return (
    <div className="report-block report-block--panel-grid">
      <div className="report-block__section">
        <div className="report-block__section-head">
          <h4>Runsets</h4>
          {!readOnly ? (
            <button
              type="button"
              className="report-block__action"
              onClick={addRunset}
              aria-label="Add runset"
            >
              + Runset
            </button>
          ) : null}
        </div>
        {block.runsets.length === 0 ? (
          <p className="report-block__empty">No runsets yet.</p>
        ) : (
          <ul className="report-block__list">
            {block.runsets.map((runset, index) => (
              <li className="report-block__runset" key={index}>
                <div className="report-block__row">
                  <input
                    className="report-block__input"
                    value={runset.name}
                    placeholder="Runset name"
                    onChange={(event) => updateRunset(index, { name: event.target.value })}
                    aria-label={`Runset ${index + 1} name`}
                    readOnly={readOnly}
                  />
                  {!readOnly ? (
                    <button
                      type="button"
                      className="report-block__action report-block__action--secondary"
                      onClick={() => removeRunset(index)}
                      aria-label={`Remove runset ${index + 1}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <label className="report-block__label">
                  Projects (comma-separated, supports cross-project)
                </label>
                <input
                  className="report-block__input"
                  value={runset.projects.join(", ")}
                  placeholder="proj-a, proj-b"
                  onChange={(event) =>
                    updateRunset(index, {
                      projects: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter((value) => value.length > 0),
                    })
                  }
                  aria-label={`Runset ${index + 1} projects`}
                  readOnly={readOnly}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="report-block__section">
        <div className="report-block__section-head">
          <h4>Panels (line plots)</h4>
          {!readOnly ? (
            <button
              type="button"
              className="report-block__action"
              onClick={addLinePanel}
              aria-label="Add line panel"
            >
              + Line panel
            </button>
          ) : null}
        </div>
        {block.panels.length === 0 ? (
          <p className="report-block__empty">No panels yet.</p>
        ) : (
          <ul className="report-block__list">
            {block.panels.map((panel, index) => (
              <li className="report-block__panel" key={index}>
                <div className="report-block__row">
                  <label className="report-block__label">Metric key</label>
                  <input
                    className="report-block__input"
                    value={panel.metric_key}
                    placeholder="loss"
                    onChange={(event) =>
                      updatePanel(index, { metric_key: event.target.value })
                    }
                    readOnly={readOnly}
                  />
                </div>
                <div className="report-block__row">
                  <label className="report-block__label">Runset index</label>
                  <input
                    className="report-block__input report-block__input--narrow"
                    type="number"
                    min={0}
                    value={panel.runset_index}
                    onChange={(event) =>
                      updatePanel(index, {
                        runset_index: Number(event.target.value),
                      })
                    }
                    readOnly={readOnly}
                  />
                  {!readOnly ? (
                    <button
                      type="button"
                      className="report-block__action report-block__action--secondary"
                      onClick={() => removePanel(index)}
                      aria-label={`Remove panel ${index + 1}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <p className="report-block__hint">
                  Line plot · live re-query each time the report is loaded.
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
