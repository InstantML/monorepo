import type { Metadata } from "next";
import { PricingPage } from "../../components/pricing/PricingPage";

/**
 * Public pricing surface.
 *
 * Scope: marketing-style public page exposing the Free / Pro / Premium tiers,
 * a head-to-head W&B cost comparison for a 5-person team, and a "surprise
 * costs" section that names the W&B-specific pain (per-seat creep, surprise
 * artifact billing per wandb#10459, no unlimited free viewers).
 *
 * Driven by the 2026-05-19 UI audit finding (P2 strategic gap: no pricing
 * surface in the product or marketing).
 *
 * Placeholder W&B numbers — confirm with a sales rep / public quote
 * before going live. Marked TODO in PricingPage.tsx.
 */
export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Flat monthly pricing for InstantML — Free, Pro, Premium. Unlimited free viewer seats on every tier. No per-tracked-hour bill creep, no surprise artifact storage charges.",
};

export default function PricingRoute() {
  return <PricingPage />;
}
