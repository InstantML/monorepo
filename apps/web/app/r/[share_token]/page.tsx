import type { Metadata } from "next";

import { PublicReportPage } from "./public-report-page";

const SHARE_TITLE = "Shared report";
const SHARE_DESCRIPTION = "A read-only InstantML training report shared by its owner.";

// Share links are secret-token URLs: keep them out of search indexes while
// still giving pasted links a sensible unfurl title.
export const metadata: Metadata = {
  title: SHARE_TITLE,
  description: SHARE_DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    siteName: "InstantML",
    title: `${SHARE_TITLE} · InstantML`,
    description: SHARE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: `${SHARE_TITLE} · InstantML`,
    description: SHARE_DESCRIPTION,
  },
};

type PageProps = {
  params: Promise<{ share_token: string }>;
};

export default async function Page({ params }: PageProps) {
  const { share_token: shareToken } = await params;
  return <PublicReportPage shareToken={shareToken} />;
}
