import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "InstantML",
    short_name: "InstantML",
    description:
      "Training observability that's fast where W&B is slow, cheap where W&B is expensive, and built for the way ML teams actually work in 2026.",
    start_url: "/",
    display: "standalone",
    background_color: "#0e1116",
    theme_color: "#0e1116",
    icons: [
      {
        src: "/instantml-mark.svg",
        sizes: "96x96",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/instantml-mark.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
