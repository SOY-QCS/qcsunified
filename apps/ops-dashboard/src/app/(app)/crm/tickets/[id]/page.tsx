import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, statusText, when } from "@/lib/ops";
import { catText, slaState, waWindowOpen } from "@/lib/sla";
import { CRM_ROLES, CrmTabs, one } from "../../tabs";
import { ReplyBox, TicketControls } from "./ticket-tools";

export default async function TicketPage({ params }: PageProps<"/crm/tickets/[id]">) {
  const me = await requireRole([...CRM_ROLES, "dispatcher"]);
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: t } = await sb.from("tickets").select(`*, orders(id, tracking_number, status, recipient_name, recipient_phone, vendor_id, vendors(business_name)),
      customer:profiles!tickets_customer_id_fkey(id, full_name, phone, email), vendors(id, business_name)`).eq("id", id).maybeSingle();
  if (!t) notFound();
  const [{ data: msgs }, { data: canned }, { data: staff }, { data: others }] = await Promise.all([
    sb.from("ticket_messages").select("id, body, is_internal, author_kind, attachment_path, sent_via, created_at, profiles(full_name)").eq("ticket_id", id).order("created_at"),
    sb.from("canned_replies").select("id, title, body, category").order("title"),
    sb.from("user_roles").select("user_id, role, city_id, profiles!user_roles_user_id_fkey(full_name)").in("role", ["super_admin", "city_admin", "support", "dispatcher", "finance"]),
    t.requester_phone || t.customer_id
      ? sb.from("tickets").select("id, number, subject, status, created_at").neq("id", id)
          .or([t.customer_id && `customer_id.eq.${t.customer_id}`, t.requester_phone && `requester_phone.eq.${t.requester_phone}`].filter(Boolean).join(","))
          .order("created_at", { ascending: false }).limit(5)
      : Promise.resolve({ data: [] as { id: string; number: number; subject: string; status: string; created_at: string }[] }),
  ]);
  // photos customers sent: private bucket, short-lived links
  const paths = (msgs ?? []).map((m) => m.attachment_path).filter((p): p is string => !!p);
  const signed = paths.length ? (await sb.storage.from("support").createSignedUrls(paths, 900)).data ?? [] : [];
  const urlFor = (p: string | null) => signed.find((s) => s.path === p)?.signedUrl;
  const o = one(t.orders); const cust = one(t.customer); const vend = one(t.vendors) ?? one(o?.vendors ?? null);
  const people = [...new Map((staff ?? []).filter((r) => !r.city_id || !t.city_id || r.city_id === t.city_id)
    .map((r) => [r.user_id, one(r.profiles)?.full_name ?? "Staff"])).entries()].map(([uid, name]) => ({ id: uid, name }));
  const sla = slaState(t);
  const canWrite = has(me, "super_admin", "city_admin", "support", "dispatcher");
  const waWindow = t.channel === "whatsapp" && waWindowOpen(t.last_customer_at);

  return (
    <>
      <p><Link href={t.channel === "whatsapp" ? "/crm/tickets?channel=whatsapp" : "/crm/tickets"}>← Tickets</Link></p>
      <h1>#{t.number} {t.subject}</h1>
      <CrmTabs at="/crm/tickets" />
      <p>
        <span className={`sla ${sla.cls}`}>{sla.text}</span>{" "}
        <span className="tag">{t.status}</span><span className="tag">{catText(t.category)}</span>
        {t.priority !== "normal" && <span className={`sla ${t.priority === "urgent" ? "bad" : "warn"}`}>{t.priority}</span>}{" "}
        <span className="muted">via {t.channel} · opened {when(t.created_at)} · first reply due {when(t.first_response_due)} · solve by {when(t.resolution_due)}</span>
      </p>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: "3 1 420px" }}>
          <div className="card chat">
            {(msgs ?? []).map((m) => {
              const staffMsg = m.author_kind !== "customer";
              const url = urlFor(m.attachment_path);
              return (
                <div key={m.id} className={`msg ${m.is_internal ? "internal" : staffMsg ? "staff" : ""}`}>
                  <div className="meta">{m.is_internal ? "Internal note · " : ""}{one(m.profiles)?.full_name ?? (staffMsg ? "QCS" : t.requester_name ?? "Customer")} · {when(m.created_at)}{m.sent_via ? ` · ${m.sent_via}` : ""}</div>
                  {m.body}
                  {m.attachment_path && <div style={{ marginTop: 6 }}>{url
                    ? (/\.(jpe?g|png|webp)$/i.test(m.attachment_path) ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="attachment" style={{ maxWidth: 220, borderRadius: 8 }} /></a> : <a href={url} target="_blank" rel="noreferrer">Open attachment</a>)
                    : <span className="muted">(attachment not available)</span>}</div>}
                </div>
              );
            })}
          </div>
          {canWrite && t.status !== "closed" && (
            <ReplyBox ticket={id} canned={(canned ?? []).map((c) => ({ title: c.title, body: c.body }))}
              note={t.channel === "whatsapp" ? (waWindow ? "Your reply goes to the customer on WhatsApp." : "More than 24 h since the customer wrote: WhatsApp only allows our approved reply template, so keep it short.")
                : cust ? "The customer gets a push notification (and email/SMS if they turned those on)." : "No QCS account: the reply goes by SMS."} />
          )}
          {t.status === "closed" && <p className="muted">Closed {when(t.closed_at)}. The customer has to open a new ticket.</p>}
        </div>

        <div style={{ flex: "1 1 260px" }}>
          <div className="card">
            <strong>Customer</strong>
            <p style={{ margin: "6px 0" }}>{t.requester_name ?? cust?.full_name ?? "Unknown"}<br />{t.requester_phone ?? cust?.phone}{cust?.email ? <><br />{cust.email}</> : null}</p>
            <p className="muted" style={{ margin: 0 }}>Opened as {t.opened_as}{vend ? ` · vendor: ${vend.business_name}` : ""}</p>
            {cust && <p style={{ margin: "6px 0 0" }}><Link href={`/crm/customers/${cust.id}`}>Customer profile →</Link></p>}
            {t.vendor_id && <p style={{ margin: "6px 0 0" }}><Link href={`/vendors/${t.vendor_id}`}>Vendor profile →</Link></p>}
          </div>
          {o && <div className="card">
            <strong>Delivery</strong>
            <p style={{ margin: "6px 0" }}><Link href={`/orders/${o.tracking_number}`}>{o.tracking_number}</Link><br />{statusText(o.status)} · to {o.recipient_name}</p>
          </div>}
          {canWrite && (() => {
            const v = { assigned_to: t.assigned_to ?? "", status: t.status, priority: t.priority, category: t.category, tracking: o?.tracking_number ?? "" };
            // key: start fresh whenever the ticket changes (e.g. a reply assigns it), so stale choices can't be saved back
            return <TicketControls key={JSON.stringify(v)} ticket={id} people={people} v={v} />;
          })()}
          {!!others?.length && <div className="card">
            <strong>Earlier tickets</strong>
            {others.map((x) => <div key={x.id}><Link href={`/crm/tickets/${x.id}`}>#{x.number}</Link> {x.subject} <span className="muted">({x.status})</span></div>)}
          </div>}
        </div>
      </div>
    </>
  );
}
