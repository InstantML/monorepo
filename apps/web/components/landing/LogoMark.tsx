type LogoMarkProps = {
  size?: number;
  className?: string;
  draw?: boolean;
  color?: string;
  title?: string;
};

// InstantML mark: 4×4 dot grid — diagonal in Bolt (#1FB877), others use
// currentColor so dark/light theme can recolor via CSS.
//
// .logo-anim on the wrapping <span> triggers the "learning the diagonal"
// intro animation on first page load. Set `draw={false}` to skip the
// animation entirely for compact contexts (e.g. dashboard topbar).
export function LogoMark({
  size = 24,
  className = "",
  draw = false,
  color,
  title = "InstantML",
}: LogoMarkProps) {
  const wrapperStyle = color
    ? { color, display: "inline-flex" as const }
    : { display: "inline-flex" as const };
  const animClass = draw ? "logo-anim " : "";
  return (
    <span
      className={`${animClass}${className}`.trim() || undefined}
      style={wrapperStyle}
      aria-label={title}
      role="img"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 96 96"
        width={size}
        height={size}
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
