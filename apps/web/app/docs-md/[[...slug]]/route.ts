import { loadDocsMarkdown } from "../../../src/docs";

type DocsMarkdownParams = {
  params: Promise<{ slug?: string[] }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: DocsMarkdownParams) {
  const { slug = [] } = await params;
  try {
    const page = await loadDocsMarkdown(slug);
    return new Response(page.markdown, {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        "Content-Disposition": `inline; filename="${page.path.replaceAll("/", "-")}.md"`,
        "Content-Type": "text/markdown; charset=utf-8",
      },
    });
  } catch {
    return new Response("Not found\n", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
}
