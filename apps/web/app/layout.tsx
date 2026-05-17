import "./globals.css";
import "./auth.css";
import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono, Instrument_Serif } from "next/font/google";

const sans = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans-next",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-mono-next",
  display: "swap",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: "italic",
  variable: "--font-serif-next",
  display: "swap",
});

const themeBootstrap = `
(() => {
  try {
    const stored = localStorage.getItem("instantml:next:theme");
    const theme = stored === "dark" || stored === "light" ? stored : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.backgroundColor = theme === "dark" ? "#0E1116" : "#F5F4F1";
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.backgroundColor = "#0E1116";
  }
})();
`;

// Suppress the landing logo intro animation on repeat visits and when
// prefers-reduced-motion is set. Runs synchronously before first paint so
// there is no FOUC on the logo wordmark.
const logoIntroFlag = `
(function() {
  try {
    var k = 'instantml_logo_intro_v1';
    var seen = sessionStorage.getItem(k);
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (seen || reduce) {
      document.documentElement.classList.add('no-logo-anim');
    } else {
      sessionStorage.setItem(k, '1');
    }
  } catch (e) {}
})();
`;

export const metadata = {
  title: {
    default: "InstantML",
    template: "%s · InstantML",
  },
  description: "Training observability that's fast where W&B is slow, cheap where W&B is expensive, and built for the way ML teams actually work in 2026.",
  icons: {
    icon: "/instantml-mark.svg",
    apple: "/instantml-mark.svg",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0E1116",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <script dangerouslySetInnerHTML={{ __html: logoIntroFlag }} />
      </head>
      <body>
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
