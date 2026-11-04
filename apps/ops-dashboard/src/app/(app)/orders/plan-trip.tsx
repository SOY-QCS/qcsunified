"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Tick loose e-commerce parcels (same pickup) → one trip, offered to riders straight away. */
export function PlanTrip({ orders }: { orders: { id: string; tracking_number: string; who: string; to: string; created_at: string }[] }) {
  const [sel, setSel] = useState<string[]>([]);
  const a = useRun();
  const router = useRouter();
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 25 ? s : [...s, id]));
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <button className="btn" disabled={!sel.length || a.pending}
          onClick={() => a.run(() => rpcAction("plan_trip", { p_orders: sel }, `Trip made with ${sel.length} parcel(s) and sent to riders.`), (r) => { setSel([]); router.push(`/trips/${r.data}`); })}>
          Make a trip ({sel.length}/25)
        </button>
        <a.Msg />
      </div>
      <table>
        <thead><tr><th></th><th>Booked</th><th>Tracking no.</th><th>Pickup (vendor)</th><th>To</th></tr></thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} onClick={() => toggle(o.id)} style={{ cursor: "pointer", background: sel.includes(o.id) ? "#fbeee4" : undefined }}>
              <td><input type="checkbox" readOnly checked={sel.includes(o.id)} style={{ width: "auto" }} /></td>
              <td>{when(o.created_at)}</td><td>{o.tracking_number}</td><td>{o.who}</td><td>{o.to}</td>
            </tr>
          ))}
          {!orders.length && <tr><td colSpan={5} className="muted">Nothing waiting for a trip. 👍</td></tr>}
        </tbody>
      </table>
    </>
  );
}
