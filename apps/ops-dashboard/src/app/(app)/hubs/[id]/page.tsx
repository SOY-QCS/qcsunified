import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, has, statusText, when } from "@/lib/ops";
import { AutoRefresh } from "../../dispatch/forms";
import { RpcButton } from "@/components/run";
import { LabelDesk, LastMile, NewBag, Rates, StockAdjust } from "./desk";

interface Board {
  hub: { id: string; name: string; code: string; capacity: number };
  counts: Record<string, number>;
  stuck: { tracking_number: string; status: string; since: string; dest: string | null }[];
  manifests: { id: string; code: string; status: string; from: string; to: string; bus: string | null; vehicle: string | null; waybill: string | null; driver_phone: string | null;
               departed_at: string | null; sent: number; received: number; late: boolean; bags: number }[];
  bags: { id: string; code: string; status: string; to: string; items: number }[];
  scans: { at: string; kind: string; code: string; ok: boolean; by: string | null; error: string | null }[];
}

/** The hub desk (Hub Manager / hub office PC): labels, bags, buses, last-mile trips, collection shelf, stock, and who scanned what. */
export default async function HubDesk({ params }: PageProps<"/hubs/[id]">) {
  const me = await requireRole(["super_admin", "city_admin", "hub_manager", "dispatcher", "analyst", "finance"]);
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: board, error } = await sb.rpc("hub_board", { p_hub: id });
  if (error || !board) notFound();
  const b = board as Board;
  const [{ data: labels }, { data: waiting }, { data: shelf }, { data: stock }, { data: hub }] = await Promise.all([
    sb.from("orders").select("id, tracking_number, recipient_name, dest:hubs!orders_dest_hub_id_fkey(code)").eq("current_hub_id", id).eq("status", "AT_HUB").is("label_printed_at", null).order("created_at").limit(300),
    sb.from("orders").select("id, tracking_number, recipient_name, dropoff_address_text, trip_id").eq("current_hub_id", id).in("status", ["ARRIVED_DEST_HUB", "AT_HUB"]).eq("intercity_option", "doorstep").order("created_at").limit(300),
    sb.from("orders").select("id, tracking_number, recipient_name, recipient_phone, updated_at").eq("current_hub_id", id).eq("status", "READY_FOR_COLLECTION").order("updated_at").limit(300),
    sb.from("stock_levels").select("vendor_id, sku_id, sku, name, on_hand, reserved, available, low_stock_at, locations").eq("hub_id", id).order("name"),
    sb.from("hubs").select("pick_pack_fee, storage_fee_per_unit, city_id").eq("id", id).single(),
  ]);
  const { data: trips } = await sb.from("trips").select("id, status").in("id", (waiting ?? []).map((w) => w.trip_id).filter(Boolean) as string[]);
  const free = (waiting ?? []).filter((w) => !w.trip_id || trips?.find((t) => t.id === w.trip_id && ["COMPLETED", "CANCELLED"].includes(t.status)));
  const { data: vendors } = (stock ?? []).length ? await sb.from("vendors").select("id, business_name").in("id", [...new Set((stock ?? []).map((s) => s.vendor_id))]) : { data: [] };
  const { data: otherHubs } = await sb.from("hubs").select("id, name").eq("is_active", true).neq("id", id).order("name");
  const c = b.counts;
  const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] : x) ?? null;
  const canPlan = has(me, "super_admin", "city_admin", "dispatcher", "hub_manager");
  return (
    <>
      <AutoRefresh />
      <p><Link href="/hubs">← Hubs</Link></p>
      <h1>{b.hub.name} <span className="tag">{b.hub.code}</span></h1>
      <div className="row">
        {[["In the hub", `${c.in_hub ?? 0} / ${b.hub.capacity}`], ["Coming in (riders)", c.coming_in], ["Labels to print", c.labels_to_print], ["To sort", c.to_sort], ["In bags", c.in_bags],
          ["On the road here", c.on_the_road_to_here], ["For delivery", c.for_last_mile], ["For collection", c.for_collection]].map(([k, v]) => (
          <div key={String(k)} className="card" style={{ padding: 10, flex: "1 1 120px" }}><div className="muted">{k}</div><div style={{ fontSize: 22, fontWeight: 800 }}>{v ?? 0}</div></div>))}
      </div>

      {b.stuck.length > 0 && <>
        <h2 style={{ color: "var(--danger)" }}>Stuck in this hub ({b.stuck.length})</h2>
        <table><tbody>{b.stuck.map((s) => <tr key={s.tracking_number} className="bad"><td><Link href={`/orders/${s.tracking_number}`}>{s.tracking_number}</Link></td><td>{statusText(s.status)}</td><td>since {when(s.since)}</td><td>{s.dest}</td></tr>)}</tbody></table>
      </>}

      <h2>Labels to print ({labels?.length ?? 0})</h2>
      <LabelDesk orders={(labels ?? []).map((o) => ({ id: o.id, tracking_number: o.tracking_number, to: one(o.dest as unknown as { code: string } | null)?.code ?? "local" }))} />

      <h2>Bags</h2>
      <table>
        <thead><tr><th>Bag</th><th>To</th><th>Parcels</th><th>Status</th><th></th></tr></thead>
        <tbody>{b.bags.map((g) => <tr key={g.id}><td>{g.code}</td><td>{g.to}</td><td>{g.items}</td><td>{g.status}</td>
          <td><a className="btn small secondary" href={`/api/hub-docs?bags=${g.id}`} target="_blank" rel="noreferrer">Print tag</a></td></tr>)}
          {!b.bags.length && <tr><td colSpan={5} className="muted">No open bags. Handlers open bags in the app, or here:</td></tr>}</tbody>
      </table>
      <NewBag hub={id} hubs={otherHubs ?? []} />

      <h2>Buses (manifests)</h2>
      <table>
        <thead><tr><th>Manifest</th><th>Route</th><th>Bus</th><th>Parcels</th><th>Status</th><th></th></tr></thead>
        <tbody>{b.manifests.map((m) => (
          <tr key={m.id} className={m.late ? "bad" : undefined}>
            <td>{m.code}</td><td>{m.from} → {m.to}</td>
            <td>{m.bus ? `${m.bus} · ${m.vehicle}` : "—"}{m.waybill && <><br /><span className="muted">waybill {m.waybill} · {m.driver_phone}</span></>}</td>
            <td>{m.sent ? `${m.received}/${m.sent} received` : `${m.bags} bag(s)`}</td>
            <td>{m.status}{m.departed_at ? ` ${when(m.departed_at)}` : ""}{m.late ? " · LATE" : ""}</td>
            <td><a className="btn small secondary" href={`/api/hub-docs?manifest=${m.id}`} target="_blank" rel="noreferrer">Print</a></td>
          </tr>))}
          {!b.manifests.length && <tr><td colSpan={6} className="muted">No buses in the last two days.</td></tr>}</tbody>
      </table>
      <p className="muted">Hub handlers load buses and receive them with the phone (Hub mode). Print the manifest for the driver to sign.</p>

      <h2>Waiting for a delivery rider ({free.length})</h2>
      {canPlan ? <LastMile hub={id} orders={free.map((o) => ({ id: o.id, tracking_number: o.tracking_number, to: `${o.recipient_name} · ${o.dropoff_address_text ?? ""}` }))} />
               : <p className="muted">Dispatch plans these.</p>}

      <h2>Collection shelf ({shelf?.length ?? 0})</h2>
      <table><tbody>{(shelf ?? []).map((o) => <tr key={o.id}><td><Link href={`/orders/${o.tracking_number}`}>{o.tracking_number}</Link></td><td>{o.recipient_name} · {o.recipient_phone}</td><td>since {when(o.updated_at)}</td>
        <td><RpcButton fn="resend_delivery_code" args={{ p_order: o.id }} done="New code sent by SMS." label="Resend code" kind="secondary" /></td></tr>)}
        {!shelf?.length && <tr><td className="muted">Nothing waiting for collection.</td></tr>}</tbody></table>

      <h2>Fulfilment stock</h2>
      <table>
        <thead><tr><th>Vendor</th><th>Product</th><th>Shelves</th><th>On hand</th><th>Reserved</th><th>Available</th></tr></thead>
        <tbody>{(stock ?? []).map((s) => <tr key={s.sku_id} className={s.available <= s.low_stock_at ? "bad" : undefined}>
          <td>{vendors?.find((v) => v.id === s.vendor_id)?.business_name}</td><td>{s.name}<br /><span className="muted">{s.sku}</span></td>
          <td>{Object.entries((s.locations ?? {}) as Record<string, number>).map(([l, n]) => `${l} (${n})`).join(", ")}</td><td>{s.on_hand}</td><td>{s.reserved}</td><td>{s.available}</td></tr>)}
          {!stock?.length && <tr><td colSpan={6} className="muted">No vendor stock here.</td></tr>}</tbody>
      </table>
      {has(me, "super_admin", "city_admin", "hub_manager") && (stock ?? []).length > 0 &&
        <StockAdjust hub={id} skus={(stock ?? []).map((s) => ({ id: s.sku_id, label: `${s.name} (${s.sku})`, locations: Object.keys((s.locations ?? {}) as object) }))} />}
      {has(me, "super_admin", "city_admin", "finance") && hub && <Rates hub={id} pickPack={hub.pick_pack_fee} storage={hub.storage_fee_per_unit} />}
      {!has(me, "super_admin", "city_admin", "finance") && hub && <p className="muted">Fees here: pick &amp; pack {ghs(hub.pick_pack_fee)} per order · storage {ghs(hub.storage_fee_per_unit)} per item per month.</p>}

      <h2>Who scanned what</h2>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Scan</th><th>Code</th><th>Result</th></tr></thead>
        <tbody>{b.scans.map((s, i) => <tr key={i} className={s.ok ? undefined : "bad"}><td>{when(s.at)}</td><td>{s.by ?? "—"}</td><td>{s.kind}</td><td>{s.code}</td><td>{s.ok ? "ok" : s.error}</td></tr>)}</tbody>
      </table>
    </>
  );
}
