import { errorResponse, serviceClient } from "@/server/supabase";
import { CORS, json, preflight } from "@/server/tracking";
import { clientIp, limited } from "@/server/rate-limit";
import { publicDeps, publicRates } from "@/server/public-rates";

export const OPTIONS = preflight;

/** POST /api/v1/rates — the website's rate calculator: { from_zone, to_zone, weight_kg, fragile }. Nothing is saved. */
export async function POST(req: Request) {
  try {
    const stop = await limited("publicRates", `ip:${clientIp(req)}`); if (stop) return stop;
    return Response.json(await publicRates(await req.json(), publicDeps(serviceClient())), { headers: { ...CORS, "Cache-Control": "no-store" } });
  } catch (e) {
    const r = errorResponse(e);
    return json(await r.json(), r.status);
  }
}
