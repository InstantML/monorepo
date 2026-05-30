import type { Metadata } from "next";
import { PricingPage } from "../../components/pricing/PricingPage";

/**
 * Public pricing surface.
 *
 * Scope: marketing-style public page exposing the implemented Free / Pro /
 * Premium tiers, usage limits, and explicit overage model. Competitor pricing
 * comparisons stay out of this route unless reverified for launch.
 *
 * Driven by the 2026-05-19 UI audit finding (P2 strategic gap: no pricing
 * surface in the product or marketing).
 */
const PRICING_TITLE = "Pricing";
const PRICING_DESCRIPTION =
  "Predictable InstantML pricing for training observability: Free, Pro, and Premium plans with explicit usage limits, storage overage, API request overage, and no tracked-hour billing.";

export const metadata: Metadata = {
  title: PRICING_TITLE,
  description: PRICING_DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: {
    type: "website",
    url: "https://instantml.ai/pricing",
    siteName: "InstantML",
    title: `${PRICING_TITLE} · InstantML`,
    description: PRICING_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PRICING_TITLE} · InstantML`,
    description: PRICING_DESCRIPTION,
  },
};

export default function PricingRoute() {
  return <PricingPage />;
}
