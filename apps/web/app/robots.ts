import type { MetadataRoute } from "next";

const SITE_URL = "https://instantml.ai";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/runs/", "/projects", "/dashboard", "/auth", "/billing", "/onboarding"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
