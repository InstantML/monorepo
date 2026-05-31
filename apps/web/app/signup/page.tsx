import type { Metadata } from "next";
import { AuthFlow } from "../auth-flow";

const SIGNUP_TITLE = "Sign up";
const SIGNUP_DESCRIPTION =
  "Create your InstantML workspace and start tracking training runs in seconds.";

export const metadata: Metadata = {
  title: SIGNUP_TITLE,
  description: SIGNUP_DESCRIPTION,
  alternates: { canonical: "/signup" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: "https://instantml.ai/signup",
    siteName: "InstantML",
    title: `${SIGNUP_TITLE} · InstantML`,
    description: SIGNUP_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: `${SIGNUP_TITLE} · InstantML`,
    description: SIGNUP_DESCRIPTION,
  },
};

export default function SignUpPage() {
  return <AuthFlow mode="signup" />;
}
