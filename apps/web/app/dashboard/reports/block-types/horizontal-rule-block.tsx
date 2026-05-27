"use client";

type Props = {
  readOnly?: boolean;
};

/**
 * Horizontal rule. Same rendering in edit and view modes — there's nothing
 * to interact with, just a line. (Delete via the hover block-controls.)
 */
export function HorizontalRuleBlock(_props: Props = {}) {
  return <hr className="report-render__hr" />;
}
