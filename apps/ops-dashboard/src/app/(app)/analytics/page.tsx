import Link from "next/link";
import { BarList, HeatGrid, Kpi, LineChart, SERVICE_SERIES, StackedBars, fmtGhs, fmtInt, fmtMins, fmtPct } from "@qcs/ui/web";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities, pickCity } from "@/lib/ops";
import { longDay, period, shortDay } from "@/lib/period";
import { Filters } from "./filters";
import { ReportSubscriptions } from "./reports";

const ANALYTICS_ROLES = ["super_admin", "city_admin", "finance", "analyst", "hub_manager"] as const;
const TABS = [["overview", "Overview"], ["riders", "Riders"], ["vendors", "Vendors"], ["map", "Demand map"], ["reports", "Email reports"]] as const;

type K = { orders: number; delivered: number; returned: number; cancelled: number; lost: number; open: number; failed_attempts: number;
  success_pct: number | null; on_time_pct: number | null; revenue: number; avg_pickup_min: number | null; avg_delivery_min: number | null };
const reason = (r: string) => r.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const card = { background: "#fff", border: "1px solid var(--line)", borderRadius: 10, padding: 16, marginBottom: 16 } as const;
const grid = (min: number) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12, marginBottom: 16 }) as const;

export default async function Analytics({ searchParams }: PageProps<"/analytics">) {
  const me = await requireRole([...ANALYTICS_ROLES]);
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? (sp.tab as string) : "overview";
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const p = period(sp);
  const service = typeof sp.service === "string" && ["express", "ecommerce", "intercity"].includes(sp.service) ? sp.service : null;
  return (
    <>
      <h1>Analytics</h1>
      <div className="tabs" style={{ flexWrap: "wrap", marginBottom: 12 }}>
        {TABS.map(([k, l]) => <Link key={k} href={`/analytics?${new URLSearchParams({ ...Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === "string")) as Record<string, string>, tab: k })}`}
          className={`btn small ${tab === k ? "" : "secondary"}`}>{l}</Link>)}
      </div>
      {tab !== "reports" && <Filters cities={cities.map((c) => ({ id: c.id, name: c.name }))} allowAll={global} from={p.from} to={p.to} preset={p.preset} tab={tab}
        showService={tab === "overview" || tab === "map"} />}
      {tab === "overview" && <Overview city={city?.id ?? null} from={p.from} to={p.to} service={service} />}
      {tab === "riders" && <Riders city={city?.id ?? null} from={p.from} to={p.to} />}
      {tab === "vendors" && <Vendors city={city?.id ?? null} from={p.from} to={p.to} />}
      {tab === "map" && <DemandMap city={city?.id ?? cities[0]?.id ?? null} cityName={(city ?? cities[0])?.name ?? ""} picked={!!city} from={p.from} to={p.to} service={service} />}
      {tab === "reports" && <ReportsTab meId={me.id} isSuper={has(me, "super_admin")} cities={cities.map((c) => ({ id: c.id, name: c.name }))} allowAll={global} />}
    </>
  );
}

async function Overview({ city, from, to, service }: { city: string | null; from: string; to: string; service: string | null }) {
  const { data, error } = await (await supabaseServer()).rpc("analytics_overview", { p_city: city, p_from: from, p_to: to, p_service: service });
  if (error) return <p className="error">{error.message}</p>;
  const k = data.kpis as K, pv = data.previous as K;
  const daily = data.daily as { day: string; express: number; ecommerce: number; intercity: number; delivered: number; revenue: number }[];
  const cod = data.cod as { with_riders: number; with_riders_overdue: number; riders_overdue: number; held_by_qcs: number; by_city: { city: string; with_riders: number | null; overdue: number | null; held_by_qcs: number | null }[] };
  const series = service ? SERVICE_SERIES.filter((s) => s.key === service) : SERVICE_SERIES;
  return (
    <>
      <div style={grid(160)}>
        <Kpi label="Orders" value={k.orders} previous={pv.orders} />
        <Kpi label="Delivered" value={k.delivered} previous={pv.delivered} hint={`${k.open} still on the way`} />
        <Kpi label="Success rate" value={k.success_pct} previous={pv.success_pct} format="pct" hint="delivered ÷ (delivered + returned)" />
        <Kpi label="On time" value={k.on_time_pct} previous={pv.on_time_pct} format="pct" hint="of finished deliveries" />
        <Kpi label="Revenue (fees earned)" value={k.revenue} previous={pv.revenue} format="ghs" />
        <Kpi label="Avg Express pickup" value={k.avg_pickup_min} previous={pv.avg_pickup_min} format="mins" upIsGood={false} hint="booking → picked up" />
        <Kpi label="Avg delivery time" value={k.avg_delivery_min} previous={pv.avg_delivery_min} format="mins" upIsGood={false} hint="picked up → delivered (city)" />
        <Kpi label="Failed attempts" value={k.failed_attempts} previous={pv.failed_attempts} upIsGood={false} hint={`${k.returned} returned · ${k.cancelled} cancelled`} />
      </div>

      <div style={card}>
        <h2 style={{ marginTop: 0 }}>Orders per day</h2>
        <StackedBars rows={daily.map((d) => ({ label: shortDay(d.day), title: longDay(d.day), values: { express: d.express, ecommerce: d.ecommerce, intercity: d.intercity } }))} series={series} unit="orders" />
      </div>
      <div style={card}>
        <h2 style={{ marginTop: 0 }}>Revenue per day</h2>
        <LineChart name="Revenue" points={daily.map((d) => ({ label: shortDay(d.day), title: longDay(d.day), value: d.revenue }))} format="ghs" />
        <p className="muted" style={{ margin: "6px 0 0" }}>Fees for deliveries booked that day that were delivered (or returned: 50% fee). Promo discounts already taken off.</p>
      </div>

      <div style={grid(320)}>
        <div style={{ ...card, marginBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>Why deliveries failed</h2>
          <BarList items={(data.failed_reasons as { reason: string; count: number }[]).map((r) => ({ label: reason(r.reason), value: r.count }))} color="#eb6834" empty="No failed attempts in this period." />
        </div>
        <div style={{ ...card, marginBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>COD money not yet with vendors <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>(right now)</span></h2>
          <div style={grid(140)}>
            <Kpi label="With riders" value={cod.with_riders} format="ghs" hint={cod.with_riders_overdue ? `${fmtGhs(cod.with_riders_overdue)} overdue · ${cod.riders_overdue} ${cod.riders_overdue === 1 ? "rider" : "riders"}` : "none overdue"} />
            <Kpi label="Held by QCS (to pay out)" value={cod.held_by_qcs} format="ghs" />
          </div>
          {cod.by_city.length > 1 && <table><thead><tr><th>City</th><th>With riders</th><th>Overdue</th><th>Held by QCS</th></tr></thead>
            <tbody>{cod.by_city.map((c) => <tr key={c.city}><td>{c.city}</td><td>{fmtGhs(c.with_riders ?? 0)}</td><td>{fmtGhs(c.overdue ?? 0)}</td><td>{fmtGhs(c.held_by_qcs ?? 0)}</td></tr>)}</tbody></table>}
          <p style={{ margin: "8px 0 0" }}><Link href="/finance/cod">COD cash details →</Link></p>
        </div>
      </div>

      <div style={{ ...card, marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>By city and service</h2>
        <Table rows={[...(data.by_city as (K & { city: string })[]).map((c) => ({ name: c.city, ...c })), ...(data.by_service as (K & { service: string })[]).map((s) => ({ name: SERVICE_SERIES.find((x) => x.key === s.service)?.label ?? s.service, ...s, isService: true }))]} />
      </div>
    </>
  );
}

function Table({ rows }: { rows: (K & { name: string; isService?: boolean })[] }) {
  return (
    <div style={{ overflowX: "auto" }}><table>
      <thead><tr><th></th><th>Orders</th><th>Delivered</th><th>Returned</th><th>Success</th><th>On time</th><th>Revenue</th><th>Avg pickup (Express)</th><th>Avg delivery</th></tr></thead>
      <tbody>{rows.map((r, i) => (
        <tr key={r.name + i} style={r.isService && !rows[i - 1]?.isService ? { borderTop: "2px solid var(--line)" } : undefined}>
          <td><strong>{r.name}</strong></td><td>{fmtInt(r.orders)}</td><td>{fmtInt(r.delivered)}</td><td>{fmtInt(r.returned)}</td>
          <td>{r.success_pct == null ? "—" : fmtPct(r.success_pct)}</td><td>{r.on_time_pct == null ? "—" : fmtPct(r.on_time_pct)}</td><td>{fmtGhs(r.revenue)}</td>
          <td>{r.avg_pickup_min == null ? "—" : fmtMins(r.avg_pickup_min)}</td><td>{r.avg_delivery_min == null ? "—" : fmtMins(r.avg_delivery_min)}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

type RiderRow = { id: string; name: string; rider_type: string; city: string; rating: number | null; trips: number; delivered: number; failed_attempts: number;
  online_hours: number; busy_hours: number; earnings: number; acceptance_pct: number | null };

async function Riders({ city, from, to }: { city: string | null; from: string; to: string }) {
  const { data, error } = await (await supabaseServer()).rpc("analytics_riders", { p_city: city, p_from: from, p_to: to });
  if (error) return <p className="error">{error.message}</p>;
  const rows = (data as RiderRow[]);
  const util = (r: RiderRow) => (r.online_hours > 0 ? Math.min(100, (r.busy_hours / r.online_hours) * 100) : null);
  const online = rows.reduce((s, r) => s + Number(r.online_hours), 0), busy = rows.reduce((s, r) => s + Number(r.busy_hours), 0);
  const active = rows.filter((r) => r.delivered > 0 || r.online_hours > 0);
  return (
    <>
      <div style={grid(160)}>
        <Kpi label="Riders who worked" value={active.length} hint={`of ${rows.length} active riders`} />
        <Kpi label="Deliveries" value={rows.reduce((s, r) => s + r.delivered, 0)} />
        <Kpi label="Online hours" value={online} format="hours" />
        <Kpi label="Utilisation" value={online ? Math.min(100, (busy / online) * 100) : null} format="pct" hint="time on a job ÷ time online" />
        <Kpi label="Rider earnings" value={rows.reduce((s, r) => s + r.earnings, 0)} format="ghs" />
      </div>
      <div style={card}>
        <h2 style={{ marginTop: 0 }}>Top riders by deliveries</h2>
        <BarList items={active.slice(0, 10).map((r) => ({ label: r.name, value: r.delivered, note: `${fmtGhs(r.earnings)} earned` }))} empty="No deliveries in this period." />
      </div>
      <div style={{ overflowX: "auto" }}><table>
        <thead><tr><th>Rider</th><th>City</th><th>Deliveries</th><th>Failed attempts</th><th>Trips</th><th>Online</th><th>On a job</th><th>Utilisation</th><th>Earnings</th><th>Accepts offers</th><th>Rating</th></tr></thead>
        <tbody>{rows.map((r) => { const u = util(r); return (
          <tr key={r.id}><td><Link href={`/riders/${r.id}`}>{r.name}</Link> <span className="tag">{r.rider_type}</span></td><td>{r.city}</td>
            <td>{r.delivered}</td><td>{r.failed_attempts}</td><td>{r.trips}</td><td>{r.online_hours} h</td><td>{r.busy_hours} h</td>
            <td>{u == null ? "—" : <span title="time on a job ÷ time online"><span style={{ display: "inline-block", width: 50, height: 6, background: "#f1ede8", borderRadius: 3, marginRight: 6, verticalAlign: "middle" }}>
              <span style={{ display: "block", width: `${u}%`, height: 6, background: "#2a78d6", borderRadius: 3 }} /></span>{fmtPct(Math.round(u))}</span>}</td>
            <td>{fmtGhs(r.earnings)}</td><td>{r.acceptance_pct == null ? "—" : `${r.acceptance_pct}%`}</td><td>{r.rating ? `★ ${r.rating}` : "—"}</td></tr>); })}
          {!rows.length && <tr><td colSpan={11} className="muted">No riders.</td></tr>}</tbody>
      </table></div>
      <p className="muted">Online time is recorded from today on (when riders switch Online/Offline in the app). Earnings include bonuses and deductions.</p>
    </>
  );
}

type VendorRow = { id: string; name: string; stage: string; orders: number; delivered: number; success_pct: number | null; revenue: number; cod: number | null; prev_orders: number; change_pct: number | null };

async function Vendors({ city, from, to }: { city: string | null; from: string; to: string }) {
  const { data, error } = await (await supabaseServer()).rpc("analytics_vendors", { p_city: city, p_from: from, p_to: to, p_limit: 50 });
  if (error) return <p className="error">{error.message}</p>;
  const rows = data as VendorRow[];
  return (
    <>
      <div style={card}>
        <h2 style={{ marginTop: 0 }}>Top vendors by orders</h2>
        <BarList items={rows.slice(0, 10).map((v) => ({ label: v.name, value: v.orders, note: v.change_pct == null ? "new" : `${v.change_pct > 0 ? "▲" : v.change_pct < 0 ? "▼" : ""} ${Math.abs(v.change_pct)}%` }))} color="#eb6834" empty="No vendor orders in this period." />
      </div>
      <div style={{ overflowX: "auto" }}><table>
        <thead><tr><th>#</th><th>Vendor</th><th>Orders</th><th>vs previous period</th><th>Delivered</th><th>Success</th><th>Revenue</th><th>COD delivered</th><th>Stage</th></tr></thead>
        <tbody>{rows.map((v, i) => (
          <tr key={v.id}><td>{i + 1}</td><td><Link href={`/vendors/${v.id}`}>{v.name}</Link></td><td>{fmtInt(v.orders)}</td>
            <td>{v.change_pct == null ? <span className="muted">new</span> : <span style={{ color: v.change_pct >= 0 ? "var(--success)" : "var(--danger)" }}>{v.change_pct >= 0 ? "▲" : "▼"} {Math.abs(v.change_pct)}%</span>} <span className="muted">({v.prev_orders})</span></td>
            <td>{fmtInt(v.delivered)}</td><td>{v.success_pct == null ? "—" : fmtPct(v.success_pct)}</td><td>{fmtGhs(v.revenue)}</td><td>{fmtGhs(v.cod ?? 0)}</td><td>{v.stage.replace("_", " ")}</td></tr>))}
          {!rows.length && <tr><td colSpan={9} className="muted">No vendor orders in this period.</td></tr>}</tbody>
      </table></div>
    </>
  );
}

async function DemandMap({ city, cityName, picked, from, to, service }: { city: string | null; cityName: string; picked: boolean; from: string; to: string; service: string | null }) {
  const sb = await supabaseServer();
  const [{ data, error }, { data: zones }] = await Promise.all([
    sb.rpc("analytics_heatmap", { p_city: city, p_from: from, p_to: to, p_service: service }),
    city ? sb.rpc("zones_geojson", { p_city: city }) : Promise.resolve({ data: [] }),
  ]);
  if (error) return <p className="error">{error.message}</p>;
  const outlines = ((zones ?? []) as { name: string; geojson: { type: string; coordinates: number[][][] | number[][][][] } }[]).flatMap((z) => {
    const polys = z.geojson.type === "MultiPolygon" ? (z.geojson.coordinates as number[][][][]) : [z.geojson.coordinates as number[][][]];
    return polys.map((p) => ({ name: z.name, ring: p[0]!.map(([lng, lat]) => [lng, lat] as [number, number]) }));
  });
  const zrows = data.zones as { zone: string; city: string; orders: number; delivered: number; success_pct: number | null }[];
  return (
    <div style={grid(340)}>
      <div style={{ ...card, gridColumn: "span 2", minWidth: 0 }}>
        <h2 style={{ marginTop: 0 }}>Where deliveries go — {cityName}</h2>
        {!picked && <p className="muted" style={{ marginTop: -6 }}>The map shows one city at a time: choose another city above.</p>}
        <HeatGrid cells={data.cells} outlines={outlines} />
      </div>
      <div style={{ ...card, minWidth: 0 }}>
        <h2 style={{ marginTop: 0 }}>By zone</h2>
        <BarList items={zrows.slice(0, 15).map((z) => ({ label: z.zone, value: z.orders, note: z.success_pct == null ? undefined : `${fmtPct(z.success_pct)} success` }))} empty="No drop-offs in this period." />
      </div>
    </div>
  );
}

async function ReportsTab({ meId, isSuper, cities, allowAll }: { meId: string; isSuper: boolean; cities: { id: string; name: string }[]; allowAll: boolean }) {
  const sb = await supabaseServer();
  const [{ data: subs }, { data: staff }, { data: me }] = await Promise.all([
    sb.from("report_subscriptions").select("id, user_id, frequency, city_id, is_active, last_sent_at, profiles!report_subscriptions_user_id_fkey(full_name, email)").order("created_at"),
    isSuper ? sb.from("user_roles").select("user_id, role, profiles!user_roles_user_id_fkey(full_name, email)").in("role", [...ANALYTICS_ROLES]) : Promise.resolve({ data: [] }),
    sb.from("profiles").select("email").eq("id", meId).single(),
  ]);
  type Sub = { id: string; user_id: string; frequency: string; city_id: string | null; is_active: boolean; last_sent_at: string | null; profiles: { full_name: string; email: string | null } | { full_name: string; email: string | null }[] | null };
  const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] ?? null : x);
  const people = [...new Map(((staff ?? []) as { user_id: string; profiles: { full_name: string; email: string | null } | { full_name: string; email: string | null }[] | null }[])
    .map((s) => [s.user_id, one(s.profiles)])).entries()].filter(([, p]) => p?.email).map(([id, p]) => ({ id, name: `${p!.full_name} (${p!.email})` }));
  return (
    <ReportSubscriptions meId={meId} myEmail={me?.email ?? null} isSuper={isSuper} cities={cities} allowAll={allowAll} people={people}
      subs={((subs ?? []) as Sub[]).map((s) => ({ id: s.id, user_id: s.user_id, frequency: s.frequency, city_id: s.city_id, is_active: s.is_active, last_sent_at: s.last_sent_at,
        who: one(s.profiles)?.full_name ?? "", email: one(s.profiles)?.email ?? null }))} />
  );
}
