import Link from "next/link";
import { TrackView } from "@qcs/ui/web";
import { supabaseServer } from "@/lib/supabase/server";

const OUTCOME: Record<string, string> = { confirmed: "confirmed", no_answer: "no answer", rescheduled: "rescheduled", cancelled_by_customer: "customer cancelled", question: "answered a question", message_sent: "message sent", other: "other" };

/** One order, live: map, rider, arrival estimate, history and (after delivery) the rider rating. */
export default async function OrderPage({ params }: { params: Promise<{ tn: string }> }) {
  const { tn } = await params;
  const tracking = decodeURIComponent(tn);
  // Calls/chats QCS customer service had with your customer about this order (vendors with that service)
  const sb = await supabaseServer();
  const { data: o } = await sb.from("orders").select("id").eq("tracking_number", tracking).maybeSingle();
  const { data: contacts } = o ? await sb.from("order_contacts").select("id, kind, outcome, note, created_at").eq("order_id", o.id).order("created_at") : { data: [] };
  return (
    <>
      <p><Link href="/orders">← Orders</Link></p>
      <h1>Track {decodeURIComponent(tn)}</h1>
      <div style={{ maxWidth: 640 }}>
        <TrackView apiBase="" tracking={decodeURIComponent(tn)} mapsKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY} askForCode={false}
          rateUrl="/api/v1/ratings" credentials="include" />
      </div>
      <p><Link className="btn secondary" href={`/support?tracking=${encodeURIComponent(tracking)}`}>Report a problem</Link></p>
      {!!contacts?.length && <><h2>QCS customer service on this order</h2>
        <table><tbody>{contacts.map((c) => <tr key={c.id}><td>{new Date(c.created_at).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
          <td>{c.kind}</td><td>{OUTCOME[c.outcome] ?? c.outcome}</td><td>{c.note}</td></tr>)}</tbody></table></>}
    </>
  );
}
