"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

const ghs = (p: number) => `GHS ${(p / 100).toFixed(2)}`;

/** Count the cash, pick the hub, record it. All the rider's parcels at once (part payments are not accepted). */
export function ReceiveCash({ rider, orders, amount, hubs }: { rider: string; orders: string[]; amount: number; hubs: { id: string; name: string }[] }) {
  const a = useRun();
  const [hub, setHub] = useState(hubs[0]?.id ?? "");
  const [note, setNote] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <select value={hub} onChange={(e) => setHub(e.target.value)} style={{ maxWidth: 160 }}>{hubs.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
      <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 140 }} />
      <button className="btn small" disabled={a.pending || !hub} onClick={() => { if (window.confirm(`Confirm you counted ${ghs(amount)} in cash?`))
        a.run(() => rpcAction("receive_cod_cash", { p_rider: rider, p_orders: orders, p_hub: hub, p_note: note || null }, `${ghs(amount)} recorded as received.`)); }}>
        Received {ghs(amount)}</button>
      <a.Msg />
    </div>
  );
}

export function BankForm({ hub, max }: { hub: string; max: number }) {
  const a = useRun();
  const [amt, setAmt] = useState(String(max / 100));
  const [slip, setSlip] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} style={{ maxWidth: 110 }} />
      <input placeholder="Deposit slip no." value={slip} onChange={(e) => setSlip(e.target.value)} style={{ maxWidth: 150 }} />
      <button className="btn small" disabled={a.pending || slip.trim().length < 3 || !Number(amt)}
        onClick={() => a.run(() => rpcAction("bank_hub_cash", { p_hub: hub, p_amount: Math.round(Number(amt) * 100), p_reference: slip }, "Bank deposit recorded."))}>Banked</button>
      <a.Msg />
    </div>
  );
}
