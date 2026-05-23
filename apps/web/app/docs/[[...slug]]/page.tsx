import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { DocsCodeBlock } from "../docs-code-block";
import {
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
  let page;
  try {
    page = await loadDocsPage(slug);
  } catch {
    notFound();
  }
  const blocks = "blocks" in page && Array.isArray(page.blocks) ? (page.blocks as DocsBlock[]) : [];
  const endpoints = "endpoints" in page && Array.isArray(page.endpoints) ? page.endpoints : [];

  return (
    <main className="docs-route">
      <header className="docs-route-topbar">
        <Link className="docs-route-brand" href="/docs" aria-label="InstantML Docs home">
          <span className="docs-route-brand-mark">I</span>
          <span>
            <strong>InstantML</strong>
            <small>Docs</small>
          </span>
        </Link>
        <nav aria-label="Docs links">
          <Link href="/dashboard">App</Link>
          <Link href="/docs/api-reference">API reference</Link>
        </nav>
      </header>

      <div className="docs-route-shell">
        <DocsSidebar navigation={page.navigation as DocsNavigation} currentPath={page.path} />
        <article className="docs-route-article">
          <div className="docs-route-eyebrow">InstantML documentation</div>
          <h1>{page.title}</h1>
          {page.description ? <p className="docs-route-description">{page.description}</p> : null}
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

function DocsSidebar({ navigation, currentPath }: { navigation: DocsNavigation; currentPath: string }) {
  return (
    <aside className="docs-route-sidebar" aria-label="Documentation navigation">
      {navigation.map((tab) => (
        <section key={tab.tab}>
          <h2>{tab.tab}</h2>
          {tab.groups.map((group) => (
            <div className="docs-route-nav-group" key={`${tab.tab}-${group.group}`}>
              <h3>{group.group}</h3>
              {group.pages.map((page) => (
                <Link
                  className={page.path === currentPath ? "active" : ""}
                  href={pageUrl(page.path)}
                  key={page.path}
                >
                  {page.title}
                </Link>
              ))}
            </div>
          ))}
        </section>
      ))}
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
