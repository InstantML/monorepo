import type { MetadataRoute } from "next";

import { loadPublicDocsPages } from "../src/docs";

const SITE_URL = "https://instantml.ai";

function docsUrl(pagePath: string) {
  if (pagePath === "index") return `${SITE_URL}/docs`;
  return `${SITE_URL}/docs/${pagePath}`;
}

// No lastModified: stamping every entry with the build time is inaccurate,
// and search engines ignore lastmod once they see it change without content
// changes. /signin is intentionally absent — it is noindex.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docsPages = await loadPublicDocsPages();
  const publicPages: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/pricing`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/signup`,
      changeFrequency: "yearly",
      priority: 0.6,
    },
  ];
  const docsEntries: MetadataRoute.Sitemap = docsPages.map((page: { path: string }) => ({
    url: docsUrl(page.path),
    changeFrequency: "weekly",
    priority: page.path === "index" ? 0.9 : 0.7,
  }));
  return [...publicPages, ...docsEntries];
}
