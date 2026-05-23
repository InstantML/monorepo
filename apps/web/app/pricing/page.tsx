import type { Metadata } from "next";
import { PricingPage } from "../../components/pricing/PricingPage";

/**
 * Public pricing surface.
 *
 * Scope: marketing-style public page exposing the Free / Pro / Premium tiers,
 * a head-to-head W&B cost comparison for a 5-person team, and a "surprise
 * costs" section that names the W&B-specific pain (per-seat creep, surprise
 * artifact billing per wandb#10459, clear read-only viewer roles).
 *
 * Driven by the 2026-05-19 UI audit finding (P2 strategic gap: no pricing
 * surface in the product or marketing).
 *
 * Placeholder W&B numbers — confirm with a sales rep / public quote
 * before going live. Marked TODO in PricingPage.tsx.
 */
const PRICING_TITLE = "Pricing";
const PRICING_DESCRIPTION =
  "Flat monthly pricing for InstantML — Free, Pro, Premium. Role-aware seats, no per-tracked-hour bill creep, no surprise artifact storage charges.";

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
