import { buildQuote, liveDeps } from "@/server/quote";
import { caller, errorResponse, serviceClient } from "@/server/supabase";
import { bookableVendorIds } from "@/server/vendors";

/** POST /api/v1/quotes — check a booking and return the price (locked for 15 minutes). */
export async function POST(req: Request) {
  try {
    const me = await caller(req);
    const vendorIds = await bookableVendorIds(me.db, me.user.id);
    const quote = await buildQuote(await req.json(), liveDeps(serviceClient(), me.user.id, vendorIds));
    return Response.json(quote);
  } catch (e) {
    return errorResponse(e);
  }
}
