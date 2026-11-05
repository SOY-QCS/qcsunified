import Link from "next/link";
import { notFound } from "next/navigation";
import { problemLabel, TICKET_STATUS_TEXT } from "@qcs/types";
import { supabaseServer } from "@/lib/supabase/server";
import { ReplyForm } from "../ticket-form";

const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** One ticket: the conversation with QCS Support (internal staff notes are never shown here). */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: t } = await sb.from("tickets").select("id, number, subject, category, status, created_at, orders(tracking_number)").eq("id", id).maybeSingle();
  if (!t) notFound();
  const { data: msgs } = await sb.from("ticket_messages").select("id, body, author_kind, attachment_path, created_at").eq("ticket_id", id).order("created_at");
  const paths = (msgs ?? []).map((m) => m.attachment_path).filter((p): p is string => !!p && !p.startsWith("wa/"));
  const signed = paths.length ? (await sb.storage.from("support").createSignedUrls(paths, 900)).data ?? [] : [];
  const o = Array.isArray(t.orders) ? t.orders[0] : t.orders;
  return (
    <>
      <p><Link href="/support">← Support</Link></p>
      <h1>#{t.number} {t.subject}</h1>
      <p className="muted">{problemLabel(t.category)}{o ? <> · <Link href={`/orders/${o.tracking_number}`}>{o.tracking_number}</Link></> : null} · {TICKET_STATUS_TEXT[t.status] ?? t.status}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
        {(msgs ?? []).map((m) => { const url = signed.find((s) => s.path === m.attachment_path)?.signedUrl; return (
          <div key={m.id} className="card" style={{ margin: 0, background: m.author_kind === "staff" ? "#fbeee4" : undefined, marginLeft: m.author_kind === "staff" ? 40 : 0 }}>
            <div className="muted">{m.author_kind === "staff" ? "QCS Support" : "You"} · {when(m.created_at)}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
            {url && <a href={url} target="_blank" rel="noreferrer">View attachment</a>}
          </div>); })}
      </div>
      {t.status === "closed" ? <p className="muted">This ticket is closed. <Link href="/support?new=1">Open a new one</Link> if you need more help.</p> : <><h2>Reply</h2><ReplyForm ticket={id} /></>}
    </>
  );
}
