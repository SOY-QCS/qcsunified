import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { myCities, pickCity, when } from "@/lib/ops";
import { CATEGORIES, catText, slaState } from "@/lib/sla";
import { CityPicker } from "@/components/run";
import { CRM_ROLES, CrmTabs, one } from "../tabs";

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The support queue. Filters live in the address bar so a link can be shared ("all overdue WhatsApp tickets"). */
export default async function Tickets({ searchParams }: PageProps<"/crm/tickets">) {
  const me = await requireRole([...CRM_ROLES]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const status = str(sp.status) || "active", assigned = str(sp.assigned), channel = str(sp.channel), priority = str(sp.priority),
        category = str(sp.category), sla = str(sp.sla), q = str(sp.q).trim();

  let query = sb.from("tickets").select(`id, number, subject, category, priority, status, channel, opened_as, requester_name, requester_phone, created_at, updated_at,
      first_responded_at, first_response_due, resolution_due, resolved_at, last_customer_at,
      orders(tracking_number), assignee:profiles!tickets_assigned_to_fkey(full_name)`)
    .order("priority", { ascending: false }).order("first_response_due").limit(200);
  if (status === "active") query = query.in("status", ["open", "pending"]); else if (status !== "all") query = query.eq("status", status);
  if (assigned === "me") query = query.eq("assigned_to", me.id); else if (assigned === "none") query = query.is("assigned_to", null);
  if (channel) query = query.eq("channel", channel);
  if (priority) query = query.eq("priority", priority);
  if (category) query = query.eq("category", category);
  if (city) query = query.eq("city_id", city.id);
  const now = new Date().toISOString();
  if (sla === "overdue") query = query.eq("status", "open").or(`and(first_responded_at.is.null,first_response_due.lt.${now}),resolution_due.lt.${now}`);
  if (q) {
    if (/^#?\d+$/.test(q)) query = query.eq("number", Number(q.replace("#", "")));
    else if (/^[A-Za-z]{3}-\d{12}/.test(q)) {
      const { data: o } = await sb.from("orders").select("id").eq("tracking_number", q.toUpperCase()).maybeSingle();
      query = query.eq("order_id", o?.id ?? "00000000-0000-0000-0000-000000000000");
    } else query = query.or(`subject.ilike.%${q.replace(/[%,()]/g, "")}%,requester_name.ilike.%${q.replace(/[%,()]/g, "")}%,requester_phone.ilike.%${q.replace(/\D/g, "") || "x"}%`);
  }
  const { data: tickets, error } = await query;
  const link = (k: string, v: string) => { const u = new URLSearchParams(Object.entries(sp).flatMap(([a, b]) => (typeof b === "string" ? [[a, b]] : []))); if (v) u.set(k, v); else u.delete(k); return `/crm/tickets?${u}`; };

  return (
    <>
      <h1>{channel === "whatsapp" ? "WhatsApp inbox" : "Support tickets"}</h1>
      <CrmTabs at={channel === "whatsapp" ? "/crm/tickets?channel=whatsapp" : "/crm/tickets"} />
      <form className="row" style={{ alignItems: "end", marginBottom: 12 }}>
        {Object.entries(sp).filter(([k]) => !["q", "status", "category"].includes(k)).map(([k, v]) => typeof v === "string" && <input key={k} type="hidden" name={k} value={v} />)}
        <div><label>Search</label><input name="q" defaultValue={q} placeholder="#ticket, tracking number, name or phone" /></div>
        <div><label>Status</label><select name="status" defaultValue={status}>
          <option value="active">Open + waiting</option><option value="open">Open (needs us)</option><option value="pending">Waiting for customer</option>
          <option value="resolved">Resolved</option><option value="closed">Closed</option><option value="all">All</option></select></div>
        <div><label>Problem</label><select name="category" defaultValue={category}><option value="">Any</option>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn">Filter</button></div>
        <div style={{ flex: "0 0 auto" }}><Link className="btn secondary" href="/crm/tickets/new">+ Log a call</Link></div>
      </form>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
        {[["assigned", "me", "Mine"], ["assigned", "none", "Unassigned"], ["sla", "overdue", "Overdue"], ["priority", "urgent", "Urgent"], ["channel", "whatsapp", "WhatsApp"], ["channel", "app", "App"], ["channel", "phone", "Phone"]].map(([k, v, l]) => {
          const on = str(sp[k as keyof typeof sp]) === v;
          return <Link key={k + v} href={link(k!, on ? "" : v!)} className={`btn small ${on ? "" : "secondary"}`}>{l}</Link>;
        })}
      </div>
      {error && <p className="error">{error.message}</p>}
      <table>
        <thead><tr><th>#</th><th>Subject</th><th>From</th><th>Problem</th><th>SLA</th><th>Assigned</th><th>Last update</th></tr></thead>
        <tbody>
          {(tickets ?? []).map((t) => { const s = slaState(t); const o = one(t.orders); return (
            <tr key={t.id}>
              <td><Link href={`/crm/tickets/${t.id}`}>#{t.number}</Link></td>
              <td><Link href={`/crm/tickets/${t.id}`}>{t.subject}</Link>{o && <div className="muted">{o.tracking_number}</div>}</td>
              <td>{t.requester_name ?? t.requester_phone ?? "—"}<div className="muted">{t.channel} · {t.opened_as}</div></td>
              <td>{catText(t.category)}{t.priority === "urgent" && <> <span className="sla bad">urgent</span></>}{t.priority === "high" && <> <span className="sla warn">high</span></>}</td>
              <td><span className={`sla ${s.cls}`}>{t.status === "open" || t.status === "pending" ? s.text : `${t.status} · ${s.text}`}</span></td>
              <td>{one(t.assignee)?.full_name ?? <span className="muted">nobody</span>}</td>
              <td>{when(t.updated_at)}</td>
            </tr>); })}
          {!tickets?.length && <tr><td colSpan={7} className="muted">No tickets match.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
