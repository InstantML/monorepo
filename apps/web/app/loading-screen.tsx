import { InstantMlMark } from "./instantml-mark";

export function AppLoadingScreen({ detail = "Loading workspace" }: { detail?: string }) {
  const rows = ["wide", "medium", "short", "medium"];

  return (
    <main className="app-loading-screen" aria-label="Loading InstantML" aria-busy="true">
      <div className="app-loading-shell">
        <div className="app-loading-header">
          <div className="app-loading-mark" aria-hidden="true">
            <InstantMlMark loading />
          </div>
          <div className="app-loading-text">
            <h1>InstantML</h1>
            <p key={detail} aria-live="polite">
              {detail}
            </p>
          </div>
        </div>

        <div className="app-loading-track" aria-hidden="true">
          <span />
        </div>

        <div className="app-loading-preview" aria-hidden="true">
          <div className="app-loading-preview-toolbar">
            <span />
            <span />
            <span />
          </div>
          <div className="app-loading-preview-body">
            <div className="app-loading-preview-rail">
              {rows.map((size, index) => (
                <div className="app-loading-preview-row" key={`${size}-${index}`}>
                  <i />
                  <span className={`app-loading-preview-line is-${size}`} />
                  <small />
                </div>
              ))}
            </div>
            <div className="app-loading-preview-chart">
              <div className="app-loading-chart-grid" />
              <div className="app-loading-chart-skeleton">
                <span className="is-wide" />
                <span className="is-medium" />
                <span className="is-short" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
