import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { myCities, pickCity, when } from "@/lib/ops";
import { AutoRefresh } from "../dispatch/forms";
import { CityPicker } from "@/components/run";

const KINDS = {
  unassigned: { label: "No rider too long", hint: "Assign by hand, or make a trip for loose parcels." },
  late: { label: "Late", hint: "Past the promised time for its service." },
  failed: { label: "Failed attempts", hint: "Call the recipient: reschedule or return to sender." },
  unconfirmed_address: { label: "Address not confirmed", hint: "Call the recipient, or send anyway." },
  cod_over_limit: { label: "Cash over limit / not remitted", hint: "Rider gets no cash jobs until they remit." },
  no_signal: { label: "Rider no signal", hint: "Call the rider." },
} as const;
type Kind = keyof typeof KINDS;
interface Ex { kind: Kind; order_id?: string; trip_id?: string; rider_id?: string; tracking_number?: string; service_type?: string; since: string; detail: string }

/** Everything that needs a person, in one list. Limits (minutes, hours) are in Settings, per city. */
export default async function Exceptions({ searchParams }: PageProps<"/exceptions">) {
  const me = await requireRole(["super_admin", "city_admin", "dispatcher", "support", "analyst"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const { data, error } = await sb.rpc("ops_exceptions", { p_city: city?.id ?? null });
  const rows = ((data ?? []) as Ex[]).sort((a, b) => (a.since < b.since ? -1 : 1));
  const want = (Array.isArray(sp.kind) ? sp.kind[0] : sp.kind) as Kind | undefined;
  const shown = want && want in KINDS ? rows.filter((r) => r.kind === want) : rows;
  const base = city ? `?city=${city.id}&` : "?";
  return (
    <>
      <AutoRefresh />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Exceptions ({rows.length})</h1>
        <CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
      </div>
      {error && <p className="error">{error.message}</p>}
      <div className="tabs" style={{ flexWrap: "wrap", margin: "12px 0" }}>
        <a href={`/exceptions${base}`} className={`btn small ${want ? "secondary" : ""}`}>All ({rows.length})</a>
        {(Object.keys(KINDS) as Kind[]).map((k) => {
          const n = rows.filter((r) => r.kind === k).length;
          return <a key={k} href={`/exceptions${base}kind=${k}`} className={`btn small ${want === k ? "" : "secondary"}`}>{KINDS[k].label} ({n})</a>;
        })}
      </div>
      {want && <p className="muted">{KINDS[want]?.hint}</p>}
      <table>
        <thead><tr><th>Since</th><th>Problem</th><th>Parcel / rider</th><th>Details</th><th></th></tr></thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className={r.kind === "late" || r.kind === "no_signal" ? "bad" : undefined}>
              <td>{when(r.since)}</td>
              <td><span className="tag">{KINDS[r.kind]?.label ?? r.kind}</span></td>
              <td>{r.tracking_number ? <Link href={`/orders/${r.tracking_number}`}>{r.tracking_number}</Link> : null}{r.service_type ? <span className="muted"> · {r.service_type}</span> : null}
                {r.rider_id && <><br /><Link href={`/riders/${r.rider_id}`}>rider</Link></>}</td>
              <td>{r.detail}</td>
              <td>{r.trip_id ? <Link className="btn small secondary" href={`/trips/${r.trip_id}`}>Open trip</Link>
                : r.kind === "unassigned" ? <Link className="btn small secondary" href={`/orders?view=unplanned${city ? `&city=${city.id}` : ""}`}>Make a trip</Link> : null}</td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={5} className="muted">Nothing here. 👍</td></tr>}
        </tbody>
      </table>
    </>
  );
}
