"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";
import { STAGES } from "@/lib/sla";

type Preview = { people: number; push: number; sms: number; whatsapp: number; email: number; sample: string[] };

export function SegmentForm({ cities, allowAll }: { cities: { id: string; name: string }[]; allowAll: boolean }) {
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<"customers" | "vendors">("customers");
  const [city, setCity] = useState(allowAll ? "" : cities[0]?.id ?? "");
  const [f, setF] = useState({ ordered_within_days: "", inactive_days: "", min_orders: "", service: "", account_type: "", tags: "", stages: [] as string[] });
  const [preview, setPreview] = useState<Preview | null>(null);
  const a = useRun();
  const filters = () => Object.fromEntries(Object.entries({
    ...f, tags: f.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean), stages: audience === "vendors" ? f.stages : [],
    account_type: audience === "vendors" ? f.account_type : "",
  }).filter(([, v]) => (Array.isArray(v) ? v.length : v !== "")));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setPreview(null); };
  return (
    <div>
      <div className="row">
        <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Accra customers idle 30 days" /></div>
        <div><label>Who</label><select value={audience} onChange={(e) => { setAudience(e.target.value as "customers" | "vendors"); setPreview(null); }}><option value="customers">Customers</option><option value="vendors">Vendors</option></select></div>
        <div><label>City</label><select value={city} onChange={(e) => { setCity(e.target.value); setPreview(null); }}>{allowAll && <option value="">All cities</option>}{cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      </div>
      <div className="row">
        <div><label>Ordered in the last … days</label><input type="number" min={1} value={f.ordered_within_days} onChange={set("ordered_within_days")} /></div>
        <div><label>No order for … days (win-back)</label><input type="number" min={1} value={f.inactive_days} onChange={set("inactive_days")} /></div>
        <div><label>At least … orders</label><input type="number" min={1} value={f.min_orders} onChange={set("min_orders")} /></div>
      </div>
      <div className="row">
        <div><label>Used service</label><select value={f.service} onChange={set("service")}><option value="">Any</option><option value="express">Express</option><option value="ecommerce">E-commerce</option><option value="intercity">Inter-city</option></select></div>
        <div><label>Tags</label><input value={f.tags} onChange={set("tags")} placeholder="vip, fashion" /></div>
        {audience === "vendors" && <div><label>Account</label><select value={f.account_type} onChange={set("account_type")}><option value="">Any</option><option value="vendor">Vendor</option><option value="corporate">Corporate</option></select></div>}
      </div>
      {audience === "vendors" && <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        {STAGES.map(([k, l]) => <label key={k} style={{ fontWeight: 400, display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={f.stages.includes(k)} onChange={(e) => { setF({ ...f, stages: e.target.checked ? [...f.stages, k] : f.stages.filter((x) => x !== k) }); setPreview(null); }} />{l}</label>)}
      </div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn secondary small" disabled={a.pending} onClick={() => a.run(() => rpcAction("segment_preview", { p_audience: audience, p_filters: filters(), p_city: city || null }, "Counted"), (r) => setPreview(r.data as Preview))}>Count people</button>
        <button className="btn small" disabled={a.pending || name.trim().length < 2} onClick={() => a.run(() => rpcAction("save_segment", { p_id: null, p_name: name, p_audience: audience, p_filters: filters(), p_city: city || null }, "Segment saved"))}>Save segment</button>
      </div>
      {preview && <p className="notice">{preview.people} people opted in to offers · push {preview.push} · SMS {preview.sms} · WhatsApp {preview.whatsapp} · email {preview.email}{preview.sample.length ? ` — e.g. ${preview.sample.join(", ")}` : ""}</p>}
      <a.Msg />
    </div>
  );
}

export function CampaignForm({ segments }: { segments: { id: string; name: string }[] }) {
  const [f, setF] = useState({ name: "", segment_id: segments[0]?.id ?? "", title: "", message: "", wa_template: "", channels: ["push"] as string[] });
  const a = useRun();
  const toggle = (c: string) => setF({ ...f, channels: f.channels.includes(c) ? f.channels.filter((x) => x !== c) : [...f.channels, c] });
  return (
    <div>
      <div className="row">
        <div><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Weekend promo" /></div>
        <div><label>Segment</label><select value={f.segment_id} onChange={(e) => setF({ ...f, segment_id: e.target.value })}>{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
      </div>
      <div style={{ display: "flex", gap: 14, margin: "10px 0" }}>
        {[["push", "App notification (free)"], ["sms", "SMS (paid)"], ["whatsapp", "WhatsApp (paid, template)"], ["email", "Email"]].map(([k, l]) => (
          <label key={k} style={{ fontWeight: 400, display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={f.channels.includes(k!)} onChange={() => toggle(k!)} />{l}</label>))}
      </div>
      <label>Title (push / email subject)</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Weekend offer" />
      <label>Message ({f.message.length}/600{f.channels.includes("sms") ? ` · SMS adds an opt-out link; ${Math.ceil((f.message.length + 40) / 160)} SMS each` : ""})</label>
      <textarea rows={3} maxLength={600} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
      {f.channels.includes("whatsapp") && <><label>WhatsApp template name (approved by Meta; the message fills its text)</label>
        <input value={f.wa_template} onChange={(e) => setF({ ...f, wa_template: e.target.value })} placeholder="qcs_offer" /></>}
      <button className="btn" style={{ marginTop: 10 }} disabled={a.pending} onClick={() => a.run(() => rpcAction("save_campaign", { p_id: null, p: f }, "Draft saved — an Admin can now send it"))}>Save draft</button>
      <a.Msg />
    </div>
  );
}

/** Admin: send now or at a set time (Accra time). */
export function ScheduleButton({ id }: { id: string }) {
  const [at, setAt] = useState("");
  const a = useRun();
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
      <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={{ maxWidth: 200 }} />
      <button className="btn small" disabled={a.pending} onClick={() => {
        if (!window.confirm(at ? "Schedule this campaign?" : "Send this campaign now?")) return;
        a.run(() => rpcAction("schedule_campaign", { p_id: id, p_at: at ? `${at}:00+00:00` : null }, at ? "Scheduled" : "Sending now"));
      }}>{at ? "Approve & schedule" : "Approve & send now"}</button>
      <a.Msg />
    </div>
  );
}
