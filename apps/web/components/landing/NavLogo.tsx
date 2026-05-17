import Image from "next/image";

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
    return (
      <span className="landing-nav-logo wordmark-draw">
        <Image
          src="/instantml-lockup.svg"
          alt="InstantML"
          width={130}
          height={30}
          priority
          style={{ height: size * 1.25, width: "auto" }}
        />
      </span>
    );
  }
  return (
    <span className="landing-nav-logo">
      <Image
        src="/instantml-mark.svg"
        alt="InstantML"
        width={size}
        height={size}
        priority
      />
    </span>
  );
}
