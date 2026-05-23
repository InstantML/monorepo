import { InstantMlMark } from "./instantml-mark";

export function AppLoadingScreen({ detail = "Loading workspace" }: { detail?: string }) {
  return (
    <main className="app-loading-screen" aria-label="Loading InstantML" aria-busy="true">
      <div className="app-loading-aurora" aria-hidden="true" />
      <div className="app-loading-grid" aria-hidden="true" />
      <div className="app-loading-card">
        <div className="app-loading-mark" aria-hidden="true">
          <div className="app-loading-mark-ring" />
          <InstantMlMark loading />
        </div>
        <div className="app-loading-text">
          <h1>InstantML</h1>
          <p key={detail} aria-live="polite">
            {detail}
          </p>
        </div>
      </div>
    </main>
  );
}
