// Inline SVGs so `currentColor` cascades from CSS and the mark/wordmark
// stay legible in both light and dark themes.
//
// Animation classes are rendered on the server. The boot script in
// layout.tsx adds .no-logo-anim to <html> on repeat visits and when
// prefers-reduced-motion is set, which CSS-overrides the intro to instant.
// No React state, no FOUC.
export function NavLogo({
  size = 24,
  showWordmark = true,
}: {
  size?: number;
  showWordmark?: boolean;
}) {
  if (showWordmark) {
    const height = size * 1.25;
    return (
      <span
        className="landing-nav-logo wordmark-draw"
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 520 120"
          height={height}
          width="auto"
          aria-label="InstantML"
          role="img"
          fontFamily="var(--font-sans), system-ui, sans-serif"
        >
          <g transform="translate(0,12)">
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
          </g>
          <text
            x="128"
            y="82"
            fontSize="72"
            fontWeight="600"
            letterSpacing="-2.5"
            fill="currentColor"
          >
            instant
            <tspan fontWeight="700" fill="#1FB877">ml</tspan>
          </text>
        </svg>
      </span>
    );
  }
  return (
    <span className="landing-nav-logo" style={{ display: "inline-flex" }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 96 96"
        width={size}
        height={size}
        aria-label="InstantML"
        role="img"
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
    </span>
  );
}
