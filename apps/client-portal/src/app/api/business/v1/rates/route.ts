import { runApi } from "@/server/business/http";
import { rates } from "@/server/business/core";

/** POST /api/business/v1/rates — prices for a checkout page (nothing is saved or booked). */
export const POST = (req: Request) => runApi(req, async (ctx, deps, body) => ({ status: 200, body: await rates(ctx, body, deps) }));
