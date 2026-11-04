import { z } from "zod";
import { ApiError, caller, errorResponse } from "@/server/supabase";

/** POST /api/v1/referral { code } — a new customer enters a friend's referral code. */
export async function POST(req: Request) {
  try {
    const me = await caller(req);
    const b = z.object({ code: z.string().trim().min(4).max(20) }).safeParse(await req.json());
    if (!b.success) throw new ApiError(400, "Enter the referral code");
    const { data, error } = await me.db.rpc("apply_referral", { p_code: b.data.code });
    if (error) throw new ApiError(400, error.message);
    return Response.json({ referred_by: data });
  } catch (e) {
    return errorResponse(e);
  }
}
