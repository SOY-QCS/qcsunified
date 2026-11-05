import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, has, statusText, when } from "@/lib/ops";
import { catText } from "@/lib/sla";
import { CrmProfile, NoteBox } from "@/components/crm";
import { CRM_ROLES, CrmTabs, one } from "../../tabs";

/** Customer 360: orders, spend, COD, complaints, notes, tags, account manager. */
export default async function Customer360({ params }: PageProps<"/crm/customers/[id]">) {
  const me = await requireRole([...CRM_ROLES]);
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: p } = await sb.from("profiles").select("id, full_name, phone, email, created_at, marketing_opt_in, cities(name)").eq("id", id).maybeSingle();
  if (!p) notFound();
  const [{ data: s, error }, { data: orders }, { data: tickets }, { data: notes }, { data: managers }, { data: owned }] = await Promise.all([
    sb.rpc("customer_360", { p_user: id }),
    sb.from("orders").select("tracking_number, status, service_type, created_at, recipient_name, quoted_fee, cod_amount").eq("customer_id", id).neq("status", "DRAFT").order("created_at", { ascending: false }).limit(20),
    sb.from("tickets").select("id, number, subject, category, status, created_at").eq("customer_id", id).order("created_at", { ascending: false }).limit(20),
    sb.from("crm_notes").select("id, body, created_at, profiles!crm_notes_author_id_fkey(full_name)").eq("customer_id", id).order("created_at", { ascending: false }).limit(50),
    sb.from("user_roles").select("user_id, profiles!user_roles_user_id_fkey(full_name)").in("role", ["super_admin", "city_admin", "support"]),
    sb.from("vendors").select("id, business_name").eq("owner_id", id),
  ]);
  const x = (s ?? {}) as Record<string, number | string | boolean | string[] | null>;
  const mgrs = [...new Map((managers ?? []).map((m) => [m.user_id, one(m.profiles)?.full_name ?? "Staff"])).entries()].map(([k, name]) => ({ id: k, name }));
  return (
    <>
      <p><Link href="/crm/customers">← Customers</Link></p>
      <h1>{p.full_name ?? "Customer"} {x.is_rider ? <span className="tag">rider</span> : null}{(x.tags as string[] | null)?.map((t) => <span key={t} className="tag">{t}</span>)}</h1>
      <CrmTabs at="/crm/customers" />
      <p>{p.phone} · {p.email ?? "no email"} · {one(p.cities)?.name ?? "—"} · joined {when(p.created_at)} · offers: {p.marketing_opt_in ? "yes" : "no"}</p>
      {!!owned?.length && <p>Owns vendor account: {owned.map((v) => <Link key={v.id} href={`/vendors/${v.id}`}>{v.business_name}</Link>)}</p>}
      {error && <p className="error">{error.message}</p>}
      <div className="row">
        {[["Deliveries", x.orders], ["Delivered", x.delivered], ["Failed / returned", x.failed], ["Spent", ghs(x.spend as number)], ["COD value", ghs(x.cod as number)],
          ["Wallet", ghs(x.wallet_balance as number)], ["Open tickets", x.tickets_open], ["Complaints (all time)", x.tickets_total], ["Avg rating given", x.avg_rating_given ? `★ ${x.avg_rating_given}` : "—"],
          ["Last order", when(x.last_order_at as string)]].map(([k, v]) => (
          <div key={String(k)} className="card tile"><div className="muted">{k}</div><div className="n" style={{ fontSize: 18 }}>{String(v ?? "—")}</div></div>
        ))}
      </div>
      <div className="card">
        <CrmProfile subject="customer" id={id} tags={(x.tags as string[]) ?? []} manager={(x.account_manager_id as string) ?? null} managers={mgrs}
          canEdit={has(me, "super_admin", "city_admin", "support")} />
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: "2 1 420px" }}>
          <h2>Deliveries</h2>
          <table><tbody>{(orders ?? []).map((o) => <tr key={o.tracking_number}><td>{when(o.created_at)}</td><td><Link href={`/orders/${o.tracking_number}`}>{o.tracking_number}</Link></td>
            <td>{o.service_type}</td><td>{statusText(o.status)}</td><td>{ghs(o.quoted_fee)}</td><td>{o.cod_amount ? `COD ${ghs(o.cod_amount)}` : ""}</td></tr>)}
            {!orders?.length && <tr><td className="muted">No deliveries yet.</td></tr>}</tbody></table>
          <h2>Tickets <Link className="btn small secondary" href={`/crm/tickets/new?phone=${encodeURIComponent(p.phone ?? "")}`}>+ Log a call</Link></h2>
          <table><tbody>{(tickets ?? []).map((t) => <tr key={t.id}><td><Link href={`/crm/tickets/${t.id}`}>#{t.number}</Link></td><td>{t.subject}</td><td>{catText(t.category)}</td><td>{t.status}</td><td>{when(t.created_at)}</td></tr>)}
            {!tickets?.length && <tr><td className="muted">No complaints.</td></tr>}</tbody></table>
        </div>
        <div style={{ flex: "1 1 280px" }}>
          <h2>Notes</h2>
          {has(me, "super_admin", "city_admin", "support") && <NoteBox subject="customer" id={id} />}
          {(notes ?? []).map((n) => <div key={n.id} className="card" style={{ padding: 10 }}><div className="muted">{one(n.profiles)?.full_name} · {when(n.created_at)}</div>{n.body}</div>)}
        </div>
      </div>
    </>
  );
}
