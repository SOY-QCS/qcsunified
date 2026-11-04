import { autocomplete, hasGoogle } from "@/server/maps";
import { caller, errorResponse } from "@/server/supabase";

/** GET /api/v1/places/autocomplete?q=osu&session=...&lat=&lng= — address suggestions in Ghana. */
export async function GET(req: Request) {
  try {
    await caller(req);
    const u = new URL(req.url);
    const q = u.searchParams.get("q") ?? "", session = u.searchParams.get("session") ?? crypto.randomUUID();
    const lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
    const near = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 ? { lat, lng } : undefined;
    return Response.json({ suggestions: await autocomplete(q, session, near), available: hasGoogle() });
  } catch (e) {
    return errorResponse(e);
  }
}
