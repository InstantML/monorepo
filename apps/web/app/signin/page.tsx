import type { Metadata } from "next";
import { AuthFlow } from "../auth-flow";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your InstantML account.",
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return <AuthFlow mode="signin" />;
}
