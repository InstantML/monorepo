"use client";

// Aligned to the web app's localStorage key so that theme toggled on
// the landing persists correctly into the dashboard.
const STORAGE_KEY = "instantml:next:theme";

// Theme toggle with no React state. The icon swap is driven entirely by
// the [data-theme] attribute that layout.tsx's boot script stamps before
// first paint, so there's no hydration mismatch and no setState-in-effect.
export function ThemeToggle({ className = "" }: { className?: string }) {
  function toggle() {
    const current = document.documentElement.dataset.theme;
    const next = current === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      title="Toggle theme"
      className={`landing-theme-toggle ${className}`}
    >
      {/* Sun — shown in dark mode (click to go light) */}
      <svg
        className="theme-icon-dark"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="M4.93 4.93l1.41 1.41" />
        <path d="M17.66 17.66l1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="M4.93 19.07l1.41-1.41" />
        <path d="M17.66 6.34l1.41-1.41" />
      </svg>
      {/* Moon — shown in light mode (click to go dark) */}
      <svg
        className="theme-icon-light"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
