import { ghs } from "@/components/api";
import { supabaseServer } from "@/lib/supabase/server";
import { currentVendor } from "../vendor";

export default async function Orders() {
  const { vendor } = await currentVendor();
  const sb = await supabaseServer();
  const { data: orders } = await sb.from("orders")
    .select("id, tracking_number, created_at, recipient_name, dropoff_address_text, quoted_fee, cod_amount, status, external_ref, service_type")
    .eq("vendor_id", vendor.id).order("created_at", { ascending: false }).limit(100);
  return (
    <>
      <h1>Orders</h1>
      <table>
        <thead><tr><th>Date</th><th>Tracking no.</th><th>Your ref</th><th>Recipient</th><th>Fee</th><th>COD</th><th>Status</th><th>Label</th></tr></thead>
        <tbody>
          {(orders ?? []).map((o) => (
            <tr key={o.id}>
              <td>{new Date(o.created_at).toLocaleDateString("en-GB", { timeZone: "Africa/Accra" })}</td>
              <td><strong>{o.tracking_number}</strong><br /><span className="muted">{o.service_type}</span></td>
              <td>{o.external_ref ?? "—"}</td>
              <td>{o.recipient_name}<br /><span className="muted">{o.dropoff_address_text}</span></td>
              <td>{ghs(o.quoted_fee)}</td>
              <td>{o.cod_amount ? ghs(o.cod_amount) : "—"}</td>
              <td>{o.status.replaceAll("_", " ").toLowerCase()}</td>
              <td><a href={`/api/v1/labels?orders=${o.id}&size=a6`} target="_blank" rel="noreferrer">A6</a> · <a href={`/api/v1/labels?orders=${o.id}&size=4x6`} target="_blank" rel="noreferrer">4×6</a></td>
            </tr>
          ))}
          {(orders ?? []).length === 0 && <tr><td colSpan={8} className="muted">No orders yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
