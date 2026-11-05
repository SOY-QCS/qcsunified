import { anonClient, json, preflight } from "@/server/tracking";

export const OPTIONS = preflight;

/** GET /api/v1/help — published help-centre articles (public; the website and apps show them). */
export async function GET() {
  const { data, error } = await anonClient().from("help_articles").select("id, slug, audience, category, title, body, sort").eq("published", true).order("sort");
  return error ? json({ error: "Help is not available right now" }, 503) : json({ articles: data });
}
