"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";
import { CATEGORIES } from "@/lib/sla";

/** Answer the customer, or write an internal note only staff see. Canned replies fill the box. */
export function ReplyBox({ ticket, canned, note }: { ticket: string; canned: { title: string; body: string }[]; note: string }) {
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const [resolve, setResolve] = useState(false);
  const a = useRun();
  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
        <strong style={{ flex: 1 }}>{internal ? "Internal note (customer never sees it)" : "Reply to the customer"}</strong>
        {canned.length > 0 && <select style={{ maxWidth: 240 }} value="" onChange={(e) => { const c = canned[Number(e.target.value)]; if (c) setText((t) => (t ? t + "\n\n" : "") + c.body); }}>
          <option value="">Canned reply…</option>{canned.map((c, i) => <option key={c.title} value={i}>{c.title}</option>)}
        </select>}
      </div>
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={internal ? "What you found out, who you called…" : "Write your answer"} />
      {!internal && <p className="muted" style={{ margin: "4px 0" }}>{note}</p>}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
        <label style={{ fontWeight: 400, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={internal} onChange={(e) => setInternal(e.target.checked)} />Internal note</label>
        <label style={{ fontWeight: 400, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={resolve} onChange={(e) => setResolve(e.target.checked)} />Mark resolved</label>
        <button className="btn" disabled={a.pending || !text.trim()} onClick={() => a.run(
          () => rpcAction("reply_ticket", { p_ticket: ticket, p_body: text, p_internal: internal, p_attachment: null, p_resolve: resolve }, internal ? "Note saved" : resolve ? "Sent and resolved" : "Sent"),
          () => { setText(""); setResolve(false); })}>{internal ? "Save note" : "Send"}</button>
      </div>
      <a.Msg />
    </div>
  );
}

type V = { assigned_to: string; status: string; priority: string; category: string; tracking: string };

/** Assign, change status/priority/problem type, link a delivery. Changes are audited with the reason. */
export function TicketControls({ ticket, people, v }: { ticket: string; people: { id: string; name: string }[]; v: V }) {
  const [f, setF] = useState(v);
  const [why, setWhy] = useState("");
  const a = useRun();
  const changed = (Object.keys(f) as (keyof V)[]).filter((k) => f[k] !== v[k]);
  return (
    <div className="card">
      <strong>Ticket</strong>
      <label>Assigned to</label>
      <select value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value })}><option value="">Nobody</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <label>Status</label>
      <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
        <option value="open">Open (needs us)</option><option value="pending">Waiting for customer</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select>
      <label>Priority</label>
      <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{["low", "normal", "high", "urgent"].map((p) => <option key={p}>{p}</option>)}</select>
      <label>Problem</label>
      <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <label>Delivery (tracking number)</label>
      <input value={f.tracking} onChange={(e) => setF({ ...f, tracking: e.target.value })} placeholder="ACC-202611041301-KUM" />
      {changed.length > 0 && <>
        <label>Reason (kept in the audit log)</label>
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. needs Finance for the refund" />
        <button className="btn small" style={{ marginTop: 8 }} disabled={a.pending} onClick={() => a.run(() => rpcAction("update_ticket", {
          p_ticket: ticket,
          p: Object.fromEntries([...changed.map((k) => (k === "tracking" ? ["tracking_number", f.tracking] : [k, f[k]])), ["reason", why]]),
        }, "Saved"))}>Save changes</button>
      </>}
      <a.Msg />
    </div>
  );
}
