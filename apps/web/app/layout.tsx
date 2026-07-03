import "./globals.css";
import "./auth.css";
import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { DM_Sans, Spline_Sans_Mono, Instrument_Serif } from "next/font/google";
import { headers } from "next/headers";

import { serializeJsonLd } from "../src/json-ld.js";

// Instrument design language (docs/design/reimagine/DESIGN-SYSTEM.md):
// DM Sans carries display + UI prose, Spline Sans Mono carries all data.

const mono = Spline_Sans_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-mono-next",
  display: "swap",
});

// Primary UI + prose font for the whole site (self-hosted by next/font — no
// external request). Loaded as a variable font so the full weight range is
// available across the dashboard, landing page, auth, and docs.
const sans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
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
  // No layout-level canonical: each indexable page declares its own, and a
  // shared "/" here would make noindex pages (dashboard, share links) claim
  // the homepage as their canonical.
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

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "InstantML",
  url: SITE_URL,
  logo: `${SITE_URL}/instantml-mark.svg`,
};

// Tells search engines the preferred site name for result snippets.
const webSiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "InstantML",
  url: SITE_URL,
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

const clerkAppearance = {
  variables: {
    colorBackground: "#ffffff",
    colorText: "#172016",
    colorTextSecondary: "#64715b",
    colorPrimary: "#0f8a54",
    colorDanger: "#b42318",
    colorInputBackground: "#ffffff",
    colorInputText: "#172016",
    borderRadius: "6px",
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const isEmbedRoute = requestHeaders.get("x-instantml-embed-route") === "1";
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        {isEmbedRoute ? null : (
          <>
            <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
            <script dangerouslySetInnerHTML={{ __html: logoIntroFlag }} />
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: serializeJsonLd(organizationJsonLd) }}
            />
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: serializeJsonLd(webSiteJsonLd) }}
            />
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: serializeJsonLd(softwareApplicationJsonLd) }}
            />
          </>
        )}
      </head>
      <body>
        {isEmbedRoute ? children : <ClerkProvider appearance={clerkAppearance}>{children}</ClerkProvider>}
      </body>
    </html>
  );
}
