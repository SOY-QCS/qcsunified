import Link from "next/link";
import { problemLabel, TICKET_STATUS_TEXT } from "@qcs/types";
import { supabaseServer } from "@/lib/supabase/server";
import { NewTicketForm } from "./ticket-form";

const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** My support tickets (the business's), and the "Contact support / Report a problem" form. */
export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { data: tickets } = await (await supabaseServer()).from("tickets")
    .select("id, number, subject, category, status, created_at, updated_at, orders(tracking_number)").order("updated_at", { ascending: false }).limit(50);
  const showForm = sp.new === "1" || !!sp.tracking;
  return (
    <>
      <h1>Support</h1>
      {showForm ? <><h2>{sp.tracking ? `Report a problem with ${sp.tracking}` : "Contact support"}</h2><NewTicketForm tracking={sp.tracking ?? ""} /></>
        : <p><Link className="btn" href="/support?new=1">Contact support</Link> <Link className="btn secondary" href="/help">Help centre</Link></p>}
      <h2>My tickets</h2>
      <table><tbody>
        {(tickets ?? []).map((t) => { const o = Array.isArray(t.orders) ? t.orders[0] : t.orders; return (
          <tr key={t.id}><td><Link href={`/support/${t.id}`}>#{t.number}</Link></td><td><Link href={`/support/${t.id}`}>{t.subject}</Link><div className="muted">{problemLabel(t.category)}{o ? ` · ${o.tracking_number}` : ""}</div></td>
            <td>{TICKET_STATUS_TEXT[t.status] ?? t.status}</td><td className="muted">{when(t.updated_at)}</td></tr>); })}
        {!tickets?.length && <tr><td className="muted">No tickets yet.</td></tr>}
      </tbody></table>
    </>
  );
}
