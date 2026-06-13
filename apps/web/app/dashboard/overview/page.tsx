import { DashboardShell } from "../dashboard-shell";

// Static segment for the Overview cockpit. It intentionally lives outside the
// [[...tab]] catch-all (and outside routes.js's canonical tab ids): Next.js
// prefers the static segment, and the shell resolves "overview" itself via
// shellTabFromPath.
export default function DashboardOverviewPage() {
  return <DashboardShell initialTab="overview" />;
}
