import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, has, myCities, pickCity, when } from "@/lib/ops";
import { CityPicker } from "@/components/run";
import { FinanceTabs } from "../tabs";
import { BankForm, ReceiveCash } from "./forms";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
interface Rec {
  period: { collected: number; handed_in_momo: number; handed_in_hub: number }; paid_to_vendors: number;
  now: { with_riders: number; overdue: number; received_not_paid_out: number; in_payout: number };
  riders: { rider_id: string; name: string; phone: string; holding: number; overdue: number; parcels: number; oldest: string; order_ids: string[] }[];
  hubs: { hub_id: string; name: string; cash: number }[]; ledger_balanced: boolean; wallets: Record<string, number>;
}

/** COD reconciliation: cash collected → handed in (MoMo / hub) → banked → paid to vendors, and who is still holding cash. */
export default async function CodPage({ searchParams }: PageProps<"/finance/cod">) {
  const me = await requireRole(["super_admin", "finance", "analyst", "city_admin", "hub_manager"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.to)) ? one(sp.to) : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.from)) ? one(sp.from) : new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await sb.rpc("cod_reconciliation", { p_city: city?.id ?? null, p_from: from, p_to: to });
  const r = data as Rec | null;
  const { data: hubs } = await sb.from("hubs").select("id, name, city_id").eq("is_active", true).order("name");
  const canReceive = has(me, "super_admin", "finance", "city_admin", "hub_manager");
  const isFinance = has(me, "super_admin", "finance");
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>{isFinance ? "Finance" : "COD cash"}</h1><CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
      </div>
      {isFinance && <FinanceTabs at="/finance/cod" />}
      {error && <p className="error">{error.message}</p>}
      {r && <>
        {!r.ledger_balanced && <p className="error">⚠ The ledger does not add up to zero. Stop payouts and contact the developer.</p>}
        <form className="row" style={{ alignItems: "end" }}>
          {city && <input type="hidden" name="city" value={city.id} />}
          <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
          <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
          <div style={{ flex: "0 0 auto" }}><button className="btn secondary">Show</button></div>
        </form>
        <h2>In this period</h2>
        <div className="row">
          {[["Collected by riders", r.period.collected], ["Handed in by MoMo", r.period.handed_in_momo], ["Handed in at hubs", r.period.handed_in_hub], ["Paid to vendors", r.paid_to_vendors]].map(([k, v]) => (
            <div key={String(k)} className="card" style={{ padding: 12 }}><div className="muted">{k}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{ghs(Number(v))}</div></div>))}
        </div>
        <h2>Right now</h2>
        <div className="row">
          {[["Still with riders", r.now.with_riders, false], ["…of which late", r.now.overdue, r.now.overdue > 0], ["Received, not yet paid to vendors", r.now.received_not_paid_out, false], ["…in a payout batch", r.now.in_payout, false]].map(([k, v, bad]) => (
            <div key={String(k)} className="card" style={{ padding: 12, borderColor: bad ? "var(--danger)" : undefined }}><div className="muted">{k}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{ghs(Number(v))}</div></div>))}
        </div>

        <h2>Riders holding cash</h2>
        <table>
          <thead><tr><th>Rider</th><th>Holding</th><th>Late</th><th>Since</th>{canReceive && <th>Received at hub</th>}</tr></thead>
          <tbody>
            {r.riders.map((x) => (
              <tr key={x.rider_id} className={x.overdue ? "bad" : undefined}>
                <td><a href={`/riders/${x.rider_id}`}>{x.name}</a><br /><span className="muted">{x.phone} · {x.parcels} parcel(s)</span></td>
                <td>{ghs(x.holding)}</td><td>{x.overdue ? ghs(x.overdue) : "—"}</td><td>{when(x.oldest)}</td>
                {canReceive && <td><ReceiveCash rider={x.rider_id} orders={x.order_ids} amount={x.holding} hubs={(hubs ?? []).filter((h) => !city || h.city_id === city.id).map((h) => ({ id: h.id, name: h.name }))} /></td>}
              </tr>
            ))}
            {!r.riders.length && <tr><td colSpan={5} className="muted">No rider is holding COD cash. 👍</td></tr>}
          </tbody>
        </table>

        <h2>Cash at hubs</h2>
        <table>
          <thead><tr><th>Hub</th><th>Cash on hand</th>{isFinance && <th>Bank deposit</th>}</tr></thead>
          <tbody>{r.hubs.map((h) => <tr key={h.hub_id}><td>{h.name}</td><td>{ghs(h.cash)}</td>{isFinance && <td>{h.cash > 0 && <BankForm hub={h.hub_id} max={h.cash} />}</td>}</tr>)}</tbody>
        </table>

        {isFinance && <>
          <h2>QCS accounts</h2>
          <table><tbody>{Object.entries(r.wallets).sort().map(([k, v]) => <tr key={k}><td>{k.replaceAll("_", " ").toLowerCase()}</td><td>{ghs(v)}</td></tr>)}</tbody></table>
          <p className="muted">Negative = money QCS holds (Hubtel, hubs, bank); positive = money QCS owes or has earned. Together with every rider, vendor and customer wallet, it always adds up to zero.</p>
        </>}
      </>}
    </>
  );
}
