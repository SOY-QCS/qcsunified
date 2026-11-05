import { placeDetails } from "@/server/maps";
import { ApiError, caller, errorResponse } from "@/server/supabase";
import { limited } from "@/server/rate-limit";

/** GET /api/v1/places/details?id=...&session=... — the pin for a chosen suggestion. */
export async function GET(req: Request) {
  try {
    const me = await caller(req);
    const stop = await limited("placeDetails", `user:${me.user.id}`); if (stop) return stop;
    const u = new URL(req.url);
    const place = await placeDetails(u.searchParams.get("id") ?? "", u.searchParams.get("session") ?? "");
    if (!place) throw new ApiError(404, "Couldn't find that place");
    return Response.json(place);
  } catch (e) {
    return errorResponse(e);
  }
}
