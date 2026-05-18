type LogoMarkProps = {
  size?: number;
  className?: string;
  draw?: boolean;
  color?: string;
  title?: string;
};

// InstantML mark: 4×4 dot grid — diagonal in Bolt (#1FB877), others use
// currentColor so dark/light theme can recolor via CSS.
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
  return (
    <span
      className={`${draw ? "logo-draw " : ""}${className}`.trim() || undefined}
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
