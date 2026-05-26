"use client";

import type { ImageBlockData } from "./types";

type Props = {
  block: ImageBlockData;
  readOnly?: boolean;
  onChange?: (next: ImageBlockData) => void;
};

export function ImageBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return (
      <figure className="report-render__figure">
        {block.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="report-render__image" src={block.url} alt={block.caption ?? ""} />
        ) : null}
        {block.caption ? (
          <figcaption className="report-render__caption">{block.caption}</figcaption>
        ) : null}
      </figure>
    );
  }
  return (
    <div className="report-block report-block--image">
      <label className="report-block__label">Image URL</label>
      <input
        className="report-block__input"
        value={block.url}
        placeholder="https://..."
        onChange={(event) => onChange?.({ ...block, url: event.target.value })}
        aria-label="Image URL"
      />
      <label className="report-block__label">Caption</label>
      <input
        className="report-block__input"
        value={block.caption ?? ""}
        placeholder="Optional caption"
        onChange={(event) => onChange?.({ ...block, caption: event.target.value })}
        aria-label="Image caption"
      />
    </div>
  );
}
