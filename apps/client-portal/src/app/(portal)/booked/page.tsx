import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs } from "@/components/api";
import { PayButton } from "@/components/pay-button";

const STATUS: Record<string, string> = { PENDING_PAYMENT: "Waiting for payment", CONFIRMED: "Booked — finding a rider", DRAFT: "Draft" };

export default async function Booked({ searchParams }: PageProps<"/booked">) {
  const sp = await searchParams;
  const ids = String(sp.orders ?? "").split(",").filter(Boolean);
  const sb = await supabaseServer();
  const { data: orders } = ids.length
    ? await sb.from("orders").select("id, tracking_number, recipient_name, dropoff_address_text, quoted_fee, insurance_premium, cod_amount, status, pickup_date").in("id", ids)
    : { data: [] };
  const list = ids.map((id) => orders?.find((o) => o.id === id)).filter(Boolean) as NonNullable<typeof orders>;
  const all = list.map((o) => o.id).join(",");
  return (
    <>
      <h1>Booked ✓</h1>
      {list.some((o) => o.status === "PENDING_PAYMENT") && (
        <div className="card">
          <strong>Payment needed</strong>
          <p className="muted">These orders start once Hubtel confirms your payment (MoMo or card). Unpaid orders are cancelled after an hour.</p>
          <PayButton orderIds={list.filter((o) => o.status === "PENDING_PAYMENT").map((o) => o.id)}
            label={`Pay ${ghs(list.filter((o) => o.status === "PENDING_PAYMENT").reduce((t, o) => t + o.quoted_fee + o.insurance_premium, 0))} now`} />
        </div>
      )}
      <div className="card">
        <strong>Print labels</strong>
        <p className="muted">Stick one label on each parcel. The QR code is scanned at pickup, at the hub and at delivery.</p>
        <div className="row">
          <a className="btn" href={`/api/v1/labels?orders=${all}&size=a6`} target="_blank" rel="noreferrer">A6 labels (office printer)</a>
          <a className="btn secondary" href={`/api/v1/labels?orders=${all}&size=4x6`} target="_blank" rel="noreferrer">4×6 labels (thermal printer)</a>
        </div>
      </div>
      <table>
        <thead><tr><th>Tracking no.</th><th>Recipient</th><th>Fee</th><th>COD</th><th>Status</th><th>QR</th></tr></thead>
        <tbody>
          {list.map((o) => (
            <tr key={o.id}>
              <td><strong>{o.tracking_number}</strong></td>
              <td>{o.recipient_name}<br /><span className="muted">{o.dropoff_address_text}</span></td>
              <td>{ghs(o.quoted_fee + o.insurance_premium)}{o.insurance_premium ? <><br /><span className="tag">Insured</span></> : null}</td>
              <td>{o.cod_amount ? ghs(o.cod_amount) : "—"}</td>
              <td>{STATUS[o.status] ?? o.status}{o.pickup_date ? <><br /><span className="muted">Pickup {o.pickup_date}</span></> : null}</td>
              <td><img src={`/api/v1/qr/${o.tracking_number}.png`} alt={`QR for ${o.tracking_number}`} width={64} height={64} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: 16 }}><Link href="/book">Book another</Link> · <Link href="/orders">All orders</Link></p>
    </>
  );
}
