import type { Metadata } from "next";

import { EmbeddedRunsCanvas } from "./embedded-runs-canvas";

type PageProps = {
  params: Promise<{ session_id: string }>;
};

export const metadata: Metadata = {
  title: "Embedded Runs",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function Page({ params }: PageProps) {
  const { session_id: sessionId } = await params;
  return <EmbeddedRunsCanvas sessionId={sessionId} />;
}
