import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Billing",
  robots: { index: false, follow: false },
};

export default function BillingLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
