"use client";
import { useState } from "react";
import { useRun } from "@/components/run";
import { rpcAction } from "@/lib/rpc-action";

/** Dismiss or confirm a fraud flag, always with a note (it goes in the audit log). */
export function FraudReview({ id }: { id: string }) {
  const a = useRun();
  const [note, setNote] = useState("");
  const go = (decision: "dismissed" | "confirmed") =>
    a.run(() => rpcAction("review_fraud_flag", { p_flag: id, p_decision: decision, p_note: note }, decision === "dismissed" ? "Dismissed" : "Confirmed", "/fraud"));
  const short = note.trim().length < 3;
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      <textarea rows={2} placeholder="What did you check, and what did you decide? (e.g. called the customer: family phone)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn small secondary" disabled={a.pending || short} onClick={() => go("dismissed")}>Dismiss: it&apos;s fine</button>
        <button className="btn small danger" disabled={a.pending || short} onClick={() => go("confirmed")}>Confirm: fraud</button>
      </div>
      <a.Msg />
    </div>
  );
}
