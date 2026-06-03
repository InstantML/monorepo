import type { MetadataRoute } from "next";

import { loadPublicDocsPages } from "../src/docs";

const SITE_URL = "https://instantml.ai";

function docsUrl(pagePath: string) {
  if (pagePath === "index") return `${SITE_URL}/docs`;
  return `${SITE_URL}/docs/${pagePath}`;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const docsPages = await loadPublicDocsPages();
  const publicPages: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/pricing`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/signup`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/signin`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
  const docsEntries: MetadataRoute.Sitemap = docsPages.map((page: { path: string }) => ({
    url: docsUrl(page.path),
    lastModified: now,
    changeFrequency: "weekly",
    priority: page.path === "index" ? 0.9 : 0.7,
  }));
  return [...publicPages, ...docsEntries];
}
