import "./globals.css";
import "./auth.css";
import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

const sans = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans-next",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
    document.documentElement.style.backgroundColor = theme === "dark" ? "#07080c" : "#ffffff";
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.backgroundColor = "#07080c";
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
  title: "InstantML",
  description: "Training observability that's actually fast.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#07080c",
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
