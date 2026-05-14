export function InstantMlMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`instantml-mark-svg ${className}`.trim()}
      focusable="false"
      viewBox="0 0 240 240"
    >
      <rect className="instantml-mark-bar" x="24" y="132" width="44" height="92" rx="6" opacity="0.55" />
      <rect className="instantml-mark-bar" x="98" y="86" width="44" height="138" rx="6" opacity="0.78" />
      <rect className="instantml-mark-bar" x="172" y="40" width="44" height="184" rx="6" />
      <path
        className="instantml-mark-bolt"
        d="M152 16 88 124h40L80 232l64-116h-40Z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
      />
    </svg>
  );
}
