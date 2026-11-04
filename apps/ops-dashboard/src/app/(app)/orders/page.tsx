import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, myCities, pickCity, statusText, when } from "@/lib/ops";
import { CityPicker } from "@/components/run";
import { PlanTrip } from "./plan-trip";

const VIEWS = {
  active: { label: "Active", statuses: ["CONFIRMED","SEARCHING_RIDER","ASSIGNED","RIDER_AT_PICKUP","PICKED_UP","IN_TRANSIT","AT_HUB","DEPARTED_HUB","ARRIVED_DEST_HUB","READY_FOR_COLLECTION","OUT_FOR_DELIVERY","ARRIVED_AT_DROPOFF"] },
  unassigned: { label: "No rider", statuses: ["CONFIRMED","SEARCHING_RIDER"] },
  unplanned: { label: "Needs a trip", statuses: ["CONFIRMED"] },
  failed: { label: "Failed / returning", statuses: ["FAILED_ATTEMPT","RESCHEDULED","RETURNING_TO_SENDER"] },
  done: { label: "Delivered", statuses: ["DELIVERED","COLLECTED"] },
  closed: { label: "Cancelled / returned / claims", statuses: ["CANCELLED","RETURNED","LOST","DAMAGED"] },
  all: { label: "All", statuses: [] as string[] },
} as const;
type View = keyof typeof VIEWS;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Every parcel, filterable by city, stage, service, date and search (tracking no., phone, name, vendor ref). */
export default async function OrderBoard({ searchParams }: PageProps<"/orders">) {
  const me = await requireRole(["super_admin", "city_admin", "dispatcher", "support", "analyst", "hub_manager", "finance"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const view = (one(sp.view) in VIEWS ? one(sp.view) : "active") as View;
  const service = one(sp.service);
  const q = one(sp.q).replace(/[^\w\s+@.-]/g, "").trim();
  const day = one(sp.day);
  const page = Math.max(0, Number(one(sp.page)) || 0);

  let query = sb.from("orders").select("id, tracking_number, status, service_type, created_at, recipient_name, recipient_phone, dropoff_address_text, quoted_fee, cod_amount, trip_id, rider_id, external_ref, address_confirmation, pickup_contact_name, vendors(business_name), riders(profiles!riders_id_fkey(full_name))", { count: "exact" })
    .neq("status", "DRAFT").order("created_at", { ascending: false }).range(page * 100, page * 100 + 99);
  if (city) query = query.eq("city_id", city.id);
  if (VIEWS[view].statuses.length) query = query.in("status", VIEWS[view].statuses as unknown as string[]);
  if (view === "unassigned") query = query.is("rider_id", null);
  if (view === "unplanned") query = query.is("trip_id", null).eq("service_type", "ecommerce");
  if (service) query = query.eq("service_type", service);
  if (q) query = query.or(`tracking_number.ilike.%${q}%,recipient_phone.ilike.%${q}%,recipient_name.ilike.%${q}%,external_ref.ilike.%${q}%`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const from = new Date(`${day}T00:00:00Z`); // Accra is UTC+0 all year
    query = query.gte("created_at", from.toISOString()).lt("created_at", new Date(from.getTime() + 86_400_000).toISOString());
  }
  const { data: orders, count, error } = await query;
  const link = (p: Record<string, string>) => "/orders?" + new URLSearchParams({ ...(city ? { city: city.id } : {}), view, ...(service ? { service } : {}), ...(q ? { q } : {}), ...(day ? { day } : {}), ...p }).toString();

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Orders</h1>
        <CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
      </div>
      <div className="tabs" style={{ flexWrap: "wrap", margin: "12px 0" }}>
        {(Object.keys(VIEWS) as View[]).map((v) => <a key={v} href={link({ view: v, page: "0" })} className={`btn small ${v === view ? "" : "secondary"}`}>{VIEWS[v].label}</a>)}
      </div>
      <form className="row" style={{ marginBottom: 12, alignItems: "end" }}>
        {city && <input type="hidden" name="city" value={city.id} />}
        <input type="hidden" name="view" value={view} />
        <div><label>Search</label><input name="q" defaultValue={q} placeholder="Tracking no., phone, name, vendor ref" /></div>
        <div><label>Service</label><select name="service" defaultValue={service}><option value="">All</option><option value="express">Express</option><option value="ecommerce">E-commerce</option><option value="intercity">Inter-city</option></select></div>
        <div><label>Booked on</label><input type="date" name="day" defaultValue={day} /></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn">Filter</button></div>
      </form>
      {error && <p className="error">{error.message}</p>}
      <p className="muted">{count ?? 0} order{count === 1 ? "" : "s"}{view === "unplanned" ? " — tick parcels from the same pickup and press “Make a trip” to send them to riders." : ""}</p>
      {view === "unplanned"
        ? <PlanTrip orders={(orders ?? []).map((o) => ({ id: o.id, tracking_number: o.tracking_number, who: one2(o.vendors)?.business_name ?? o.pickup_contact_name ?? "", to: `${o.recipient_name} · ${o.dropoff_address_text ?? ""}`, created_at: o.created_at }))} />
        : <table>
            <thead><tr><th>Booked</th><th>Tracking no.</th><th>From</th><th>To</th><th>Status</th><th>Rider</th><th>Fee / COD</th></tr></thead>
            <tbody>
              {(orders ?? []).map((o) => (
                <tr key={o.id}>
                  <td>{when(o.created_at)}</td>
                  <td><Link href={`/orders/${o.tracking_number}`}><strong>{o.tracking_number}</strong></Link><br /><span className="muted">{o.service_type}{o.external_ref ? ` · ref ${o.external_ref}` : ""}</span></td>
                  <td>{one2(o.vendors)?.business_name ?? o.pickup_contact_name}</td>
                  <td>{o.recipient_name} · {o.recipient_phone}<br /><span className="muted">{o.dropoff_address_text}</span>{o.address_confirmation === "unconfirmed" && <span className="tag">address not confirmed</span>}</td>
                  <td>{statusText(o.status)}{o.trip_id && <><br /><Link href={`/trips/${o.trip_id}`} className="muted">trip</Link></>}</td>
                  <td>{one2(one2(o.riders)?.profiles)?.full_name ?? <span className="muted">—</span>}</td>
                  <td>{ghs(o.quoted_fee)}{o.cod_amount ? <><br /><span className="muted">COD {ghs(o.cod_amount)}</span></> : null}</td>
                </tr>
              ))}
              {!orders?.length && <tr><td colSpan={7} className="muted">No orders match.</td></tr>}
            </tbody>
          </table>}
      <p style={{ display: "flex", gap: 8 }}>
        {page > 0 && <a className="btn small secondary" href={link({ page: String(page - 1) })}>← Newer</a>}
        {(count ?? 0) > (page + 1) * 100 && <a className="btn small secondary" href={link({ page: String(page + 1) })}>Older →</a>}
      </p>
    </>
  );
}
function one2<T>(x: T | T[] | null | undefined): T | null { return Array.isArray(x) ? x[0] ?? null : x ?? null; }
