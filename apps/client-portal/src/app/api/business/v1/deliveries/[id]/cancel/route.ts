import { ApiCancelRequest } from "@qcs/types";
import { ApiError } from "@/server/supabase";
import { runApi } from "@/server/business/http";

/** POST /api/business/v1/deliveries/{id}/cancel — before the rider has picked it up. Refunds follow automatically. */
export const POST = (req: Request, ctx2: { params: Promise<{ id: string }> }) => runApi(req, async (ctx, _deps, body, db) => {
  const { id } = await ctx2.params;
  const reason = ApiCancelRequest.safeParse(body ?? {}).data?.reason ?? null;
  const { data, error } = await db.rpc(ctx.mode === "test" ? "api_test_cancel" : "api_cancel_delivery", { p_vendor: ctx.vendorId, p_tracking: decodeURIComponent(id), p_reason: reason });
  if (error) throw new ApiError(/not found/i.test(error.message) ? 404 : 409, error.message, undefined, /not found/i.test(error.message) ? "not_found" : "cannot_cancel");
  return { status: 200, body: data, reference: decodeURIComponent(id) };
});
