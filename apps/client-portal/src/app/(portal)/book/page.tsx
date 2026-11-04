import { BookingForm, type StockInfo } from "@/components/booking-form";
import { supabaseServer } from "@/lib/supabase/server";
import { currentVendor } from "../vendor";

export default async function BookPage() {
  const { vendor, me, insurance } = await currentVendor();
  // products this vendor has in QCS hubs (only shown if fulfilment is on and there is stock)
  const sb = await supabaseServer();
  const { data } = await sb.from("stock_levels").select("hub_id, sku_id, sku, name, available").eq("vendor_id", vendor.id).gt("available", 0);
  const hubIds = [...new Set((data ?? []).map((r) => r.hub_id))];
  const { data: hubs } = hubIds.length ? await sb.from("hubs").select("id, name").in("id", hubIds) : { data: [] };
  const stock: StockInfo[] = (data ?? []).map((r) => ({ ...r, hub_name: hubs?.find((h) => h.id === r.hub_id)?.name ?? "hub" }));
  return (<><h1>Book a delivery</h1><BookingForm vendor={vendor} me={me} insurance={insurance} stock={stock} /></>);
}
