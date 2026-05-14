import { InstantMlMark } from "./instantml-mark";

export function AppLoadingScreen() {
  return (
    <main className="app-loading-screen" aria-label="Loading InstantML">
      <div className="app-loading-card">
        <div className="app-loading-mark" aria-hidden="true">
          <InstantMlMark />
        </div>
        <div>
          <h1>InstantML</h1>
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
