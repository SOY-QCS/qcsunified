import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities, pickCity, when } from "@/lib/ops";
import { CityPicker, RpcButton } from "@/components/run";
import { CRM_ROLES, CrmTabs, one } from "../tabs";

/** Churn alerts: checked every morning. A vendor is flagged when this week is 30%+ below their 4-week average. */
export default async function Alerts({ searchParams }: PageProps<"/crm/alerts">) {
  const me = await requireRole([...CRM_ROLES]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const done = sp.done === "1";
  let q = sb.from("crm_alerts").select("id, week_start, this_week, weekly_avg, drop_percent, status, handled_note, handled_at, created_at, vendors(id, business_name, contact_phone, account_manager_id), handler:profiles!crm_alerts_handled_by_fkey(full_name)")
    .eq("status", done ? "done" : "open").order("created_at", { ascending: false }).limit(200);
  if (city) q = q.eq("city_id", city.id);
  const { data, error } = await q;
  const canAct = has(me, "super_admin", "city_admin", "support");
  return (
    <>
      <h1>Churn alerts</h1>
      <CrmTabs at="/crm/alerts" />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
        <Link className="btn small secondary" href={done ? "/crm/alerts" : "/crm/alerts?done=1"}>{done ? "Show open" : "Show handled"}</Link>
      </div>
      {error && <p className="error">{error.message}</p>}
      <table>
        <thead><tr><th>Vendor</th><th>This week</th><th>Weekly average (4 weeks before)</th><th>Drop</th><th>Flagged</th><th>{done ? "What was done" : ""}</th></tr></thead>
        <tbody>
          {(data ?? []).map((a) => { const v = one(a.vendors); return (
            <tr key={a.id}>
              <td><Link href={`/vendors/${v?.id}`}>{v?.business_name}</Link><div className="muted">{v?.contact_phone}</div></td>
              <td>{a.this_week}</td><td>{a.weekly_avg}</td><td><span className="sla bad">−{a.drop_percent}%</span></td><td>{when(a.created_at)}</td>
              <td>{done ? <>{a.handled_note}<div className="muted">{one(a.handler)?.full_name ?? "automatic"} · {when(a.handled_at)}</div></>
                : canAct && <RpcButton fn="handle_crm_alert" args={{ p_id: a.id }} reason="p_note" done="Handled" label="Mark handled" />}</td>
            </tr>); })}
          {!data?.length && <tr><td colSpan={6} className="muted">{done ? "Nothing handled yet." : "No vendors at risk right now."}</td></tr>}
        </tbody>
      </table>
      <p className="muted">Write what you did (for example &quot;called the owner: supplier problem, back next week&quot;); it goes on the vendor&apos;s timeline. Alerts close by themselves when volume recovers. Threshold and minimum size: Settings → churn_drop_percent, churn_min_weekly_orders.</p>
    </>
  );
}
