import Link from "next/link";
import { PRESETS, longDay, period, shortDay } from "@qcs/types";
import { BarList, Kpi, StackedBars, fmtGhs, fmtInt, fmtPct } from "@qcs/ui/web";
import { supabaseServer } from "@/lib/supabase/server";
import { currentVendor } from "../vendor";

type K = { orders: number; delivered: number; returned: number; cancelled: number; open: number; failed_attempts: number; success_pct: number | null;
  on_time_pct: number | null; avg_delivery_hours: number | null; delivery_spend: number | null; cod_collected: number | null };
const card = { background: "#fff", border: "1px solid var(--line)", borderRadius: 10, padding: 16, marginBottom: 16 } as const;
const grid = (min: number) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12, marginBottom: 16 }) as const;
const SERVICE: Record<string, string> = { express: "Express", ecommerce: "Same-day (e-commerce)", intercity: "Inter-city", scheduled: "Scheduled" };
const FEE: Record<string, string> = { fulfilment_fee: "Pick & pack", storage_fee: "Storage", cs_fee: "Customer service" };
const reason = (r: string) => r.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

/** The business's own numbers: volumes, success rate, spend, COD. */
export default async function VendorAnalytics({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { vendor } = await currentVendor();
  const p = period(sp);
  const { data, error } = await (await supabaseServer()).rpc("vendor_analytics", { p_vendor: vendor.id, p_from: p.from, p_to: p.to });
  const k = data?.kpis as K | undefined, pv = data?.previous as { orders: number; delivered: number; success_pct: number | null } | undefined;
  const daily = (data?.daily ?? []) as { day: string; orders: number; delivered: number; not_delivered: number }[];
  return (
    <>
      <h1>Analytics</h1>
      <form style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        {PRESETS.map(([key, l]) => <Link key={key} href={`/analytics?p=${key}`} className={`btn small ${p.preset === key ? "" : "secondary"}`}>{l}</Link>)}
        <input type="date" name="from" defaultValue={p.from} style={{ maxWidth: 150 }} aria-label="From" /> →
        <input type="date" name="to" defaultValue={p.to} style={{ maxWidth: 150 }} aria-label="To" />
        <button className="btn small secondary">Show</button>
      </form>
      {error && <p className="error">{error.message}</p>}
      {k && pv && <>
        <div style={grid(160)}>
          <Kpi label="Orders" value={k.orders} previous={pv.orders} />
          <Kpi label="Delivered" value={k.delivered} previous={pv.delivered} hint={`${k.open} on the way · ${k.cancelled} cancelled`} />
          <Kpi label="Success rate" value={k.success_pct} previous={pv.success_pct} format="pct" hint={`${k.returned} returned to you`} />
          <Kpi label="On time" value={k.on_time_pct} format="pct" />
          <Kpi label="Avg booking → delivered" value={k.avg_delivery_hours} format="hours" upIsGood={false} />
          {data.money && <>
            <Kpi label="Delivery spend" value={k.delivery_spend} format="ghs" hint="delivered + 50% on returns" />
            <Kpi label="COD collected" value={k.cod_collected} format="ghs" hint={`${fmtGhs(data.cod_paid_out)} paid out · ${fmtGhs(data.cod_waiting)} on its way to you`} />
          </>}
        </div>

        <div style={card}>
          <h2 style={{ marginTop: 0 }}>Orders per day</h2>
          <StackedBars rows={daily.map((d) => ({ label: shortDay(d.day), title: longDay(d.day), values: { delivered: d.delivered, failed: d.not_delivered, other: d.orders - d.delivered - d.not_delivered } }))}
            series={[{ key: "delivered", label: "Delivered", color: "#2a78d6" }, { key: "failed", label: "Returned", color: "#eb6834" }, { key: "other", label: "On the way / cancelled", color: "#1baf7a" }]} unit="orders" />
        </div>

        <div style={grid(300)}>
          <div style={{ ...card, marginBottom: 0 }}>
            <h2 style={{ marginTop: 0 }}>Why deliveries failed</h2>
            <BarList items={(data.failed_reasons as { reason: string; count: number }[]).map((r) => ({ label: reason(r.reason), value: r.count }))} color="#eb6834"
              empty="No failed attempts in this period." />
            <p className="muted" style={{ margin: "8px 0 0" }}>Tip: a correct phone number and a landmark cut most failed attempts.</p>
          </div>
          <div style={{ ...card, marginBottom: 0 }}>
            <h2 style={{ marginTop: 0 }}>Where your orders go</h2>
            <BarList items={(data.top_areas as { area: string; city: string | null; orders: number; success_pct: number | null }[]).map((a) => ({ label: `${a.area}${a.city ? `, ${a.city}` : ""}`, value: a.orders,
              note: a.success_pct == null ? undefined : `${fmtPct(a.success_pct)} delivered` }))} empty="No orders in this period." />
          </div>
        </div>

        <div style={grid(300)}>
          <div style={{ ...card, marginBottom: 0 }}>
            <h2 style={{ marginTop: 0 }}>By service</h2>
            <table><tbody>{(data.by_service as { service: string; orders: number; success_pct: number | null }[]).map((s) => (
              <tr key={s.service}><td>{SERVICE[s.service] ?? s.service}</td><td>{fmtInt(s.orders)} orders</td><td>{s.success_pct == null ? "—" : `${fmtPct(s.success_pct)} delivered`}</td></tr>))}
              {!(data.by_service as unknown[]).length && <tr><td className="muted">No orders in this period.</td></tr>}</tbody></table>
          </div>
          {data.money && Object.keys(data.other_fees ?? {}).length > 0 && <div style={{ ...card, marginBottom: 0 }}>
            <h2 style={{ marginTop: 0 }}>Other fees</h2>
            <table><tbody>{Object.entries(data.other_fees as Record<string, number>).map(([kind, amt]) => <tr key={kind}><td>{FEE[kind] ?? kind}</td><td>{fmtGhs(amt)}</td></tr>)}</tbody></table>
          </div>}
        </div>
        {!data.money && <p className="muted">Money figures are only shown to people with wallet access on this account.</p>}
        <p className="muted">Need the details? <Link href="/orders">Orders</Link> · <Link href="/wallet">Wallet statement</Link></p>
      </>}
    </>
  );
}
