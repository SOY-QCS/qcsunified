"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

type Opt = { id: string; label: string };

export function TripTools({ tripId, hasRider, free, orders, others }: { tripId: string; hasRider: boolean; free: Opt[]; orders: (Opt & { movable: boolean })[]; others: Opt[] }) {
  const a = useRun();
  const router = useRouter();
  const [rider, setRider] = useState("");
  const [why, setWhy] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const reasonOk = why.trim().length >= 5;
  return (
    <div>
      <strong>{hasRider ? "Give to another rider" : "Assign a rider"}</strong>
      <div className="row" style={{ alignItems: "end" }}>
        <div><label>Rider (free riders in this city)</label>
          <select value={rider} onChange={(e) => setRider(e.target.value)}><option value="">Choose…</option>{free.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></div>
        <div><label>Reason {hasRider ? "(required)" : "(optional)"}</label><input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. Bike broke down at Shiashie" /></div>
        <div style={{ flex: "0 0 auto", display: "flex", gap: 6 }}>
          <button className="btn small" disabled={!rider || a.pending || (hasRider && !reasonOk)}
            onClick={() => a.run(() => hasRider ? rpcAction("reassign_trip", { p_trip: tripId, p_rider: rider, p_reason: why }, "Reassigned. Both riders were told.")
                                                : rpcAction("assign_trip", { p_trip: tripId, p_rider: rider }, "Assigned."))}>{hasRider ? "Reassign" : "Assign"}</button>
          {hasRider && <button className="btn small danger" disabled={!reasonOk || a.pending}
            onClick={() => a.run(() => rpcAction("unassign_trip", { p_trip: tripId, p_reason: why }, "Rider removed; offering to others."))}>Take rider off</button>}
        </div>
      </div>
      <p className="muted">After pickup, reassigning means the new rider collects the parcels from the old one. It&apos;s recorded with your reason.</p>

      {orders.length > 1 && <>
        <strong>Split</strong>
        <p className="muted">Tick parcels to move to a new trip of their own (only parcels not yet collected).</p>
        {orders.map((o) => <label key={o.id} style={{ fontWeight: 400, display: "flex", gap: 6 }}>
          <input type="checkbox" style={{ width: "auto" }} disabled={!o.movable} checked={sel.includes(o.id)} onChange={() => setSel((s) => (s.includes(o.id) ? s.filter((x) => x !== o.id) : [...s, o.id]))} />{o.label}</label>)}
        <button className="btn small secondary" disabled={!sel.length || a.pending}
          onClick={() => a.run(() => rpcAction("split_trip", { p_trip: tripId, p_orders: sel }, "Split. The new trip is being offered to riders."), (r) => router.push(`/trips/${r.data}`))}>Move {sel.length || ""} to a new trip</button>
      </>}

      {others.length > 0 && <>
        <p style={{ marginTop: 16 }}><strong>Merge</strong></p>
        <p className="muted">Bring another trip&apos;s parcels into this one (same pickup within 300 m, nothing collected yet, 25 parcels max).</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <select value={other} onChange={(e) => setOther(e.target.value)} style={{ maxWidth: 420 }}><option value="">Choose a trip…</option>{others.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
          <button className="btn small secondary" disabled={!other || a.pending} onClick={() => a.run(() => rpcAction("merge_trips", { p_into: tripId, p_from: other }, "Merged into this trip."))}>Merge into this trip</button>
        </div>
      </>}
      <a.Msg />
    </div>
  );
}
