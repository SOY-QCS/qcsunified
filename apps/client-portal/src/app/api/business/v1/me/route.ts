import { runApi } from "@/server/business/http";

/** GET /api/business/v1/me — which business and mode this key belongs to ("Test connection" in the plugins). */
export const GET = (req: Request) => runApi(req, async (ctx) => ({
  status: 200, body: { business: ctx.businessName, mode: ctx.mode, livemode: ctx.mode === "live", has_default_pickup: !!ctx.defaultPickupId },
}));
