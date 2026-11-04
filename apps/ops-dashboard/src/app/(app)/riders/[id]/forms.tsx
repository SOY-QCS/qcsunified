"use client";
import { useState } from "react";
import { rpcAction, saveRiderMoney } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

export function MoneyForm({ rider, commission, limit, fleet }: { rider: string; commission: number | null; limit: number | null; fleet: boolean }) {
  const a = useRun();
  const [pct, setPct] = useState(commission == null ? "" : String(commission / 100));
  const [cap, setCap] = useState(limit == null ? "" : String(limit / 100));
  return (
    <div className="card">
      <strong>Pay and cash</strong>
      <div className="row">
        {!fleet && <div><label>Commission (% of delivery fee)</label><input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="Default from Settings" /></div>}
        <div><label>Cash-on-delivery limit (GHS)</label><input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="Empty = no limit" /></div>
      </div>
      <button className="btn small" style={{ marginTop: 8 }} disabled={a.pending}
        onClick={() => a.run(() => saveRiderMoney(rider, { commission_pct: pct.trim() === "" ? null : Number(pct), cod_limit_ghs: cap.trim() === "" ? null : Number(cap) }))}>Save</button>
      <a.Msg />
    </div>
  );
}

export function DocReview({ doc, expires }: { doc: string; expires: string | null }) {
  const a = useRun();
  const [exp, setExp] = useState(expires ?? "");
  const [note, setNote] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <input type="date" value={exp} onChange={(e) => setExp(e.target.value)} style={{ maxWidth: 160 }} title="Expiry date" />
      <button className="btn small" disabled={a.pending} onClick={() => a.run(() => rpcAction("review_rider_document", { p_doc: doc, p_approve: true, p_expires_on: exp || null }, "Approved"))}>Approve</button>
      <input placeholder="Why refused" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 160 }} />
      <button className="btn small danger" disabled={a.pending || note.trim().length < 3} onClick={() => a.run(() => rpcAction("review_rider_document", { p_doc: doc, p_approve: false, p_note: note }, "Refused"))}>Refuse</button>
      <a.Msg />
    </div>
  );
}

export function Adjustment({ rider }: { rider: string }) {
  const a = useRun();
  const [kind, setKind] = useState<"bonus" | "deduction">("bonus");
  const [amt, setAmt] = useState("");
  const [why, setWhy] = useState("");
  return (
    <div className="card">
      <strong>Bonus or deduction</strong>
      <div className="row" style={{ alignItems: "end" }}>
        <div><label>Type</label><select value={kind} onChange={(e) => setKind(e.target.value as "bonus" | "deduction")}><option value="bonus">Bonus</option><option value="deduction">Deduction</option></select></div>
        <div><label>Amount (GHS)</label><input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /></div>
        <div><label>Reason (the rider sees it)</label><input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. Rider of the week" /></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn" disabled={a.pending || !(Number(amt) > 0) || why.trim().length < 5}
          onClick={() => a.run(() => rpcAction("add_rider_adjustment", { p_rider: rider, p_kind: kind, p_amount: Math.round(Number(amt) * 100), p_reason: why }, "Added to the rider's earnings."), () => { setAmt(""); setWhy(""); })}>Add</button></div>
      </div>
      <a.Msg />
    </div>
  );
}
