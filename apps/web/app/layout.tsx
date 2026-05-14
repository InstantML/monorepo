import "./globals.css";
import type { ReactNode } from "react";

const themeBootstrap = `
(() => {
  try {
    const stored = localStorage.getItem("rlobs:next:theme");
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
