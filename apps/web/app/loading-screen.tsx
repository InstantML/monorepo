export function AppLoadingScreen() {
  return (
    <main className="app-loading-screen" aria-label="Loading Training Observability">
      <div className="app-loading-card">
        <div className="app-loading-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" role="img">
            <rect width="64" height="64" rx="14" />
            <path d="M16 43h32" />
            <path className="spark-line" d="M18 39l8-11 8 7 12-16" />
            <circle className="spark-dot amber" cx="26" cy="28" r="4" />
            <circle className="spark-dot green" cx="34" cy="35" r="4" />
            <circle className="spark-dot white" cx="46" cy="19" r="4" />
          </svg>
        </div>
        <div>
          <h1>Training Observability</h1>
          <p>Loading workspace</p>
        </div>
        <div className="app-loading-bars" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </main>
  );
}
