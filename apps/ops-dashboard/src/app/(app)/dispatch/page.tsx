import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { AutoRefresh, OverrideActions, ReviewForm, TripActions } from "./forms";

const when = (d: string | null) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", dateStyle: "short", timeStyle: "short" }) : "—");
const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? x[0] ?? null : x ?? null);

/**
 * The dispatch board. Shows only the dispatcher's own city (the database enforces this).
 * 1. Jobs no rider took (escalated) and jobs still being offered.
 * 2. Riders asking to deliver without the recipient's code.
 * 3. Deliveries that need a second look (e.g. sent by WhatsApp, no signature).
 */
export default async function Dispatch() {
  await requireRole(["super_admin", "city_admin", "dispatcher", "support"]);
  const sb = await supabaseServer();
  const [{ data: trips }, { data: riders }, { data: overrides }, { data: flagged }] = await Promise.all([
    sb.from("trips").select("id, trip_type, dispatch_state, dispatch_misses, escalated_at, escalation_reason, dispatch_started_at, cod_total, orders(tracking_number)")
      .in("dispatch_state", ["escalated", "queued", "offering"]).order("escalated_at", { ascending: true, nullsFirst: false }).limit(100),
    sb.from("riders").select("id, score, is_online, profiles(full_name, phone)").eq("status", "active").eq("is_online", true).limit(300),
    sb.from("pod_overrides").select("id, reason, photo_path, created_at, orders(tracking_number), riders(profiles(full_name))").eq("status", "pending").order("created_at"),
    sb.from("orders").select("id, tracking_number, pod_flagged, pod_method, delivered_at").not("pod_flagged", "is", null).order("delivered_at").limit(100),
  ]);
  // Riders already on a job can't take another (one-active-job rule), so leave them out of the list.
  const { data: busy } = await sb.from("trips").select("rider_id").in("status", ["ASSIGNED", "IN_PROGRESS"]);
  const busyIds = new Set((busy ?? []).map((b) => b.rider_id));
  const free = (riders ?? []).filter((r) => !busyIds.has(r.id)).map((r) => {
    const p = one(r.profiles);
    return { id: r.id, label: `${p?.full_name || "Rider"} · ${p?.phone ?? ""} · score ${r.score}` };
  });
  const photos = await Promise.all((overrides ?? []).map(async (o) =>
    (await sb.storage.from("pod").createSignedUrl(o.photo_path, 600)).data?.signedUrl ?? null));
  const escalated = (trips ?? []).filter((t) => t.dispatch_state === "escalated");
  const searching = (trips ?? []).filter((t) => t.dispatch_state !== "escalated");

  return (
    <>
      <AutoRefresh />
      <h1>Dispatch</h1>
      <p className="muted">{free.length} free rider{free.length === 1 ? "" : "s"} online · refreshes every 10 seconds</p>

      <h2>Needs a dispatcher ({escalated.length})</h2>
      <p className="muted">No rider accepted these after 5 offers, or nobody was available. Call a rider and assign, or offer again.</p>
      <table>
        <thead><tr><th>Since</th><th>Job</th><th>Why</th><th>Action</th></tr></thead>
        <tbody>
          {escalated.map((t) => (
            <tr key={t.id} className="bad">
              <td>{when(t.escalated_at)}</td>
              <td>{t.trip_type} · {(t.orders as { tracking_number: string }[]).map((o) => o.tracking_number).join(", ")}{t.cod_total ? ` · COD GHS ${(t.cod_total / 100).toFixed(2)}` : ""}</td>
              <td>{t.escalation_reason}</td>
              <td><TripActions trip={t.id} riders={free} /></td>
            </tr>
          ))}
          {escalated.length === 0 && <tr><td colSpan={4} className="muted">Nothing waiting. 👍</td></tr>}
        </tbody>
      </table>

      <h2>Looking for a rider ({searching.length})</h2>
      <table>
        <thead><tr><th>Started</th><th>Job</th><th>Missed offers</th><th>Action</th></tr></thead>
        <tbody>
          {searching.map((t) => (
            <tr key={t.id}>
              <td>{when(t.dispatch_started_at)}</td>
              <td>{t.trip_type} · {(t.orders as { tracking_number: string }[]).map((o) => o.tracking_number).join(", ")}</td>
              <td>{t.dispatch_misses} / 5</td>
              <td><TripActions trip={t.id} riders={free} /></td>
            </tr>
          ))}
          {searching.length === 0 && <tr><td colSpan={4} className="muted">None.</td></tr>}
        </tbody>
      </table>

      <h2>Delivery without code — approve? ({overrides?.length ?? 0})</h2>
      <p className="muted">The rider says the recipient can&apos;t give the 4-digit code. Check the photo and note; call the recipient if unsure.</p>
      <table>
        <thead><tr><th>Asked</th><th>Parcel</th><th>Rider&apos;s note</th><th>Photo</th><th>Decision</th></tr></thead>
        <tbody>
          {(overrides ?? []).map((o, i) => (
            <tr key={o.id}>
              <td>{when(o.created_at)}</td>
              <td>{one(o.orders)?.tracking_number}<br /><span className="muted">{one(one(o.riders)?.profiles)?.full_name}</span></td>
              <td>{o.reason}</td>
              <td>{photos[i] ? <a href={photos[i]!} target="_blank" rel="noreferrer">View photo</a> : <span className="muted">uploading…</span>}</td>
              <td><OverrideActions id={o.id} /></td>
            </tr>
          ))}
          {!overrides?.length && <tr><td colSpan={5} className="muted">None.</td></tr>}
        </tbody>
      </table>

      <h2>Deliveries to check ({flagged?.length ?? 0})</h2>
      <table>
        <thead><tr><th>Delivered</th><th>Parcel</th><th>Why flagged</th><th>Action</th></tr></thead>
        <tbody>
          {(flagged ?? []).map((o) => (
            <tr key={o.id}><td>{when(o.delivered_at)}</td><td>{o.tracking_number}</td><td>{o.pod_flagged}</td><td><ReviewForm order={o.id} /></td></tr>
          ))}
          {!flagged?.length && <tr><td colSpan={4} className="muted">None.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
