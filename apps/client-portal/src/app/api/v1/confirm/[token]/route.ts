import { z } from "zod";
import { ApiError, errorResponse, serviceClient } from "@/server/supabase";
import { anonClient, json, liveMoveDeps, movePin, preflight } from "@/server/tracking";
import { clientIp, limited } from "@/server/rate-limit";

export const OPTIONS = preflight;

/** GET /api/v1/confirm/<token> — what the recipient sees on the confirm-your-location page (no login). */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const stop = await limited("confirmView", `ip:${clientIp(req)}`); if (stop) return stop;
  const { token } = await ctx.params;
  const { data } = await anonClient().rpc("address_link", { p_token: token });
  return data ? json(data) : json({ error: "This link is not valid" }, 404);
}

const Body = z.union([
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("move"), lat: z.number().min(4).max(12), lng: z.number().min(-4).max(2),
             landmark: z.string().max(200).optional(), note: z.string().max(300).optional() }),
]);

/** POST {action:"confirm"} or {action:"move", lat, lng, landmark?, note?} */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const stop = await limited("confirmView", `ip:${clientIp(req)}`); if (stop) return stop;
    const { token } = await ctx.params;
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Please check the location");
    if (body.data.action === "confirm") {
      const { error } = await anonClient().rpc("confirm_address", { p_token: token });
      if (error) throw new ApiError(400, error.message);
      return json({ ok: true, confirmed: true });
    }
    const tooMany = await limited("confirmMove", `link:${token}`); if (tooMany) return tooMany;
    const r = await movePin(token, body.data, liveMoveDeps(serviceClient()));
    return json({ ok: true, ...r });
  } catch (e) {
    const r = errorResponse(e);
    return json(await r.json(), r.status);
  }
}
