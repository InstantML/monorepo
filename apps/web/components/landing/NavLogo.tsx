// Inline SVGs so `currentColor` cascades from CSS and the mark/wordmark
// stay legible in both light and dark themes.
//
// The .logo-anim class triggers a "learning the diagonal" intro on first
// load: grid dots cascade in row-by-row, then the 4 Bolt diagonal dots
// pulse with a brief green glow, then the wordmark slides in. The boot
// script in layout.tsx adds .no-logo-anim to <html> on repeat visits or
// when prefers-reduced-motion is set, which CSS-overrides the intro to
// instant. No React state, no FOUC.
export function NavLogo({
  size = 24,
  showWordmark = true,
}: {
  size?: number;
  showWordmark?: boolean;
}) {
  if (showWordmark) {
    const height = size * 1.25;
    const width = Math.round(height * (520 / 120));
    return (
      <span
        className="landing-nav-logo logo-anim"
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 520 120"
          height={height}
          width={width}
          aria-label="InstantML"
          role="img"
          fontFamily="var(--font-sans), system-ui, sans-serif"
        >
          <g transform="translate(0,12)">
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
          </g>
          <text
            x="128"
            y="82"
            fontSize="72"
            fontWeight="600"
            letterSpacing="-2.5"
            fill="currentColor"
            className="logo-wordmark-text"
          >
            instant
            <tspan fontWeight="700" fill="#1FB877">ml</tspan>
          </text>
        </svg>
      </span>
    );
  }
  return (
    <span className="landing-nav-logo logo-anim" style={{ display: "inline-flex" }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 96 96"
        width={size}
        height={size}
        aria-label="InstantML"
        role="img"
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
    </span>
  );
}
