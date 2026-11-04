import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, myCities, pickCity } from "@/lib/ops";
import { CityPicker } from "@/components/run";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const first = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? x[0] ?? null : x ?? null);

/** All riders: status, online, rating, acceptance, cash held, documents expiring within 30 days. */
export default async function Riders({ searchParams }: PageProps<"/riders">) {
  const me = await requireRole(["super_admin", "city_admin", "dispatcher", "analyst", "finance"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const status = one(sp.status) || "active";
  const q = one(sp.q).replace(/[^\w\s+]/g, "").trim();
  let query = sb.from("riders").select("id, rider_type, status, is_online, rating, score, offers_received, offers_accepted, cod_float_balance, cod_float_limit, cod_blocked, city_id, profiles!riders_id_fkey!inner(full_name, phone), vehicles!riders_vehicle_id_fkey(type, plate_number), rider_documents(doc_type, expires_on, status)")
    .order("created_at", { ascending: false }).limit(300);
  if (city) query = query.eq("city_id", city.id);
  if (status !== "all") query = query.eq("status", status);
  if (q) query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`, { referencedTable: "profiles" });
  const { data: riders, error } = await query;
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const expiring = (r: { rider_documents: { expires_on: string | null; status: string; doc_type: string }[] }) =>
    r.rider_documents.filter((d) => d.status !== "rejected" && d.expires_on && d.expires_on <= soon);
  const list = (riders ?? []).sort((a, b) => expiring(b).length - expiring(a).length);
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Riders</h1>
        <div style={{ display: "flex", gap: 8 }}><Link className="btn small secondary" href="/riders/applications">Applications</Link><CityPicker cities={cities} value={city?.id ?? null} allowAll={global} /></div>
      </div>
      <form className="row" style={{ margin: "12px 0", alignItems: "end" }}>
        {city && <input type="hidden" name="city" value={city.id} />}
        <div><label>Search</label><input name="q" defaultValue={q} placeholder="Name or phone" /></div>
        <div><label>Status</label><select name="status" defaultValue={status}>
          {["active", "suspended", "applicant", "offboarded", "all"].map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn">Filter</button></div>
      </form>
      {error && <p className="error">{error.message}</p>}
      <table>
        <thead><tr><th>Rider</th><th>Type / vehicle</th><th>Now</th><th>Rating</th><th>Accepts</th><th>Cash held</th><th>Documents</th></tr></thead>
        <tbody>
          {list.map((r) => {
            const p = first(r.profiles), v = first(r.vehicles), exp = expiring(r);
            return (
              <tr key={r.id}>
                <td><Link href={`/riders/${r.id}`}><strong>{p?.full_name || "(no name yet)"}</strong></Link><br /><span className="muted">{p?.phone}</span></td>
                <td>{r.rider_type === "fleet" ? "QCS fleet" : "Independent"}<br /><span className="muted">{v?.type} {v?.plate_number}</span></td>
                <td>{r.status !== "active" ? <span className="tag">{r.status}</span> : r.is_online ? "online" : <span className="muted">offline</span>}</td>
                <td>★ {Number(r.rating).toFixed(1)}<br /><span className="muted">score {r.score}</span></td>
                <td>{r.offers_received ? `${Math.round((100 * r.offers_accepted) / r.offers_received)}%` : "—"}<br /><span className="muted">{r.offers_accepted}/{r.offers_received}</span></td>
                <td>{ghs(r.cod_float_balance)}{r.cod_blocked && <><br /><span className="tag">blocked</span></>}<br /><span className="muted">limit {r.cod_float_limit ? ghs(r.cod_float_limit) : "none"}</span></td>
                <td>{exp.length ? exp.map((d) => <span key={d.doc_type} className="tag" style={d.expires_on! < today ? { background: "#fdecea", color: "#c0392b" } : undefined}>
                  {d.doc_type.replaceAll("_", " ")} {d.expires_on! < today ? "expired" : `expires ${d.expires_on}`}</span>) : <span className="muted">ok</span>}</td>
              </tr>
            );
          })}
          {!list.length && <tr><td colSpan={7} className="muted">No riders match.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
