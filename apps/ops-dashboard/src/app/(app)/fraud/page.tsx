import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { when } from "@/lib/ops";
import { FraudReview } from "./review";

const KINDS: Record<string, { label: string; means: string }> = {
  shared_device:      { label: "One phone, many accounts", means: "Several accounts signed in on the same phone. Common with fake sign-ups for referral credit, or a blocked person coming back." },
  recipient_failures: { label: "Recipient keeps failing",   means: "Deliveries to this phone number keep failing or coming back: fake orders, pranks, or someone refusing COD parcels." },
  rider_failures:     { label: "Rider fails a lot",         means: "This rider marks far more deliveries as failed than normal. Check the reasons and call a few recipients." },
  vendor_failures:    { label: "Vendor returns a lot",      means: "Many of this vendor's orders fail or come back. Could be poor addresses, fake orders or unwanted goods." },
  gps_spoofing:       { label: "Fake GPS",                  means: "The rider's phone reported a fake-location app, or the rider 'jumped' faster than a motorbike can go." },
  far_deliveries:     { label: "Delivered away from pin",   means: "The rider marked deliveries done well away from the drop-off pin, again and again." },
  cancellations:      { label: "Cancels a lot",             means: "This customer or vendor cancels far more bookings than normal, often after a rider is on the way." },
};
const STATUSES = { open: "To review", confirmed: "Confirmed", dismissed: "Dismissed" } as const;
const LABELS: Record<string, string> = {
  accounts: "Accounts on this phone", orders: "Orders", senders: "Different senders", failed: "Failed attempts", attempts: "All attempts", reasons: "Reasons given",
  failed_or_returned: "Failed or returned", mocked: "Fake-location reports", jumps: "Impossible jumps", fastest_kmh: "Fastest jump (km/h)", last_at: "Last seen",
  bookings: "Bookings (7 days)", cancelled_7d: "Cancelled (7 days)", cancelled_24h: "Cancelled (24 hours)", after_rider: "Cancelled after a rider was on the way",
  model: "Phone model", name: "Name", phone: "Phone", rider: "Rider?", joined: "Joined", last_seen: "Last used", tracking_number: "Tracking no.", status: "Status",
  reason: "Reason", at: "When", metres: "Metres from pin",
};
const label = (k: string) => LABELS[k] ?? k.replaceAll("_", " ");

type Flag = {
  id: string; kind: string; subject_type: string; subject_id: string | null; subject_key: string; subject_name: string | null; city: string | null;
  severity: "high" | "medium" | "low"; summary: string; evidence: Record<string, unknown>; status: string; times_seen: number;
  first_seen: string; last_seen: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; can_review: boolean;
};

/** Fraud checks: an hourly scan lists suspicious patterns here. A flag is a question for a person, never proof. */
export default async function Fraud({ searchParams }: PageProps<"/fraud">) {
  await requireRole(["super_admin", "city_admin", "dispatcher", "finance", "support"]);
  const sp = await searchParams;
  const status = (typeof sp.status === "string" && sp.status in STATUSES ? sp.status : "open") as keyof typeof STATUSES;
  const kind = typeof sp.kind === "string" && sp.kind in KINDS ? sp.kind : null;
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc("fraud_list", { p_status: status, p_kind: kind });
  const flags = (data ?? []) as Flag[];
  const href = (s: string, k: string | null) => `/fraud?status=${s}${k ? `&kind=${k}` : ""}`;

  return (
    <>
      <h1>Fraud checks</h1>
      <p className="muted" style={{ maxWidth: 760 }}>
        Every hour QCS looks for suspicious patterns. Each flag is a <strong>question, not proof</strong>: look at the evidence, call the people involved,
        then dismiss it or confirm it with a note (both go in the audit log). Super Admins and City Admins review; new high-priority flags are also emailed to them.
        Thresholds are in Settings (keys starting with <code>fraud_</code>).
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {Object.entries(STATUSES).map(([s, l]) => <Link key={s} className={`btn small ${s === status ? "" : "secondary"}`} href={href(s, kind)}>{l}</Link>)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        <Link className={`tag ${kind ? "" : "on"}`} href={href(status, null)}>All kinds</Link>
        {Object.entries(KINDS).map(([k, v]) => <Link key={k} className={`tag ${k === kind ? "on" : ""}`} href={href(status, k)}>{v.label}</Link>)}
      </div>
      {error && <p className="error">{error.message}</p>}
      {!error && !flags.length && <p className="muted">{status === "open" ? "Nothing to review. 🎉" : "Nothing here yet."}</p>}

      {flags.map((f) => (
        <section key={f.id} className="card" style={{ borderLeft: `4px solid ${f.severity === "high" ? "#c62828" : f.severity === "medium" ? "#df6518" : "#9e9e9e"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <strong>{KINDS[f.kind]?.label ?? f.kind} · <Subject f={f} /></strong>
            <span className={`sla ${f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : ""}`}>{f.severity === "high" ? "High priority" : f.severity === "medium" ? "Medium" : "Low"}</span>
          </div>
          <p style={{ margin: "6px 0" }}>{f.summary}</p>
          <p className="muted" style={{ margin: "0 0 6px" }}>{KINDS[f.kind]?.means}</p>
          <details>
            <summary>Evidence</summary>
            <Evidence value={f.evidence} />
          </details>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            {f.city ?? "All cities"} · first seen {when(f.first_seen)} · last seen {when(f.last_seen)}{f.times_seen > 1 ? ` · found in ${f.times_seen} checks` : ""}
          </p>
          {f.status !== "open" && <p style={{ margin: "6px 0 0" }}><strong>{STATUSES[f.status as keyof typeof STATUSES]}</strong> by {f.reviewed_by ?? "—"} · {when(f.reviewed_at)}: {f.review_note}</p>}
          {f.status === "open" && (f.can_review ? <FraudReview id={f.id} /> : <p className="muted" style={{ margin: "6px 0 0" }}>A Super Admin or the City Admin reviews this.</p>)}
        </section>
      ))}
    </>
  );
}

function Subject({ f }: { f: Flag }) {
  const name = f.subject_name ?? f.subject_key;
  if (f.subject_type === "rider" && f.subject_id) return <Link href={`/riders/${f.subject_id}`}>{name}</Link>;
  if (f.subject_type === "vendor" && f.subject_id) return <Link href={`/vendors/${f.subject_id}`}>{name}</Link>;
  if (f.subject_type === "customer" && f.subject_id) return <Link href={`/crm/customers/${f.subject_id}`}>{name}</Link>;
  if (f.subject_type === "phone") return <Link href={`/orders?view=all&q=${encodeURIComponent(f.subject_key)}`}>{name}</Link>;
  return <span>phone {name.slice(0, 8)}…</span>;
}

/** Shows any evidence: numbers as a list, lists of records as small tables (tracking numbers link to the order). */
function Evidence({ value }: { value: Record<string, unknown> }) {
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
      {Object.entries(value).map(([k, v]) => {
        if (Array.isArray(v) && v.length && typeof v[0] === "object") {
          const cols = Object.keys(v[0] as object).filter((c) => c !== "id");   // ids become links on the name instead
          return (
            <div key={k} style={{ overflowX: "auto" }}>
              <div className="muted">{label(k)}</div>
              <table>
                <thead><tr>{cols.map((c) => <th key={c}>{label(c)}</th>)}</tr></thead>
                <tbody>{(v as Record<string, unknown>[]).map((row, i) => <tr key={i}>{cols.map((c) => <td key={c}>{c === "name" && row.id
                  ? <Link href={row.rider ? `/riders/${row.id}` : `/crm/customers/${row.id}`}>{String(row.name ?? "(no name)")}</Link>
                  : <Cell k={c} v={row[c]} />}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        if (v && typeof v === "object") {
          return <div key={k}><span className="muted">{label(k)}:</span> {Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a.replaceAll("_", " ")} ${b}`).join(" · ")}</div>;
        }
        return <div key={k}><span className="muted">{label(k)}:</span> <Cell k={k} v={v} /></div>;
      })}
    </div>
  );
}

function Cell({ k, v }: { k: string; v: unknown }) {
  if (v == null || v === "") return <>—</>;
  if (k === "tracking_number") return <Link href={`/orders/${v}`}>{String(v)}</Link>;
  if (typeof v === "boolean") return <>{v ? "yes" : "no"}</>;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return <>{when(v)}</>;
  if (k === "status") return <>{String(v).replaceAll("_", " ").toLowerCase()}</>;
  return <>{String(v)}</>;
}
