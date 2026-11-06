import { errorResponse, serviceClient } from "@/server/supabase";
import { CORS, json, preflight } from "@/server/tracking";
import { publicPlaces } from "@/server/public-rates";

export const OPTIONS = preflight;

/**
 * GET /api/v1/public — what the public website shows: cities with their delivery areas and hubs,
 * and the store links of the two apps. Cached for 5 minutes.
 */
export async function GET() {
  try {
    const db = serviceClient();
    const [cities, links] = await Promise.all([
      publicPlaces(db),
      db.from("app_settings").select("key, value").like("key", "app\\_store\\_url\\_%").is("city_id", null),
    ]);
    const apps = Object.fromEntries((links.data ?? []).map((r) => [String(r.key).replace("app_store_url_", ""), typeof r.value === "string" && r.value ? r.value : null]));
    return Response.json({ cities, apps }, { headers: { ...CORS, "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
  } catch (e) {
    const r = errorResponse(e);
    return json(await r.json(), r.status);
  }
}
