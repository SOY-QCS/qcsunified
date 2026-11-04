import { z } from "zod";
import { ApiError, caller, errorResponse, serviceClient } from "@/server/supabase";

const Body = z.object({ quote_id: z.uuid() });

/** POST /api/v1/bookings — confirm a quote. Creates the order(s) and tracking numbers. */
export async function POST(req: Request) {
  try {
    const me = await caller(req);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) throw new ApiError(400, "quote_id is required");
    const { data, error } = await serviceClient().rpc("create_booking", { p_user: me.user.id, p_quote: parsed.data.quote_id });
    if (error) throw new ApiError(400, error.message);
    return Response.json(data, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
