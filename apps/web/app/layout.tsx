import "./globals.css";
import "./auth.css";
import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Archivo, Spline_Sans_Mono, Instrument_Serif } from "next/font/google";

// Instrument design language (docs/design/reimagine/DESIGN-SYSTEM.md):
// Archivo carries display + UI prose, Spline Sans Mono carries all data.
const display = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans-next",
  display: "swap",
});

const mono = Spline_Sans_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
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
    const theme = stored === "dark" || stored === "light" ? stored : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.backgroundColor = theme === "dark" ? "#0d0f0c" : "#f6f7f3";
  } catch {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.backgroundColor = "#f6f7f3";
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
      window.setTimeout(function() {
        document.documentElement.classList.add('no-logo-anim');
      }, 1800);
    }
  } catch (e) {}
})();
`;

const SITE_URL = "https://instantml.ai";
const SITE_TAGLINE =
  "Training observability with fast run comparison, predictable pricing, and clearer control over experiment data for lean ML teams.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "InstantML: Training observability that keeps up with your loop",
    template: "%s · InstantML",
  },
  description: SITE_TAGLINE,
  applicationName: "InstantML",
  authors: [{ name: "InstantML" }],
  keywords: [
    "InstantML",
    "ML observability",
    "training observability",
    "experiment tracking",
    "Weights and Biases alternative",
    "W&B alternative",
    "ML experiment tracker",
    "machine learning",
  ],
  category: "technology",
  formatDetection: { telephone: false },
  alternates: { canonical: "/" },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/instantml-mark.svg",
    apple: "/instantml-mark.svg",
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "InstantML",
    title: "InstantML: Training observability that keeps up with your loop",
    description: SITE_TAGLINE,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "InstantML: Training observability that keeps up with your loop",
    description: SITE_TAGLINE,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d0f0c",
};

// JSON-LD is embedded with dangerouslySetInnerHTML, so escape `<` (script
// breakout) and U+2028/U+2029 (invalid in JS string contexts) before inlining.
function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "InstantML",
  url: SITE_URL,
  logo: `${SITE_URL}/instantml-mark.svg`,
};

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "InstantML",
  url: SITE_URL,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  description: SITE_TAGLINE,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    name: "Free",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <script dangerouslySetInnerHTML={{ __html: logoIntroFlag }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(organizationJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(softwareApplicationJsonLd) }}
        />
      </head>
      <body>
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
