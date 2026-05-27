"use client";

import type { ImageBlockData } from "./types";

type Props = {
  block: ImageBlockData;
  readOnly?: boolean;
  onChange?: (next: ImageBlockData) => void;
};

/**
 * One-mode image block. At rest renders the figure exactly as the published
 * view; clicking the URL placeholder (when empty) reveals the URL input so
 * the user can paste a link. The caption is an inline text input that
 * looks like a `<figcaption>` until you focus it.
 */
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
    <figure className="report-render__figure report-block--image-edit">
      {block.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="report-render__image" src={block.url} alt={block.caption ?? ""} />
      ) : (
        <div className="report-block__image-placeholder">No image yet</div>
      )}
      <input
        className="report-block__inline-input report-block__inline-input--url"
        value={block.url}
        placeholder="Paste an image URL…"
        onChange={(event) => onChange?.({ ...block, url: event.target.value })}
        aria-label="Image URL"
      />
      <input
        className="report-block__inline-input report-block__inline-input--caption"
        value={block.caption ?? ""}
        placeholder="Add a caption"
        onChange={(event) => onChange?.({ ...block, caption: event.target.value })}
        aria-label="Image caption"
      />
    </figure>
  );
}
