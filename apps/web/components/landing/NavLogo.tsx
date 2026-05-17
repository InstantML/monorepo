import { LogoMark } from "./LogoMark";

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
  return (
    <span className="landing-nav-logo">
      <LogoMark size={size} draw />
      {showWordmark ? (
        <span className="landing-wordmark wordmark-draw">InstantML</span>
      ) : null}
    </span>
  );
}
