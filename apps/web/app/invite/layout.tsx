import type { Metadata } from "next";
import type { ReactNode } from "react";

// The invite page is a client component, so its metadata lives here. Invite
// links are emailed secret-token URLs and must stay out of search indexes.
export const metadata: Metadata = {
  title: "Workspace invite",
  robots: { index: false, follow: false },
};

export default function InviteLayout({ children }: { children: ReactNode }) {
  return children;
}
