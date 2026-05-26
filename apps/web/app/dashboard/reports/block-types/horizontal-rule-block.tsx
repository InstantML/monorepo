"use client";

type Props = {
  readOnly?: boolean;
};

export function HorizontalRuleBlock({ readOnly = false }: Props) {
  if (readOnly) {
    return <hr className="report-render__hr" />;
  }
  return (
    <div className="report-block report-block--horizontal-rule">
      <hr className="report-block__hr" />
      <span className="report-block__hint">Horizontal rule</span>
    </div>
  );
}
