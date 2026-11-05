"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

const OUTCOMES = [["confirmed", "Confirmed"], ["no_answer", "No answer"], ["rescheduled", "Rescheduled"], ["cancelled_by_customer", "Customer cancelled"], ["question", "Answered a question"], ["other", "Other"]];

/** Log a call/chat, or send a message from the QCS number on the vendor's behalf. */
export function ContactTools({ order, vendor }: { order: string; vendor: string }) {
  const [mode, setMode] = useState<"" | "log" | "msg">("");
  const [kind, setKind] = useState("call");
  const [outcome, setOutcome] = useState("confirmed");
  const [text, setText] = useState("");
  const a = useRun();
  if (!mode) return <div style={{ display: "flex", gap: 6 }}><button className="btn small" onClick={() => setMode("log")}>Log call</button><button className="btn small secondary" onClick={() => setMode("msg")}>Message</button></div>;
  return (
    <div style={{ minWidth: 260 }}>
      {mode === "log" ? <>
        <div style={{ display: "flex", gap: 6 }}>
          <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="call">Call</option><option value="whatsapp">WhatsApp chat</option><option value="sms">SMS</option></select>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Note (what they said)" style={{ marginTop: 6 }} />
        <button className="btn small" style={{ marginTop: 6 }} disabled={a.pending} onClick={() => a.run(() => rpcAction("log_contact", { p_order: order, p_kind: kind, p_outcome: outcome, p_note: text || null }, "Logged"), () => { setMode(""); setText(""); })}>Save</button>
      </> : <>
        <p className="muted" style={{ margin: "0 0 4px" }}>Sent as: &quot;QCS on behalf of {vendor}: …&quot;</p>
        <textarea rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your order arrives this afternoon…" />
        <button className="btn small" style={{ marginTop: 6 }} disabled={a.pending || text.trim().length < 5} onClick={() => a.run(() => rpcAction("cs_message", { p_order: order, p_text: text }, "Message sent"), () => { setMode(""); setText(""); })}>Send</button>
      </>}
      <button className="btn small secondary" style={{ marginLeft: 6 }} onClick={() => setMode("")}>Close</button>
      <a.Msg />
    </div>
  );
}
