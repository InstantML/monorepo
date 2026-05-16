import "./globals.css";
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

export const metadata = {
  title: "InstantML",
  description: "Training observability that's actually fast.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
