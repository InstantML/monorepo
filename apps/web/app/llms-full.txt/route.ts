import { loadDocsMarkdownFull } from "../../src/docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(await loadDocsMarkdownFull(), {
    headers: {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
