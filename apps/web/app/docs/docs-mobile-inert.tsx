"use client";

import { useEffect } from "react";

export function DocsMobileInert() {
  useEffect(() => {
    const media = window.matchMedia("(max-width: 960px)");
    const sidebar = document.querySelector<HTMLElement>(".docs-route-sidebar");
    if (!sidebar) return undefined;
    const inertSidebar = sidebar as HTMLElement & { inert: boolean };

    function applyInert() {
      inertSidebar.inert = media.matches;
      if (media.matches) inertSidebar.setAttribute("aria-hidden", "true");
      else inertSidebar.removeAttribute("aria-hidden");
    }

    applyInert();
    media.addEventListener("change", applyInert);
    return () => {
      media.removeEventListener("change", applyInert);
      inertSidebar.inert = false;
      inertSidebar.removeAttribute("aria-hidden");
    };
  }, []);

  return null;
}
