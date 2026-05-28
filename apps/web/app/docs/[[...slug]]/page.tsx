import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ChevronRight, Globe } from "lucide-react";

import { DocsAgentMarkdownButton } from "../docs-agent-markdown-button";
import { DocsCodeBlock } from "../docs-code-block";
import { DocsSearch } from "../docs-search";
import { InstantMlMark } from "../../instantml-mark";
import {
  docsMarkdownUrl,
  docsHref,
  loadDocsPage,
  mapDocsAssetSrc,
} from "../../../src/docs";

type DocsParams = {
  params: Promise<{ slug?: string[] }>;
};

type DocsNavigation = Array<{
  tab: string;
  groups: Array<{
    group: string;
    pages: Array<{ path: string; title: string }>;
  }>;
}>;

type DocsBlock =
  | { type: "heading"; level: number; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "image"; alt: string; src: string }
  | { type: "code"; language: string; code: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "cards"; cards: Array<{ title: string; icon: string; href: string; description: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: DocsParams): Promise<Metadata> {
  const { slug = [] } = await params;
  try {
    const page = await loadDocsPage(slug);
    return {
      title: `${page.title} | InstantML Docs`,
      description: page.description,
    };
  } catch {
    return {
      title: "InstantML Docs",
      description: "InstantML documentation.",
    };
  }
}

export default async function DocsPage({ params }: DocsParams) {
  const { slug = [] } = await params;
  const page = await loadDocsPage(slug).catch(() => null);
  if (!page) notFound();
  const blocks = "blocks" in page && Array.isArray(page.blocks) ? (page.blocks as DocsBlock[]) : [];
  const endpoints = "endpoints" in page && Array.isArray(page.endpoints) ? page.endpoints : [];
  const markdownHref = docsMarkdownUrl(page.path);
  const navigation = page.navigation as DocsNavigation;
  const activeTab = findActiveTab(navigation, page.path);

  return (
    <main className="docs-route">
      <header className="docs-route-topbar">
        <div className="docs-route-topbar-row docs-route-topbar-row-primary">
          <Link className="docs-route-brand" href="/docs" aria-label="InstantML Docs home">
            <span className="docs-route-brand-mark" aria-hidden>
              <InstantMlMark />
            </span>
            <span className="docs-route-brand-text">
              <strong>InstantML</strong>
              <small>Docs</small>
            </span>
          </Link>
          <DocsSearch navigation={navigation} />

          <nav className="docs-route-topbar-actions" aria-label="Docs account actions">
            <Link href="/dashboard">App</Link>
            <Link href="/docs/api-reference">API reference</Link>
          </nav>
        </div>
        <div className="docs-route-topbar-row docs-route-topbar-row-secondary">
          <nav className="docs-route-tabs" aria-label="Docs sections">
            {navigation.map((tab) => {
              const targetPath = firstPagePath(tab);
              const href = targetPath ? pageUrl(targetPath) : "/docs";
              const isActive = tab.tab === activeTab;
              return (
                <Link
                  className={isActive ? "docs-route-tab is-active" : "docs-route-tab"}
                  href={href}
                  key={tab.tab}
                >
                  {tab.tab}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <div className="docs-route-shell">
        <DocsSidebar navigation={navigation} currentPath={page.path} activeTab={activeTab} />
        <article className="docs-route-article">
          <header className="docs-route-article-header">
            <div>
              <div className="docs-route-eyebrow">InstantML documentation</div>
              <h1>{page.title}</h1>
              {page.description ? <p className="docs-route-description">{page.description}</p> : null}
            </div>
            <div className="docs-route-agent-actions" aria-label="Agent-readable docs actions">
              <DocsAgentMarkdownButton href={markdownHref} />
              <Link className="docs-route-agent-link" href={markdownHref}>
                Open .md
              </Link>
            </div>
          </header>
          {page.kind === "api-reference" ? (
            <ApiReference endpoints={endpoints} />
          ) : (
            <div className="docs-route-body">
              {blocks.map((block, index) => (
                <DocsBlockView block={block} key={`${block.type}-${index}`} />
              ))}
            </div>
          )}
        </article>
      </div>
    </main>
  );
}

function findActiveTab(navigation: DocsNavigation, currentPath: string): string | null {
  for (const tab of navigation) {
    for (const group of tab.groups) {
      if (group.pages.some((page) => page.path === currentPath)) return tab.tab;
    }
  }
  return navigation[0]?.tab ?? null;
}

function firstPagePath(tab: DocsNavigation[number]): string | null {
  for (const group of tab.groups) {
    if (group.pages.length > 0) return group.pages[0].path;
  }
  return null;
}

function DocsSidebar({
  navigation,
  currentPath,
  activeTab,
}: {
  navigation: DocsNavigation;
  currentPath: string;
  activeTab: string | null;
}) {
  const visibleTabs = activeTab
    ? navigation.filter((tab) => tab.tab === activeTab)
    : navigation;
  return (
    <aside className="docs-route-sidebar" aria-label="Documentation navigation">
      <div className="docs-route-sidebar-scroll">
        <Link className="docs-route-sidebar-overview" href="/docs">
          Overview
        </Link>
        {visibleTabs.map((tab) => (
          <section key={tab.tab}>
            {tab.groups.map((group) => {
              const groupHasActive = group.pages.some((page) => page.path === currentPath);
              return (
                <details
                  className="docs-route-nav-group"
                  key={`${tab.tab}-${group.group}`}
                  open={groupHasActive}
                >
                  <summary className="docs-route-nav-group-summary">
                    <ChevronRight aria-hidden size={12} className="docs-route-nav-chevron" />
                    <h3>{group.group}</h3>
                  </summary>
                  <div className="docs-route-nav-links">
                    {group.pages.map((page) => (
                      <Link
                        className={
                          page.path === currentPath
                            ? "docs-route-nav-link is-active"
                            : "docs-route-nav-link"
                        }
                        href={pageUrl(page.path)}
                        key={page.path}
                      >
                        <span>{page.title}</span>
                      </Link>
                    ))}
                  </div>
                </details>
              );
            })}
          </section>
        ))}
      </div>
      <div className="docs-route-sidebar-footer">
        <button type="button" className="docs-route-sidebar-locale">
          <span aria-hidden>🇺🇸</span>
          <span>United States</span>
        </button>
        <button type="button" className="docs-route-sidebar-locale">
          <Globe aria-hidden size={14} />
          <span>English (United States)</span>
        </button>
      </div>
    </aside>
  );
}

function DocsBlockView({ block }: { block: DocsBlock }) {
  if (block.type === "heading") {
    const Heading = `h${Math.min(Math.max(block.level, 2), 4)}` as "h2" | "h3" | "h4";
    return (
      <Heading id={block.id}>
        <a href={`#${block.id}`}>{renderInline(block.text)}</a>
      </Heading>
    );
  }

  if (block.type === "paragraph") {
    return <p>{renderInline(block.text)}</p>;
  }

  if (block.type === "image") {
    return (
      <figure className="docs-route-figure">
        <img src={mapDocsAssetSrc(block.src)} alt={block.alt} />
        {block.alt ? <figcaption>{block.alt}</figcaption> : null}
      </figure>
    );
  }

  if (block.type === "code") {
    return <DocsCodeBlock code={block.code} language={block.language} />;
  }

  if (block.type === "table") {
    return (
      <div className="docs-route-table-wrap">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, index) => (
                <th key={`${header}-${index}`}>{renderInline(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={`${rowIndex}-${cellIndex}`}>{renderInline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List>
        {block.items.map((item, index) => (
          <li key={`${item}-${index}`}>{renderInline(item)}</li>
        ))}
      </List>
    );
  }

  return (
    <div className="docs-route-card-grid">
      {block.cards.map((card) => (
        <Link className="docs-route-card" href={docsHref(card.href)} key={card.href}>
          <span className="docs-route-card-icon">{card.icon ? card.icon.slice(0, 1).toUpperCase() : "D"}</span>
          <span>
            <strong>{card.title}</strong>
            <small>{card.description}</small>
          </span>
        </Link>
      ))}
    </div>
  );
}

function ApiReference({
  endpoints,
}: {
  endpoints: Array<{
    method: string;
    path: string;
    summary: string;
    tags: string[];
    parameters?: Array<{ name: string; in: string; required: boolean; description: string }>;
    requestBody?: boolean;
    responseCodes?: string[];
    security?: string[];
  }>;
}) {
  return (
    <div className="docs-route-api-list">
      {endpoints.map((endpoint) => (
        <section className="docs-route-api-row" key={`${endpoint.method}-${endpoint.path}`}>
          <span className={`docs-route-method method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
          <code>{endpoint.path}</code>
          <p>{endpoint.summary}</p>
          <dl>
            {endpoint.security?.length ? (
              <>
                <dt>Auth</dt>
                <dd>{endpoint.security.join(", ")}</dd>
              </>
            ) : null}
            {endpoint.parameters?.length ? (
              <>
                <dt>Parameters</dt>
                <dd>
                  {endpoint.parameters.map((parameter) => `${parameter.name}${parameter.required ? " required" : ""}`).join(", ")}
                </dd>
              </>
            ) : null}
            {endpoint.requestBody ? (
              <>
                <dt>Request body</dt>
                <dd>Yes</dd>
              </>
            ) : null}
            {endpoint.responseCodes?.length ? (
              <>
                <dt>Responses</dt>
                <dd>{endpoint.responseCodes.join(", ")}</dd>
              </>
            ) : null}
          </dl>
        </section>
      ))}
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(renderInlineToken(match[0], `${index}-${match[0]}`));
    cursor = index + match[0].length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function renderInlineToken(token: string, key: string): ReactNode {
  if (token.startsWith("`")) {
    return <code key={key}>{token.slice(1, -1)}</code>;
  }
  if (token.startsWith("**")) {
    return <strong key={key}>{token.slice(2, -2)}</strong>;
  }
  const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
  if (link) {
    return (
      <Link href={docsHref(link[2])} key={key}>
        {link[1]}
      </Link>
    );
  }
  return token;
}

function pageUrl(pagePath: string) {
  if (pagePath === "index") return "/docs";
  return `/docs/${pagePath}`;
}
