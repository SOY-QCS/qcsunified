import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { PayoutActions, RefundForm } from "./forms";
import { FinanceTabs } from "./tabs";

const ghs = (p: number) => `GHS ${(p / 100).toLocaleString("en-GH", { minimumFractionDigits: 2 })}`;
const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra" });

export default async function Finance() {
  const me = await requireRole(["super_admin", "finance", "analyst"]);
  const canAct = me.roles.some((r) => r.role === "super_admin" || r.role === "finance");
  const sb = await supabaseServer();
  const [{ data: payouts }, { data: payments }, { data: system }] = await Promise.all([
    sb.from("payouts").select("id, purpose, amount, fee, momo_number, momo_network, status, requested_at, failure_reason, batch_id").order("requested_at", { ascending: false }).limit(50),
    sb.from("payments").select("client_reference, purpose, amount, state, channel, created_at, paid_at, failure_reason").order("created_at", { ascending: false }).limit(50),
    sb.from("wallets").select("system_code, balance").eq("owner_type", "system").order("system_code"),
  ]);
  const waiting = (payouts ?? []).filter((p) => p.status === "requested" && !p.batch_id);   // batch payouts are approved on the batch page
  return (
    <>
      <h1>Finance</h1>
      <FinanceTabs at="/finance" />
      <div className="row">
        {(system ?? []).map((w) => (
          <div key={w.system_code} className="card"><span className="muted">{w.system_code.replaceAll("_", " ").toLowerCase()}</span><div className="total">{ghs(w.balance)}</div></div>
        ))}
      </div>
      <p className="muted">Hubtel clearing is negative by the money Hubtel holds for QCS. All wallets together always add up to zero.</p>

      <h2>Single payouts waiting ({waiting.length})</h2>
      <p className="muted">Customer wallet withdrawals and rider instant cash-outs. Weekly rider pay and vendor COD are on Payout batches.</p>
      <table>
        <thead><tr><th>Requested</th><th>Amount</th><th>To</th><th>{canAct ? "Action" : "Status"}</th></tr></thead>
        <tbody>
          {waiting.map((p) => (
            <tr key={p.id}><td>{when(p.requested_at)}</td><td>{ghs(p.amount)}{p.fee ? <><br /><span className="muted">+ {ghs(p.fee)} fee · {p.purpose.replace("_", " ")}</span></> : <><br /><span className="muted">{p.purpose.replace("_", " ")}</span></>}</td><td>{p.momo_number} ({p.momo_network})</td>
              <td>{canAct ? <PayoutActions id={p.id} /> : p.status}</td></tr>
          ))}
          {waiting.length === 0 && <tr><td colSpan={4} className="muted">Nothing waiting.</td></tr>}
        </tbody>
      </table>

      {canAct && <><h2>Refunds</h2><RefundForm /></>}

      <h2>Recent payments</h2>
      <table>
        <thead><tr><th>Started</th><th>Reference</th><th>For</th><th>Amount</th><th>State</th><th>Channel</th></tr></thead>
        <tbody>
          {(payments ?? []).map((p) => (
            <tr key={p.client_reference} className={p.failure_reason ? "bad" : undefined}>
              <td>{when(p.created_at)}</td><td>{p.client_reference}</td><td>{p.purpose === "order" ? "Delivery" : "Wallet top-up"}</td>
              <td>{ghs(p.amount)}</td><td>{p.state}{p.failure_reason ? <><br /><span className="muted">{p.failure_reason}</span></> : null}</td><td>{p.channel ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent payouts</h2>
      <table>
        <thead><tr><th>Requested</th><th>Amount</th><th>To</th><th>Status</th></tr></thead>
        <tbody>{(payouts ?? []).filter((p) => p.status !== "requested").map((p) => (
          <tr key={p.id}><td>{when(p.requested_at)}</td><td>{ghs(p.amount)}</td><td>{p.momo_number}</td><td>{p.status}{p.failure_reason ? ` — ${p.failure_reason}` : ""}</td></tr>
        ))}</tbody>
      </table>
    </>
  );
}
