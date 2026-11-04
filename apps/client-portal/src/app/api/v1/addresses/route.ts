import { caller, errorResponse } from "@/server/supabase";

/** GET /api/v1/addresses?q=&vendor_id= — the person's (or their business's) saved addresses. */
export async function GET(req: Request) {
  try {
    const me = await caller(req);
    const u = new URL(req.url);
    const q = (u.searchParams.get("q") ?? "").trim();
    const vendorId = u.searchParams.get("vendor_id");
    let query = me.db.from("addresses")
      .select("id, label, contact_name, contact_phone, formatted_address, landmark, ghana_post_gps, google_place_id, lat, lng, created_at")
      .order("created_at", { ascending: false }).limit(20);
    query = vendorId ? query.eq("vendor_id", vendorId) : query.eq("user_id", me.user.id);
    if (q) query = query.or(`formatted_address.ilike.%${q.replace(/[%,()]/g, "")}%,contact_name.ilike.%${q.replace(/[%,()]/g, "")}%,contact_phone.ilike.%${q.replace(/[%,()]/g, "")}%`);
    const { data, error } = await query;
    if (error) throw error;
    return Response.json({ addresses: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}
