import type { ReactNode } from "react";

// Page header with the InstantML brand voice: a heavy sans title with an
// optional italic-serif emphasis fragment (used sparingly, per
// docs/design/2026-05-15-ui-overhaul-direction.md), and an optional
// right-aligned mono lede.

export function PageHead({
  title,
  emphasis,
  lede,
}: {
  title: string;
  emphasis?: string;
  lede?: ReactNode;
}) {
  return (
    <div className="page-head">
      <h2 className="ph-title">
        {title}
        {emphasis ? <> <span className="serif-em">{emphasis}</span></> : null}
      </h2>
      <span className="ph-spacer" />
      {lede ? <span className="ph-lede">{lede}</span> : null}
    </div>
  );
}
