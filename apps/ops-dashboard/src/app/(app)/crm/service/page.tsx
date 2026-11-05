import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities, pickCity, statusText, when } from "@/lib/ops";
import { CityPicker } from "@/components/run";
import { CRM_ROLES, CrmTabs, one } from "../tabs";
import { ContactTools } from "./contact-tools";

const OPEN = ["CONFIRMED", "SEARCHING_RIDER", "ASSIGNED", "RIDER_AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_HUB", "DEPARTED_HUB", "ARRIVED_DEST_HUB",
  "READY_FOR_COLLECTION", "OUT_FOR_DELIVERY", "ARRIVED_AT_DROPOFF", "FAILED_ATTEMPT", "RESCHEDULED"];

/**
 * Customer service on behalf of vendors (CLAUDE.md §11): agents see ONLY the orders of vendors who bought the service,
 * call or WhatsApp the vendor's customer from the QCS number ("QCS on behalf of <vendor>"), and log every contact.
 * The vendor sees the log on their order. Fee per delivered order (Settings → cs_fee_per_order).
 */
export default async function Service({ searchParams }: PageProps<"/crm/service">) {
  const me = await requireRole([...CRM_ROLES]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const vendorFilter = typeof sp.vendor === "string" ? sp.vendor : "";
  const { data: vendors } = await sb.from("vendors").select("id, business_name").eq("cs_service_enabled", true).order("business_name");
  const ids = (vendors ?? []).map((v) => v.id).filter((id) => !vendorFilter || id === vendorFilter);
  let q = sb.from("orders").select("id, tracking_number, status, recipient_name, recipient_phone, created_at, cod_amount, vendors(business_name)")
    .in("vendor_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]).in("status", OPEN).order("created_at").limit(150);
  if (city) q = q.eq("city_id", city.id);
  const { data: orders, error } = await q;
  const oids = (orders ?? []).map((o) => o.id);
  const { data: contacts } = oids.length
    ? await sb.from("order_contacts").select("order_id, kind, outcome, note, created_at, profiles(full_name)").in("order_id", oids).order("created_at", { ascending: false })
    : { data: [] as never[] };
  const canAct = has(me, "super_admin", "city_admin", "support");
  return (
    <>
      <h1>Customer service for vendors</h1>
      <CrmTabs at="/crm/service" />
      <form style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
        <select name="vendor" defaultValue={vendorFilter} style={{ maxWidth: 260 }}><option value="">All vendors with the service ({vendors?.length ?? 0})</option>
          {(vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.business_name}</option>)}</select>
        <button className="btn small secondary">Show</button>
      </form>
      {error && <p className="error">{error.message}</p>}
      {!vendors?.length && <p className="muted">No vendor has bought the customer-service service yet (turn it on in Vendors → account controls).</p>}
      <table>
        <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Contacts</th><th></th></tr></thead>
        <tbody>
          {(orders ?? []).map((o) => {
            const log = (contacts ?? []).filter((c) => c.order_id === o.id);
            return (
              <tr key={o.id}>
                <td><Link href={`/orders/${o.tracking_number}`}>{o.tracking_number}</Link><div className="muted">{one(o.vendors)?.business_name} · {when(o.created_at)}</div></td>
                <td>{o.recipient_name}<div><a href={`tel:${o.recipient_phone}`}>{o.recipient_phone}</a></div></td>
                <td>{statusText(o.status)}</td>
                <td style={{ maxWidth: 280 }}>{log.slice(0, 3).map((c, i) => <div key={i} className="muted">{when(c.created_at)} · {c.kind} · {c.outcome.replaceAll("_", " ")}{c.note ? `: ${c.note}` : ""}</div>)}
                  {!log.length && <span className="muted">not contacted</span>}</td>
                <td>{canAct && <ContactTools order={o.id} vendor={one(o.vendors)?.business_name ?? "the vendor"} />}</td>
              </tr>
            );
          })}
          {!!vendors?.length && !orders?.length && <tr><td colSpan={5} className="muted">No open orders for these vendors.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
