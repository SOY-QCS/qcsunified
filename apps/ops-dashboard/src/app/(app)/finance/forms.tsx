"use client";
import { useState, useTransition } from "react";
import { approvePayout, refund, rejectPayout, type Result } from "./actions";

function useRun() {
  const [pending, start] = useTransition();
  const [r, setR] = useState<Result | null>(null);
  return { pending, run: (fn: () => Promise<Result>) => start(async () => setR(await fn())), Msg: () => (r ? <p className={r.ok ? "notice" : "error"}>{r.message}</p> : null) };
}

export function PayoutActions({ id }: { id: string }) {
  const a = useRun();
  const [reason, setReason] = useState("");
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn small" disabled={a.pending} onClick={() => a.run(() => approvePayout(id))}>Approve &amp; send</button>
        <input placeholder="Reason to reject" value={reason} onChange={(e) => setReason(e.target.value)} style={{ maxWidth: 200 }} />
        <button className="btn danger small" disabled={a.pending || !reason} onClick={() => a.run(() => rejectPayout(id, reason))}>Reject</button>
      </div>
      <a.Msg />
    </div>
  );
}

export function RefundForm() {
  const a = useRun();
  const [f, setF] = useState({ tn: "", ghs: "", why: "" });
  return (
    <div className="card">
      <strong>Refund an order</strong>
      <p className="muted">Money goes back to whoever paid: the customer&apos;s wallet (credit stays credit) or the business wallet. Recorded in the audit log.</p>
      <div className="row">
        <div><label>Tracking number</label><input value={f.tn} onChange={(e) => setF({ ...f, tn: e.target.value })} placeholder="ACC-202611041301-KUM" /></div>
        <div><label>Amount (GHS)</label><input inputMode="decimal" value={f.ghs} onChange={(e) => setF({ ...f, ghs: e.target.value })} /></div>
        <div><label>Reason</label><input value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} placeholder="e.g. Rider 2 hours late" /></div>
      </div>
      <button className="btn" style={{ marginTop: 12 }} disabled={a.pending} onClick={() => a.run(() => refund(f.tn, Number(f.ghs), f.why))}>Refund</button>
      <a.Msg />
    </div>
  );
}
