import { ApiBulkRequest, apiProblems } from "@qcs/types";
import { ApiError } from "@/server/supabase";
import { runApi } from "@/server/business/http";
import { bulk } from "@/server/business/core";

/** POST /api/business/v1/deliveries/bulk — up to 100 deliveries; each succeeds or fails on its own (207 if mixed). */
export const POST = (req: Request) => runApi(req, async (ctx, deps, body) => {
  const p = ApiBulkRequest.safeParse(body);
  if (!p.success) throw new ApiError(400, "Send { \"deliveries\": [ … ] } with 1 to 100 items", apiProblems(p.error), "invalid_request");
  const r = await bulk(ctx, p.data.deliveries, deps);
  return { status: r.failed === 0 ? 201 : r.created === 0 ? 400 : 207, body: r, reference: `${r.created} created, ${r.failed} failed` };
}, { idempotent: true });
