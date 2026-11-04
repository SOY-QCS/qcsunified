import { errorResponse } from "@/server/supabase";
import { CORS, json, preflight, track, viewerClient } from "@/server/tracking";
import { serviceClient } from "@/server/supabase";

export const OPTIONS = preflight;

/**
 * GET /api/v1/track/ACC-202611041301-KUM?last4=1234 — public tracking.
 * Without the last 4 digits of the recipient's phone: status and timeline only. With them (or signed in as the sender):
 * map, rider, arrival estimate. Poll every 10–15 seconds while the parcel is moving.
 */
export async function GET(req: Request, ctx: { params: Promise<{ tn: string }> }) {
  try {
    const { tn } = await ctx.params;
    const last4 = new URL(req.url).searchParams.get("last4");
    let service = null;
    try { service = serviceClient(); } catch { /* no photo links without the server key */ }
    const r = await track(await viewerClient(req), service, decodeURIComponent(tn), last4);
    return Response.json(r, { status: r.found ? 200 : 404, headers: { ...CORS, "Cache-Control": "no-store" } });
  } catch (e) {
    const r = errorResponse(e);
    return json(await r.json(), r.status);
  }
}
