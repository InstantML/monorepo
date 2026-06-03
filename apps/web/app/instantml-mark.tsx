// InstantML mark: 4×4 dot grid. Diagonal (top-left → bottom-right) in
// Bolt (#1FB877); the other 12 dots use currentColor so the parent's
// theme color (Ink in light, Paper in dark) flows through.
//
// .logo-anim on the wrapping <svg> triggers the "learning the diagonal"
// intro animation on first page load (defined in globals.css). The
// .no-logo-anim class on <html> (set by the boot script in layout.tsx)
// overrides the intro to instant on repeat visits or when
// prefers-reduced-motion is set.
//
// Set `loading` to swap the one-time intro for a continuous "chase"
// pulse on the diagonal Bolt dots — used by AppLoadingScreen so the mark
// itself becomes the spinner.
//
// This file is the legacy import path used by auth-flow.tsx and other
// pre-brand-refresh callers. The newer landing-side component lives at
// components/landing/LogoMark.tsx and renders the same shape.
export function InstantMlMark({
  animated = true,
  className = "",
  size,
  loading = false,
}: {
  animated?: boolean;
  className?: string;
  size?: number;
  loading?: boolean;
}) {
  const animClass = loading ? "logo-loading" : animated ? "logo-anim" : "";
  return (
    <svg
      aria-hidden="true"
      className={`instantml-mark-svg ${animClass} ${className}`.trim()}
      focusable="false"
      viewBox="0 0 96 96"
      {...(size ? { width: size, height: size } : {})}
    >
      <circle cx="12" cy="12" r="8" fill="#1FB877" className="logo-dot logo-dot-r0 logo-dot-diagonal logo-dot-d0" />
      <circle cx="36" cy="12" r="5" fill="currentColor" className="logo-dot logo-dot-r0" />
      <circle cx="60" cy="12" r="5" fill="currentColor" className="logo-dot logo-dot-r0" />
      <circle cx="84" cy="12" r="5" fill="currentColor" className="logo-dot logo-dot-r0" />
      <circle cx="12" cy="36" r="5" fill="currentColor" className="logo-dot logo-dot-r1" />
      <circle cx="36" cy="36" r="8" fill="#1FB877" className="logo-dot logo-dot-r1 logo-dot-diagonal logo-dot-d1" />
      <circle cx="60" cy="36" r="5" fill="currentColor" className="logo-dot logo-dot-r1" />
      <circle cx="84" cy="36" r="5" fill="currentColor" className="logo-dot logo-dot-r1" />
      <circle cx="12" cy="60" r="5" fill="currentColor" className="logo-dot logo-dot-r2" />
      <circle cx="36" cy="60" r="5" fill="currentColor" className="logo-dot logo-dot-r2" />
      <circle cx="60" cy="60" r="8" fill="#1FB877" className="logo-dot logo-dot-r2 logo-dot-diagonal logo-dot-d2" />
      <circle cx="84" cy="60" r="5" fill="currentColor" className="logo-dot logo-dot-r2" />
      <circle cx="12" cy="84" r="5" fill="currentColor" className="logo-dot logo-dot-r3" />
      <circle cx="36" cy="84" r="5" fill="currentColor" className="logo-dot logo-dot-r3" />
      <circle cx="60" cy="84" r="5" fill="currentColor" className="logo-dot logo-dot-r3" />
      <circle cx="84" cy="84" r="8" fill="#1FB877" className="logo-dot logo-dot-r3 logo-dot-diagonal logo-dot-d3" />
    </svg>
  );
}
