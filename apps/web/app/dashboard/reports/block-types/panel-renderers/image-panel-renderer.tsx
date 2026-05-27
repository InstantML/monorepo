"use client";

import type { ImagePanelData } from "../types";

export function ImagePanelRenderer({ panel }: { panel: ImagePanelData }) {
  if (!panel.url) {
    return (
      <div className="panel-chart panel-chart--empty">Add an image URL to render the panel.</div>
    );
  }
  return (
    <figure className="panel-chart panel-chart--image">
      <img src={panel.url} alt={panel.caption ?? ""} className="panel-chart__image" />
      {panel.caption ? <figcaption className="panel-chart__caption">{panel.caption}</figcaption> : null}
    </figure>
  );
}
