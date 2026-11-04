import { z } from "zod";
import { ApiError, caller, errorResponse } from "@/server/supabase";

/** POST /api/v1/wallet/withdraw { amount } — send wallet money back to the MoMo number that topped it up (Finance approves). */
export async function POST(req: Request) {
  try {
    const me = await caller(req);
    const b = z.object({ amount: z.number().int().positive() }).safeParse(await req.json());
    if (!b.success) throw new ApiError(400, "Enter an amount");
    const { data, error } = await me.db.rpc("request_withdrawal", { p_amount: b.data.amount });
    if (error) throw new ApiError(400, error.message);
    return Response.json({ id: data.id, status: data.status, momo_number: data.momo_number, amount: data.amount }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
