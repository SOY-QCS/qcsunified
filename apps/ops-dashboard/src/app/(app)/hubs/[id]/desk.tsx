"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

/** Print labels (opens the PDF) and mark them printed, so the parcels can be bagged. */
export function LabelDesk({ orders }: { orders: { id: string; tracking_number: string; to: string }[] }) {
  const a = useRun();
  const [sel, setSel] = useState<string[]>(orders.map((o) => o.id).slice(0, 100));
  if (!orders.length) return <p className="muted">All parcels in the hub have labels. 👍</p>;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <button className="btn" disabled={!sel.length || a.pending} onClick={() => {
          window.open(`/api/hub-docs?labels=${sel.join(",")}`, "_blank");
          a.run(() => rpcAction("mark_labels_printed", { p_orders: sel }, `${sel.length} label(s) sent to print and marked printed.`));
        }}>Print {sel.length} label(s) (4×6)</button>
        <button className="btn secondary small" onClick={() => setSel(sel.length ? [] : orders.map((o) => o.id))}>{sel.length ? "Clear" : "Select all"}</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{orders.map((o) => (
        <label key={o.id} className="tag" style={{ cursor: "pointer", fontWeight: 400 }}>
          <input type="checkbox" style={{ width: "auto", marginRight: 4 }} checked={sel.includes(o.id)} onChange={() => setSel((s) => (s.includes(o.id) ? s.filter((x) => x !== o.id) : [...s, o.id]))} />
          {o.tracking_number} → {o.to}</label>))}</div>
      <a.Msg />
    </div>
  );
}

export function NewBag({ hub, hubs }: { hub: string; hubs: { id: string; name: string }[] }) {
  const a = useRun();
  const [to, setTo] = useState(hubs[0]?.id ?? "");
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
      <select value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 220 }}>{hubs.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
      <button className="btn small secondary" disabled={a.pending || !to} onClick={() => a.run(() => rpcAction("open_bag", { p_hub: hub, p_dest_hub: to }, "Bag opened — print its tag."))}>Open a bag to it</button>
      <a.Msg />
    </div>
  );
}

/** Doorstep parcels waiting in the hub → a delivery trip (pickup = this hub), offered to riders. */
export function LastMile({ hub, orders }: { hub: string; orders: { id: string; tracking_number: string; to: string }[] }) {
  const a = useRun();
  const [sel, setSel] = useState<string[]>([]);
  if (!orders.length) return <p className="muted">Nothing waiting. 👍</p>;
  return (
    <div>
      <table><tbody>{orders.map((o) => (
        <tr key={o.id} onClick={() => setSel((s) => (s.includes(o.id) ? s.filter((x) => x !== o.id) : s.length < 25 ? [...s, o.id] : s))} style={{ cursor: "pointer", background: sel.includes(o.id) ? "#fbeee4" : undefined }}>
          <td><input type="checkbox" readOnly checked={sel.includes(o.id)} style={{ width: "auto" }} /></td><td>{o.tracking_number}</td><td>{o.to}</td></tr>))}</tbody></table>
      <button className="btn" style={{ marginTop: 8 }} disabled={!sel.length || a.pending}
        onClick={() => a.run(() => rpcAction("plan_last_mile", { p_hub: hub, p_orders: sel }, `Delivery trip made with ${sel.length} parcel(s) and offered to riders.`), () => setSel([]))}>
        Make a delivery trip ({sel.length}/25)</button>
      <a.Msg />
    </div>
  );
}

export function StockAdjust({ hub, skus }: { hub: string; skus: { id: string; label: string; locations: string[] }[] }) {
  const a = useRun();
  const [f, setF] = useState({ sku: skus[0]?.id ?? "", loc: skus[0]?.locations[0] ?? "RECEIVING", change: "", why: "" });
  return (
    <div className="card">
      <strong>Correct stock</strong> <span className="muted">(after a count, damage or loss — recorded with your name and reason)</span>
      <div className="row" style={{ alignItems: "end" }}>
        <div><label>Product</label><select value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })}>{skus.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
        <div><label>Shelf</label><input value={f.loc} onChange={(e) => setF({ ...f, loc: e.target.value.toUpperCase() })} /></div>
        <div><label>Change (+ or −)</label><input inputMode="numeric" value={f.change} onChange={(e) => setF({ ...f, change: e.target.value })} placeholder="-2" /></div>
        <div><label>Reason</label><input value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} placeholder="Monthly count" /></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn" disabled={a.pending || !Number(f.change) || f.why.trim().length < 5}
          onClick={() => a.run(() => rpcAction("adjust_stock", { p_hub: hub, p_sku: f.sku, p_location: f.loc, p_change: Number(f.change), p_reason: f.why }, "Stock corrected."))}>Save</button></div>
      </div>
      <a.Msg />
    </div>
  );
}

export function Rates({ hub, pickPack, storage }: { hub: string; pickPack: number; storage: number }) {
  const a = useRun();
  const [pp, setPp] = useState(String(pickPack / 100));
  const [st, setSt] = useState(String(storage / 100));
  return (
    <div className="card">
      <strong>Fulfilment fees at this hub</strong>
      <div className="row" style={{ alignItems: "end" }}>
        <div><label>Pick &amp; pack per order (GHS)</label><input inputMode="decimal" value={pp} onChange={(e) => setPp(e.target.value)} /></div>
        <div><label>Storage per item per month (GHS)</label><input inputMode="decimal" value={st} onChange={(e) => setSt(e.target.value)} /></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn" disabled={a.pending}
          onClick={() => a.run(() => rpcAction("set_hub_fulfilment_rates", { p_hub: hub, p_pick_pack: Math.round(Number(pp) * 100), p_storage: Math.round(Number(st) * 100) }, "Rates saved."))}>Save</button></div>
      </div>
      <a.Msg />
    </div>
  );
}
