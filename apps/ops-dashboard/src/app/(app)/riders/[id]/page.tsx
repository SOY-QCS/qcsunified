import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, has, statusText, when } from "@/lib/ops";
import { RpcButton } from "@/components/run";
import { Adjustment, DocReview, MoneyForm } from "./forms";

const first = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? x[0] ?? null : x ?? null);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function RiderPage({ params, searchParams }: PageProps<"/riders/[id]">) {
  const me = await requireRole(["super_admin", "city_admin", "dispatcher", "analyst", "finance"]);
  const { id } = await params;
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { data: r } = await sb.from("riders").select("*, profiles!riders_id_fkey(full_name, phone, email), vehicles!riders_vehicle_id_fkey(type, plate_number, make_model), cities(name)").eq("id", id).maybeSingle();
  if (!r) notFound();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.to)) ? one(sp.to) : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.from)) ? one(sp.from) : new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const [{ data: stats }, { data: docs }, { data: ratings }, { data: trips }, { data: earnings }, { data: wallet }] = await Promise.all([
    sb.rpc("rider_stats", { p_rider: id, p_from: from, p_to: to }),
    sb.from("rider_documents").select("id, doc_type, storage_path, number, expires_on, status, review_note").eq("rider_id", id).order("created_at"),
    sb.from("ratings").select("score, tags, comment, created_at, orders(tracking_number)").eq("rider_id", id).eq("kind", "client").order("created_at", { ascending: false }).limit(10),
    sb.from("trips").select("id, trip_type, status, started_at, completed_at, orders(count)").eq("rider_id", id).order("created_at", { ascending: false }).limit(10),
    sb.from("rider_earnings").select("kind, amount, description, created_at").eq("rider_id", id).order("created_at", { ascending: false }).limit(15),
    sb.from("wallets").select("balance").eq("owner_type", "rider").eq("owner_id", id).maybeSingle(),
  ]);
  const paths = (docs ?? []).map((d) => d.storage_path);
  const { data: signed } = paths.length ? await sb.storage.from("kyc").createSignedUrls(paths, 600) : { data: [] };
  const p = first(r.profiles), v = first(r.vehicles);
  const isAdmin = has(me, "super_admin", "city_admin");
  const s = (stats ?? {}) as Record<string, number | string | null>;
  return (
    <>
      <p><Link href="/riders">← Riders</Link></p>
      <h1>{p?.full_name} <span className="tag">{r.status}</span> {r.is_online && <span className="tag">online</span>}</h1>
      <p>{p?.phone} · {r.rider_type === "fleet" ? "QCS fleet" : "Independent"} · {v?.make_model ?? v?.type} {v?.plate_number} · {first(r.cities)?.name}</p>

      <form className="row" style={{ alignItems: "end" }}>
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn secondary">Show</button></div>
      </form>
      <div className="row" style={{ marginTop: 12 }}>
        {[["Rating", `★ ${Number(s.rating ?? 0).toFixed(1)} (${s.ratings_count ?? 0})`], ["Acceptance", s.acceptance_rate != null ? `${s.acceptance_rate}%` : "—"], ["Score", s.score],
          ["Delivered", s.delivered], ["Failed", s.failed], ["Trips", s.trips], ["Express on time", s.express_on_time],
          ["Earned (from the ledger)", ghs(Number(s.earned ?? 0))], ["Unpaid balance", ghs(wallet?.balance ?? 0)], ["Cash held", ghs(Number(s.cod_held ?? 0))]].map(([k, val]) => (
          <div key={String(k)} className="card" style={{ padding: 12 }}><div className="muted">{k}</div><div style={{ fontSize: 20, fontWeight: 800 }}>{val ?? "—"}</div></div>
        ))}
      </div>
      <p className="muted">Paid as {s.pay_basis === "fleet" ? "QCS fleet: pickup fee per trip + fee per delivered stop" : "independent: commission on each delivery fee"} (Settings → rider pay). The unpaid balance goes out in the next weekly payout batch.</p>

      {isAdmin && (
        <div className="card">
          <strong>Account</strong>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
            {r.status === "active" && <RpcButton fn="set_rider_status" args={{ p_rider: id, p_status: "suspended" }} reason="p_reason" done="Suspended and taken offline." label="Suspend" kind="danger" />}
            {r.status === "suspended" && <RpcButton fn="set_rider_status" args={{ p_rider: id, p_status: "active" }} reason="p_reason" done="Active again." label="Reactivate" />}
            {r.status !== "offboarded" && r.status !== "applicant" && <RpcButton fn="set_rider_status" args={{ p_rider: id, p_status: "offboarded" }} reason="p_reason" done="Offboarded." label="Offboard" kind="secondary" confirm="Offboard this rider for good?" />}
          </div>
        </div>
      )}
      {(isAdmin || has(me, "finance")) && <MoneyForm rider={id} commission={r.commission_rate_bp} limit={r.cod_float_limit} fleet={r.rider_type === "fleet"} />}

      {has(me, "super_admin", "finance") && <Adjustment rider={id} />}
      <h2>Latest earnings</h2>
      <table><tbody>{(earnings ?? []).map((x, i) => <tr key={i}><td>{when(x.created_at)}</td><td>{x.kind}</td><td>{x.description}</td><td style={{ color: x.amount < 0 ? "var(--danger)" : undefined }}>{ghs(x.amount)}</td></tr>)}
        {!earnings?.length && <tr><td className="muted">Nothing earned yet.</td></tr>}</tbody></table>

      <h2>Documents</h2>
      <table>
        <thead><tr><th>Document</th><th>Number</th><th>Expires</th><th>Status</th>{isAdmin && <th>Review</th>}</tr></thead>
        <tbody>{(docs ?? []).map((d, i) => (
          <tr key={d.id}>
            <td>{signed?.[i]?.signedUrl ? <a href={signed[i]!.signedUrl} target="_blank" rel="noreferrer">{d.doc_type.replaceAll("_", " ")}</a> : d.doc_type}</td>
            <td>{d.number ?? "—"}</td><td>{d.expires_on ?? "—"}</td><td>{d.status}{d.review_note ? <><br /><span className="muted">{d.review_note}</span></> : null}</td>
            {isAdmin && <td><DocReview doc={d.id} expires={d.expires_on} /></td>}
          </tr>))}
          {!docs?.length && <tr><td colSpan={5} className="muted">No documents.</td></tr>}
        </tbody>
      </table>

      <h2>Recent ratings</h2>
      <table><tbody>{(ratings ?? []).map((x, i) => <tr key={i}><td>{when(x.created_at)}</td><td>{"★".repeat(x.score)}</td><td>{x.tags.join(", ")}</td><td>{x.comment}</td><td>{first(x.orders)?.tracking_number}</td></tr>)}
        {!ratings?.length && <tr><td className="muted">No ratings yet.</td></tr>}</tbody></table>

      <h2>Recent trips</h2>
      <table><tbody>{(trips ?? []).map((t) => <tr key={t.id}><td><Link href={`/trips/${t.id}`}>{t.trip_type}</Link></td><td>{statusText(t.status)}</td>
        <td>{(t.orders as unknown as { count: number }[])[0]?.count ?? 0} parcel(s)</td><td>{when(t.started_at)}</td><td>{when(t.completed_at)}</td></tr>)}</tbody></table>
    </>
  );
}
