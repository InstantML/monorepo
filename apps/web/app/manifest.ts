import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "InstantML",
    short_name: "InstantML",
    description:
      "Training observability with fast run comparison, predictable pricing, and clearer control over experiment data for lean ML teams.",
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
