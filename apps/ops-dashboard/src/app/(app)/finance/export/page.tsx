import { requireRole } from "@/lib/session";
import { FinanceTabs } from "../tabs";

const KINDS = [
  ["journal", "Ledger journal", "Every money movement, double-entry: date, type, account, debit, credit, Hubtel reference. For the accountant."],
  ["payouts", "Payouts", "Every payout requested: payee, MoMo number, amount, fee, status, who approved, Hubtel reference."],
  ["cod", "Cash on delivery", "Every COD parcel: collected by whom, handed in how and when, which payout paid the vendor."],
  ["earnings", "Rider earnings", "Every pickup fee, stop fee, commission, bonus and deduction."],
] as const;

/** CSV exports (open in Excel or Google Sheets). Dates are Accra time; amounts in GHS. */
export default async function Export() {
  await requireRole(["super_admin", "finance", "analyst"]);
  const today = new Date().toISOString().slice(0, 10);
  const first = today.slice(0, 8) + "01";
  return (
    <>
      <h1>Finance</h1>
      <FinanceTabs at="/finance/export" />
      {KINDS.map(([k, label, hint]) => (
        <form key={k} className="card" action="/api/export" method="get">
          <input type="hidden" name="kind" value={k} />
          <strong>{label}</strong><p className="muted">{hint}</p>
          <div className="row" style={{ alignItems: "end" }}>
            <div><label>From</label><input type="date" name="from" defaultValue={first} /></div>
            <div><label>To</label><input type="date" name="to" defaultValue={today} /></div>
            <div style={{ flex: "0 0 auto" }}><button className="btn">Download CSV</button></div>
          </div>
        </form>
      ))}
    </>
  );
}
