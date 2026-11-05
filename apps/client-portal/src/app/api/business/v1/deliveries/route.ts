import { ApiError } from "@/server/supabase";
import { runApi } from "@/server/business/http";
import { create } from "@/server/business/core";

/** POST /api/business/v1/deliveries — book one delivery (send an Idempotency-Key so a retry never books twice). */
export const POST = (req: Request) => runApi(req, async (ctx, deps, body) => {
  const d = await create(ctx, body, deps);
  return { status: 201, body: d, reference: String(d.tracking_number ?? "") };
}, { idempotent: true });

const ts = (v: string | null, name: string) => {
  if (!v) return null;
  if (Number.isNaN(Date.parse(v))) throw new ApiError(400, `${name} must be a date/time, e.g. 2026-11-01T00:00:00Z`, undefined, "invalid_request");
  return new Date(v).toISOString();
};

/** GET /api/business/v1/deliveries?status=&from=&to=&reference=&limit=&before= — newest first. */
export const GET = (req: Request) => runApi(req, async (ctx, _deps, _body, db) => {
  const u = new URL(req.url).searchParams;
  const limit = Math.min(100, Math.max(1, Number(u.get("limit") ?? 50) || 50));
  const status = u.get("status")?.replace(/[^A-Za-z_,]/g, "") || null;
  const { data, error } = ctx.mode === "test"
    ? await db.rpc("api_test_list", { p_vendor: ctx.vendorId, p_status: status, p_reference: u.get("reference"), p_limit: limit, p_before: ts(u.get("before"), "before") })
    : await db.rpc("api_list_deliveries", { p_vendor: ctx.vendorId, p_status: status, p_from: ts(u.get("from"), "from"), p_to: ts(u.get("to"), "to"),
        p_reference: u.get("reference"), p_limit: limit, p_before: ts(u.get("before"), "before") });
  if (error) throw new ApiError(400, error.message, undefined, "invalid_request");
  return { status: 200, body: data };
});
