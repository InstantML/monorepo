// InstantML mark: 4×4 dot grid. Diagonal (top-left → bottom-right) in
// Bolt (#1FB877); the other 12 dots use currentColor so the parent's
// theme color (Ink in light, Paper in dark) flows through.
//
// This file is the legacy import path used by auth-flow.tsx and other
// pre-brand-refresh callers. The newer landing-side component lives at
// components/landing/LogoMark.tsx and renders the same shape.
export function InstantMlMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`instantml-mark-svg ${className}`.trim()}
      focusable="false"
      viewBox="0 0 96 96"
    >
      <circle cx="12" cy="12" r="8" fill="#1FB877" />
      <circle cx="36" cy="12" r="5" fill="currentColor" />
      <circle cx="60" cy="12" r="5" fill="currentColor" />
      <circle cx="84" cy="12" r="5" fill="currentColor" />
      <circle cx="12" cy="36" r="5" fill="currentColor" />
      <circle cx="36" cy="36" r="8" fill="#1FB877" />
      <circle cx="60" cy="36" r="5" fill="currentColor" />
      <circle cx="84" cy="36" r="5" fill="currentColor" />
      <circle cx="12" cy="60" r="5" fill="currentColor" />
      <circle cx="36" cy="60" r="5" fill="currentColor" />
      <circle cx="60" cy="60" r="8" fill="#1FB877" />
      <circle cx="84" cy="60" r="5" fill="currentColor" />
      <circle cx="12" cy="84" r="5" fill="currentColor" />
      <circle cx="36" cy="84" r="5" fill="currentColor" />
      <circle cx="60" cy="84" r="5" fill="currentColor" />
      <circle cx="84" cy="84" r="8" fill="#1FB877" />
    </svg>
  );
}
