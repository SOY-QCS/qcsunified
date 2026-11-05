import { ApiError } from "@/server/supabase";
import { runApi } from "@/server/business/http";

/** GET /api/business/v1/deliveries/{tracking number or your reference} — current status and history. */
export const GET = (req: Request, ctx2: { params: Promise<{ id: string }> }) => runApi(req, async (ctx, _deps, _body, db) => {
  const { id } = await ctx2.params;
  const { data } = await db.rpc(ctx.mode === "test" ? "api_test_get" : "api_get_delivery", { p_vendor: ctx.vendorId, p_tracking: decodeURIComponent(id) });
  if (!data) throw new ApiError(404, "Delivery not found", undefined, "not_found");
  return { status: 200, body: data, reference: (data as { tracking_number: string }).tracking_number };
});
