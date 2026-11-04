import { z } from "zod";
import { ApiError, caller, errorResponse } from "@/server/supabase";

const Body = z.object({
  order_id: z.string().uuid().optional(), tracking_number: z.string().max(40).optional(),
  score: z.number().int().min(1).max(5), tags: z.array(z.string().max(40)).max(8).default([]), comment: z.string().max(1000).optional(),
}).refine((b) => b.order_id || b.tracking_number, "order_id or tracking_number is needed");

/** POST /api/v1/ratings — the sender rates the rider after delivery (by order id or tracking number). */
export async function POST(req: Request) {
  try {
    const me = await caller(req);
    const b = Body.safeParse(await req.json());
    if (!b.success) throw new ApiError(400, "Choose 1 to 5 stars");
    let id = b.data.order_id;
    if (!id) {
      const { data } = await me.db.from("orders").select("id").eq("tracking_number", b.data.tracking_number!).maybeSingle();
      if (!data) throw new ApiError(404, "Order not found");
      id = data.id;
    }
    const { error } = await me.db.rpc("rate_rider", { p_order: id, p_score: b.data.score, p_tags: b.data.tags, p_comment: b.data.comment ?? null });
    if (error) throw new ApiError(400, error.message);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
