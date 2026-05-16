import { InstantMlMark } from "./instantml-mark";

export function AppLoadingScreen({ detail = "Loading workspace" }: { detail?: string }) {
  return (
    <main className="app-loading-screen" aria-label="Loading InstantML">
      <div className="app-loading-card">
        <div className="app-loading-mark" aria-hidden="true">
          <InstantMlMark />
        </div>
        <div>
          <h1>InstantML</h1>
          <p>{detail}</p>
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
