import type { Metadata } from "next";
import { AuthFlow } from "../auth-flow";

export const metadata: Metadata = {
  title: "Onboarding",
  robots: { index: false, follow: false },
};

export default function OnboardingPage() {
  return <AuthFlow mode="onboarding" />;
}
