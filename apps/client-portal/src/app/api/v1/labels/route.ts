import { labelsPdf, loadLabelOrders, pdfResponse, type LabelSize } from "@qcs/api-client/labels";
import { ApiError, caller, errorResponse } from "@/server/supabase";

/** GET /api/v1/labels?orders=id1,id2&size=a6|4x6 — printable QR labels (only for orders you can see). */
export async function GET(req: Request) {
  try {
    const me = await caller(req);
    const u = new URL(req.url);
    const ids = (u.searchParams.get("orders") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const size = (u.searchParams.get("size") === "4x6" ? "4x6" : "a6") as LabelSize;
    if (!ids.length) throw new ApiError(400, "Choose at least one order");
    const labels = await loadLabelOrders(me.db, ids);
    if (!labels.length) throw new ApiError(404, "No orders found");
    return pdfResponse(await labelsPdf(labels, size), `qcs-labels-${size}-${labels.length}.pdf`);
  } catch (e) {
    return errorResponse(e);
  }
}
