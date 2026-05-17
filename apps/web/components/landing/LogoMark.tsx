type LogoMarkProps = {
  size?: number;
  className?: string;
  draw?: boolean;
  color?: string;
  title?: string;
};

// InstantML mark: three ascending bars (a metric curve) with a lightning
// slash through them — "training metrics, instantly".
export function LogoMark({
  size = 24,
  className = "",
  draw = false,
  color = "var(--accent)",
  title = "InstantML",
}: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      role="img"
      aria-label={title}
      className={`${draw ? "logo-draw " : ""}${className}`.trim()}
    >
      <rect
        x="24"
        y="132"
        width="44"
        height="92"
        rx="6"
        fill={color}
        opacity="0.55"
        className="logo-mark-path logo-mark-left"
      />
      <rect
        x="98"
        y="86"
        width="44"
        height="138"
        rx="6"
        fill={color}
        opacity="0.78"
        className="logo-mark-path logo-mark-left"
      />
      <rect
        x="172"
        y="40"
        width="44"
        height="184"
        rx="6"
        fill={color}
        className="logo-mark-path logo-mark-right"
      />
      <path
        d="M 152 16 L 88 124 L 128 124 L 80 232 L 144 116 L 104 116 Z"
        fill="var(--bg, #07080c)"
        stroke={color}
        strokeWidth="6"
        strokeLinejoin="round"
        className="logo-mark-path logo-mark-right"
      />
    </svg>
  );
}
