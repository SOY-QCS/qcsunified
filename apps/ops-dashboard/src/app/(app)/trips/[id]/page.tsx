import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, statusText, when } from "@/lib/ops";
import { RpcButton } from "@/components/run";
import { TripTools } from "./trip-tools";

/** One trip: its parcels and the dispatcher tools — reassign, take the rider off, split, merge, offer again. */
export default async function TripPage({ params }: PageProps<"/trips/[id]">) {
  const me = await requireRole(["super_admin", "city_admin", "dispatcher", "support", "analyst"]);
  const canAct = has(me, "super_admin", "city_admin", "dispatcher");
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: t } = await sb.from("trips").select("*, riders(id, profiles!riders_id_fkey(full_name, phone))").eq("id", id).maybeSingle();
  if (!t) notFound();
  const [{ data: orders }, { data: riders }, { data: busy }, { data: others }] = await Promise.all([
    sb.from("orders").select("id, tracking_number, status, recipient_name, dropoff_address_text").eq("trip_id", id).order("created_at"),
    sb.from("riders").select("id, score, is_online, profiles!riders_id_fkey(full_name, phone)").eq("city_id", t.city_id).eq("status", "active").limit(500),
    sb.from("trips").select("rider_id").in("status", ["ASSIGNED", "IN_PROGRESS"]),
    sb.from("trips").select("id, trip_type, status, created_at, orders(count)").eq("city_id", t.city_id).in("status", ["PLANNED", "ASSIGNED"]).neq("id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  const busyIds = new Set((busy ?? []).map((b) => b.rider_id));
  const free = (riders ?? []).filter((r) => !busyIds.has(r.id)).map((r) => {
    const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    return { id: r.id, label: `${p?.full_name || "Rider"} · ${p?.phone ?? ""}${r.is_online ? " · online" : " · offline"} · score ${r.score}` };
  }).sort((a, b) => Number(b.label.includes("online")) - Number(a.label.includes("online")));
  const rider = Array.isArray(t.riders) ? t.riders[0] : t.riders;
  const rp = rider ? (Array.isArray(rider.profiles) ? rider.profiles[0] : rider.profiles) : null;
  const finished = ["COMPLETED", "CANCELLED"].includes(t.status);
  return (
    <>
      <p><Link href="/dispatch">← Dispatch</Link></p>
      <h1>{t.trip_type === "express" ? "Express job" : "Trip"} <span className="tag">{statusText(t.status)}</span> <span className="tag">dispatch: {t.dispatch_state}</span></h1>
      <p>Rider: {rider ? <><Link href={`/riders/${rider.id}`}>{rp?.full_name}</Link> · {rp?.phone}</> : "none yet"} · created {when(t.created_at)}{t.escalation_reason ? ` · escalated: ${t.escalation_reason}` : ""}</p>
      {canAct && !finished && (
        <div className="card">
          <TripTools tripId={id} hasRider={!!rider} free={free} orders={(orders ?? []).map((o) => ({ id: o.id, label: `${o.tracking_number} — ${o.recipient_name} (${statusText(o.status)})`, movable: ["CONFIRMED","SEARCHING_RIDER","ASSIGNED"].includes(o.status) }))}
            others={(others ?? []).map((x) => ({ id: x.id, label: `${x.trip_type} · ${statusText(x.status)} · ${(x.orders as unknown as { count: number }[])[0]?.count ?? 0} parcel(s) · ${when(x.created_at)}` }))} />
          {!rider && <div style={{ marginTop: 12 }}><RpcButton fn="start_dispatch" args={{ p_trip: id }} done="Offering to riders again." label="Offer to riders again" kind="secondary" /></div>}
        </div>
      )}
      <h2>Parcels ({orders?.length ?? 0})</h2>
      <table>
        <thead><tr><th>Tracking no.</th><th>Recipient</th><th>Status</th></tr></thead>
        <tbody>{(orders ?? []).map((o) => <tr key={o.id}><td><Link href={`/orders/${o.tracking_number}`}>{o.tracking_number}</Link></td><td>{o.recipient_name}<br /><span className="muted">{o.dropoff_address_text}</span></td><td>{statusText(o.status)}</td></tr>)}</tbody>
      </table>
    </>
  );
}
