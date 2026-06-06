type LogoMarkProps = {
  className?: string;
  size?: number;
};

export function LogoMark({ className = "", size = 28 }: LogoMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={`instantml-mark-svg ${className}`.trim()}
      focusable="false"
      height={size}
      viewBox="0 0 96 96"
      width={size}
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
