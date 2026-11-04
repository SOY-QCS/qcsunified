import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, statusText, when } from "@/lib/ops";

/** Everything about one parcel: who, where, money, proof of delivery and its full history. */
export default async function OrderDetail({ params }: PageProps<"/orders/[tn]">) {
  await requireRole(["super_admin", "city_admin", "dispatcher", "support", "analyst", "hub_manager", "finance"]);
  const { tn } = await params;
  const sb = await supabaseServer();
  const { data: o } = await sb.from("orders").select("*, vendors(id, business_name), riders(id, profiles!riders_id_fkey(full_name, phone))").eq("tracking_number", decodeURIComponent(tn)).maybeSingle();
  if (!o) notFound();
  const [{ data: events }, { data: notes }] = await Promise.all([
    sb.from("order_events").select("id, from_status, to_status, created_at, occurred_at, note, reason, photo_path, actor:profiles(full_name)").eq("order_id", o.id).order("id"),
    sb.from("notifications").select("template, channel, status, created_at").eq("order_id", o.id).order("created_at", { ascending: false }).limit(20),
  ]);
  const pod = await Promise.all([o.pod_signature_path, o.pod_photo_path].map(async (p: string | null) => (p ? (await sb.storage.from("pod").createSignedUrl(p, 600)).data?.signedUrl ?? null : null)));
  const vendor = Array.isArray(o.vendors) ? o.vendors[0] : o.vendors;
  const rider = Array.isArray(o.riders) ? o.riders[0] : o.riders;
  const rp = rider ? (Array.isArray(rider.profiles) ? rider.profiles[0] : rider.profiles) : null;
  return (
    <>
      <p><Link href="/orders">← Orders</Link></p>
      <h1>{o.tracking_number} <span className="tag">{statusText(o.status)}</span></h1>
      <div className="row">
        <div className="card">
          <strong>From</strong><p>{vendor ? <Link href={`/vendors/${vendor.id}`}>{vendor.business_name}</Link> : o.pickup_contact_name} · {o.pickup_contact_phone}<br /><span className="muted">{o.pickup_address_text}</span></p>
          <strong>To</strong><p>{o.recipient_name} · <a href={`tel:${o.recipient_phone}`}>{o.recipient_phone}</a><br /><span className="muted">{o.dropoff_address_text}{o.dropoff_landmark ? ` (${o.dropoff_landmark})` : ""}{o.dropoff_ghana_post_gps ? ` · ${o.dropoff_ghana_post_gps}` : ""}</span>
            <br /><span className="muted">Address: {o.address_confirmation}</span></p>
          {o.delivery_instructions && <p className="muted">Note: {o.delivery_instructions}</p>}
        </div>
        <div className="card">
          <strong>Parcel</strong><p>{o.service_type} · {(o.weight_g / 1000).toFixed(1)} kg{o.is_fragile ? " · fragile" : ""}{o.is_high_value ? " · high value" : ""}{o.is_insured ? " · insured" : ""}</p>
          <strong>Money</strong><p>Fee {ghs(o.quoted_fee)}{o.extra_fee ? ` + extra ${ghs(o.extra_fee)}` : ""}{o.insurance_premium ? ` + insurance ${ghs(o.insurance_premium)}` : ""}<br />
            Paid by {o.payer} ({o.payment_method}) · {o.payment_status}{o.cod_amount ? <><br />Cash on delivery: {ghs(o.cod_amount)}</> : null}</p>
          <strong>Rider</strong><p>{rider ? <><Link href={`/riders/${rider.id}`}>{rp?.full_name}</Link> · {rp?.phone}</> : "—"}{o.trip_id && <> · <Link href={`/trips/${o.trip_id}`}>trip</Link></>}</p>
        </div>
      </div>
      {(pod[0] || pod[1] || o.pod_method) && (
        <div className="card">
          <strong>Proof of delivery</strong> <span className="muted">({o.pod_method ?? "—"}{o.pod_flagged ? ` · flagged: ${o.pod_flagged}` : ""})</span>
          <div className="docs" style={{ marginTop: 8 }}>
            {pod[0] && <a href={pod[0]} target="_blank" rel="noreferrer">Signature</a>}
            {pod[1] && <a href={pod[1]} target="_blank" rel="noreferrer"><img src={pod[1]} alt="Delivery photo" /></a>}
          </div>
        </div>
      )}
      <h2>History</h2>
      <table>
        <thead><tr><th>When</th><th>Change</th><th>By</th><th>Note</th></tr></thead>
        <tbody>{(events ?? []).map((e) => {
          const actor = Array.isArray(e.actor) ? e.actor[0] : e.actor;
          return <tr key={e.id}><td>{when(e.occurred_at ?? e.created_at)}{e.occurred_at && Math.abs(new Date(e.occurred_at).getTime() - new Date(e.created_at).getTime()) > 120_000 ? <><br /><span className="muted">synced {when(e.created_at)}</span></> : null}</td>
            <td>{e.from_status ? `${statusText(e.from_status)} → ` : ""}<strong>{statusText(e.to_status)}</strong></td><td>{actor?.full_name ?? "system"}</td><td>{[e.reason, e.note].filter(Boolean).join(" · ")}</td></tr>;
        })}</tbody>
      </table>
      <h2>Messages sent</h2>
      <table><tbody>{(notes ?? []).map((n, i) => <tr key={i}><td>{when(n.created_at)}</td><td>{n.template}</td><td>{n.channel}</td><td>{n.status}</td></tr>)}</tbody></table>
    </>
  );
}
