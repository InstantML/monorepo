"use client";

export function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      {/* Full value on hover; the column ellipsizes long values. */}
      <strong title={value}>{value}</strong>
    </div>
  );
}
