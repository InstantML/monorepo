import "./globals.css";
import type { ReactNode } from "react";

const themeBootstrap = `
(() => {
  try {
    const stored = localStorage.getItem("rlobs:next:theme");
    const theme = stored === "dark" || stored === "light"
      ? stored
      : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.backgroundColor = theme === "dark" ? "#070b13" : "#f4f6f8";
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.backgroundColor = "#070b13";
  }
})();
`;

export const metadata = {
  title: "Training Observability",
  description: "Training observability for serious training loops",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
