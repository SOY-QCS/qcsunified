import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { myCities, pickCity, when } from "@/lib/ops";
import { slaState, catText } from "@/lib/sla";
import { CityPicker } from "@/components/run";
import { CRM_ROLES, CrmTabs } from "./tabs";

export default async function CrmOverview({ searchParams }: PageProps<"/crm">) {
  const me = await requireRole([...CRM_ROLES]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  let mine = sb.from("tickets").select("id, number, subject, category, priority, status, channel, created_at, first_responded_at, first_response_due, resolution_due, resolved_at")
    .eq("assigned_to", me.id).in("status", ["open", "pending"]).order("first_response_due").limit(20);
  let follow = sb.from("leads").select("id, business_name, stage, next_action, next_action_at").lte("next_action_at", new Date().toISOString().slice(0, 10))
    .in("stage", ["new", "contacted", "trial"]).order("next_action_at").limit(20);
  if (city) { mine = mine.eq("city_id", city.id); follow = follow.eq("city_id", city.id); }
  const [{ data: o, error }, { data: tickets }, { data: leads }] = await Promise.all([sb.rpc("support_overview", { p_city: city?.id ?? null }), mine, follow]);
  const s = (o ?? {}) as Record<string, number | null>;
  const tiles: [string, number | string | null, string, boolean][] = [
    ["Open tickets", s.open, "/crm/tickets?status=open", false],
    ["Reply overdue", s.reply_overdue, "/crm/tickets?sla=overdue", (s.reply_overdue ?? 0) > 0],
    ["Resolution overdue", s.resolve_overdue, "/crm/tickets?sla=overdue", (s.resolve_overdue ?? 0) > 0],
    ["Urgent (COD, lost, damaged)", s.urgent_open, "/crm/tickets?priority=urgent", (s.urgent_open ?? 0) > 0],
    ["Unassigned", s.unassigned, "/crm/tickets?assigned=none", false],
    ["WhatsApp waiting", s.whatsapp_open, "/crm/tickets?channel=whatsapp", false],
    ["Waiting for customer", s.waiting_customer, "/crm/tickets?status=pending", false],
    ["First reply in time (7 days)", s.first_reply_met_7d == null ? "—" : `${s.first_reply_met_7d}%`, "/crm/tickets", false],
    ["Resolved in time (7 days)", s.resolved_in_time_7d == null ? "—" : `${s.resolved_in_time_7d}%`, "/crm/tickets?status=resolved", false],
    ["Churn alerts", s.churn_alerts_open, "/crm/alerts", (s.churn_alerts_open ?? 0) > 0],
    ["Lead follow-ups due", s.leads_follow_up_due, "/crm/leads", false],
  ];
  return (
    <>
      <h1>CRM &amp; Support</h1>
      <CrmTabs at="/crm" />
      <CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
      {error && <p className="error">{error.message}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        {tiles.map(([k, v, href, bad]) => (
          <Link key={k} href={href} className={`card tile ${bad ? "alert" : ""}`} style={{ color: "inherit", textDecoration: "none" }}>
            <div className="muted">{k}</div><div className="n">{v ?? 0}</div>
          </Link>
        ))}
      </div>
      <p className="muted">SLA: first reply within 1 working hour, solved within 24 working hours (Settings → support hours). COD money and lost/damaged parcels are top priority.</p>

      <h2>My open tickets</h2>
      <table><tbody>
        {(tickets ?? []).map((t) => { const sla = slaState(t); return (
          <tr key={t.id}><td><Link href={`/crm/tickets/${t.id}`}>#{t.number}</Link></td><td>{t.subject}</td><td>{catText(t.category)}</td>
            <td>{t.priority === "urgent" ? <span className="sla bad">urgent</span> : t.priority}</td><td><span className={`sla ${sla.cls}`}>{sla.text}</span></td><td>{when(t.created_at)}</td></tr>); })}
        {!tickets?.length && <tr><td className="muted">Nothing assigned to you. <Link href="/crm/tickets?assigned=none">Pick up an unassigned ticket</Link>.</td></tr>}
      </tbody></table>

      <h2>Lead follow-ups due</h2>
      <table><tbody>
        {(leads ?? []).map((l) => <tr key={l.id}><td><Link href={`/crm/leads/${l.id}`}>{l.business_name}</Link></td><td>{l.stage}</td><td>{l.next_action}</td><td>{l.next_action_at}</td></tr>)}
        {!leads?.length && <tr><td className="muted">No follow-ups due.</td></tr>}
      </tbody></table>
    </>
  );
}
