import { labelsPdf, type LabelOrder, type LabelSize } from "@/server/labels";
import { ApiError, caller, errorResponse } from "@/server/supabase";

/** GET /api/v1/labels?orders=id1,id2&size=a6|4x6 — printable QR labels (only for orders you can see). */
export async function GET(req: Request) {
  try {
    const me = await caller(req);
    const u = new URL(req.url);
    const ids = (u.searchParams.get("orders") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const size = (u.searchParams.get("size") === "4x6" ? "4x6" : "a6") as LabelSize;
    if (!ids.length) throw new ApiError(400, "Choose at least one order");
    const { data, error } = await me.db.from("orders")
      .select(`id, tracking_number, service_type, recipient_name, recipient_phone, dropoff_address_text, dropoff_landmark, dropoff_ghana_post_gps,
               pickup_contact_name, pickup_contact_phone, weight_g, package_size, is_fragile, cod_amount, payer, created_at, delivery_instructions,
               external_ref, trip_id, zone:zones!orders_dropoff_zone_id_fkey(name), city:cities(name), vendor:vendors(business_name)`)
      .in("id", ids);
    if (error) throw error;
    if (!data?.length) throw new ApiError(404, "No orders found");
    const tripSizes = new Map<string, number>();
    data.forEach((o) => o.trip_id && tripSizes.set(o.trip_id, (tripSizes.get(o.trip_id) ?? 0) + 1));
    const tripIndex = new Map<string, number>();
    const ordered = ids.map((id) => data.find((o) => o.id === id)).filter(Boolean) as typeof data;
    const labels: LabelOrder[] = ordered.map((o) => {
      const n = o.trip_id ? (tripIndex.get(o.trip_id) ?? 0) + 1 : null;
      if (o.trip_id) tripIndex.set(o.trip_id, n!);
      const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] : x) ?? null;
      return {
        ...o,
        zone_name: one(o.zone as unknown as { name: string } | null)?.name ?? null,
        city_name: one(o.city as unknown as { name: string } | null)?.name ?? null,
        sender_name: one(o.vendor as unknown as { business_name: string } | null)?.business_name ?? o.pickup_contact_name,
        sender_phone: o.pickup_contact_phone,
        stop_no: n, stop_count: o.trip_id ? tripSizes.get(o.trip_id) ?? null : null,
      };
    });
    const pdf = await labelsPdf(labels, size);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="qcs-labels-${size}-${labels.length}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
