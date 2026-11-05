import { ApiSimulateRequest, apiProblems } from "@qcs/types";
import { ApiError } from "@/server/supabase";
import { runApi } from "@/server/business/http";

/** POST /api/business/v1/deliveries/{id}/simulate — TEST MODE ONLY: move a practice delivery to a status and fire its webhook. */
export const POST = (req: Request, ctx2: { params: Promise<{ id: string }> }) => runApi(req, async (ctx, _deps, body, db) => {
  const { id } = await ctx2.params;
  const p = ApiSimulateRequest.safeParse(body);
  if (!p.success) throw new ApiError(400, "Send { \"status\": \"PICKED_UP\" }", apiProblems(p.error), "invalid_request");
  const { data, error } = await db.rpc("api_test_transition", { p_vendor: ctx.vendorId, p_tracking: decodeURIComponent(id), p_to: p.data.status, p_reason: p.data.reason ?? null });
  if (error) throw new ApiError(/not found/i.test(error.message) ? 404 : 400, error.message, undefined, /not found/i.test(error.message) ? "not_found" : "invalid_request");
  return { status: 200, body: data, reference: decodeURIComponent(id) };
}, { testOnly: true });
