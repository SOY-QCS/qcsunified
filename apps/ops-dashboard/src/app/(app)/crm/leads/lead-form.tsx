"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";
import { STAGES } from "@/lib/sla";

const SOURCES = ["instagram", "facebook", "tiktok", "referral", "walk_in", "field_sales", "website", "whatsapp", "other"];
export type Lead = { business_name: string; contact_name: string; phone: string; email: string; city_id: string; source: string; owner_id: string;
  expected_weekly: string; next_action: string; next_action_at: string };

/** Create (no id) or edit a lead. */
export function LeadForm({ id, cities, owners, me, v }: { id?: string; cities: { id: string; name: string }[]; owners: { id: string; name: string }[]; me: string; v?: Lead }) {
  const [f, setF] = useState<Lead>(v ?? { business_name: "", contact_name: "", phone: "", email: "", city_id: cities[0]?.id ?? "", source: "instagram", owner_id: me,
    expected_weekly: "", next_action: "", next_action_at: "" });
  const a = useRun();
  const router = useRouter();
  const set = (k: keyof Lead) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <div className="row">
        <div><label>Business name</label><input value={f.business_name} onChange={set("business_name")} /></div>
        <div><label>Contact person</label><input value={f.contact_name} onChange={set("contact_name")} /></div>
        <div><label>Phone</label><input value={f.phone} onChange={set("phone")} placeholder="024 123 4567" /></div>
      </div>
      <div className="row">
        <div><label>Email</label><input value={f.email} onChange={set("email")} /></div>
        {cities.length > 1 && <div><label>City</label><select value={f.city_id} onChange={set("city_id")}>{cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
        <div><label>Where they came from</label><select value={f.source} onChange={set("source")}>{SOURCES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></div>
        <div><label>Parcels a week (their estimate)</label><input type="number" min={0} value={f.expected_weekly} onChange={set("expected_weekly")} /></div>
      </div>
      <div className="row">
        <div><label>Account manager</label><select value={f.owner_id} onChange={set("owner_id")}><option value="">None</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div><label>Next step</label><input value={f.next_action} onChange={set("next_action")} placeholder="Call back, visit shop, send rates…" /></div>
        <div><label>By</label><input type="date" value={f.next_action_at} onChange={set("next_action_at")} /></div>
      </div>
      <button className="btn" style={{ marginTop: 10 }} disabled={a.pending || f.business_name.trim().length < 2}
        onClick={() => a.run(() => rpcAction("save_lead", { p_id: id ?? null, p: f }, id ? "Saved" : "Lead added"), (r) => { if (!id) router.push(`/crm/leads/${r.data}`); })}>{id ? "Save" : "Add lead"}</button>
      <a.Msg />
    </div>
  );
}

/** Move along the pipeline. "Lost" needs a reason; Active/Churn stages need a signed-up vendor. */
export function MoveLead({ id, stage, hasVendor }: { id: string; stage: string; hasVendor: boolean }) {
  const [to, setTo] = useState(stage);
  const [note, setNote] = useState("");
  const a = useRun();
  return (
    <div className="row" style={{ alignItems: "end" }}>
      <div><label>Stage</label><select value={to} onChange={(e) => setTo(e.target.value)}>
        {STAGES.map(([k, l]) => <option key={k} value={k} disabled={!hasVendor && ["active", "churn_risk", "churned"].includes(k)}>{l}</option>)}</select></div>
      <div><label>{to === "lost" ? "Why was it lost? (required)" : "Note"}</label><input value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div style={{ flex: "0 0 auto" }}><button className="btn small" disabled={a.pending || to === stage}
        onClick={() => a.run(() => rpcAction("move_lead", { p_id: id, p_stage: to, p_note: note || null }, "Moved"), () => setNote(""))}>Move</button></div>
      <a.Msg />
    </div>
  );
}
