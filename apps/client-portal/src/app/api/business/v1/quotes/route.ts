import { runApi } from "@/server/business/http";
import { quote } from "@/server/business/core";

/** POST /api/business/v1/quotes — a price for one delivery, held for 15 minutes; book it with POST /deliveries {quote_id}. */
export const POST = (req: Request) => runApi(req, async (ctx, deps, body) => ({ status: 201, body: await quote(ctx, body, deps) }));
