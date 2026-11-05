"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";
import { CATEGORIES } from "@/lib/sla";

export function NewTicketForm({ cities, tracking, phone }: { cities: { id: string; name: string }[]; tracking: string; phone: string }) {
  const [f, setF] = useState({ channel: "phone", phone, name: "", tracking_number: tracking, category: "general", subject: "", body: "", city_id: cities[0]?.id ?? "" });
  const a = useRun();
  const router = useRouter();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <div className="row">
        <div><label>How they contacted us</label><select value={f.channel} onChange={set("channel")}><option value="phone">Phone call</option><option value="staff">Walk-in</option><option value="email">Email</option></select></div>
        <div><label>Problem</label><select value={f.category} onChange={set("category")}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      </div>
      <div className="row">
        <div><label>Their phone</label><input value={f.phone} onChange={set("phone")} placeholder="024 123 4567" /></div>
        <div><label>Their name</label><input value={f.name} onChange={set("name")} placeholder="if they have no QCS account" /></div>
      </div>
      <div className="row">
        <div><label>Tracking number (if about a delivery)</label><input value={f.tracking_number} onChange={set("tracking_number")} placeholder="ACC-202611041301-KUM" /></div>
        {!f.tracking_number && cities.length > 1 && <div><label>City</label><select value={f.city_id} onChange={set("city_id")}>{cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
      </div>
      <label>Subject</label><input value={f.subject} onChange={set("subject")} placeholder="Short summary" />
      <label>What they said</label><textarea rows={4} value={f.body} onChange={set("body")} />
      <button className="btn" style={{ marginTop: 10 }} disabled={a.pending || f.body.trim().length < 5}
        onClick={() => a.run(() => rpcAction("staff_open_ticket", { p: f }, "Ticket logged"), (r) => router.push(`/crm/tickets/${r.data}`))}>Log ticket</button>
      <a.Msg />
    </div>
  );
}
