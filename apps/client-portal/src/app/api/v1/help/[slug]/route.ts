import { anonClient, json, preflight } from "@/server/tracking";

export const OPTIONS = preflight;

/** GET /api/v1/help/<slug> — one published article. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const { data } = await anonClient().from("help_articles").select("slug, audience, category, title, body").eq("slug", slug).eq("published", true).maybeSingle();
  return data ? json(data) : json({ error: "Article not found" }, 404);
}
