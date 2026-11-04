"use client";
import { useMemo, useState } from "react";
import { OpsMap, type Mark } from "@/components/ops-map";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

export interface Hub { id: string; city_id: string; code: string; name: string; address: string; phone: string | null; lat: number; lng: number;
  opening_hours: Record<string, [string, string] | null>; capacity: number; is_active: boolean; parcels_in: number; staff: { name: string; role: string }[] }
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const blank = (city: string): Hub => ({ id: "", city_id: city, code: "", name: "", address: "", phone: "", lat: 0, lng: 0, capacity: 500, is_active: true, parcels_in: 0, staff: [],
  opening_hours: { mon: ["08:00", "18:00"], tue: ["08:00", "18:00"], wed: ["08:00", "18:00"], thu: ["08:00", "18:00"], fri: ["08:00", "18:00"], sat: ["09:00", "14:00"], sun: null } });

export function HubEditor({ hubs, cities, editable, defaultCity }: { hubs: Hub[]; cities: { id: string; name: string }[]; editable: string[]; defaultCity: string }) {
  const [f, setF] = useState<Hub | null>(null);
  const a = useRun();
  const marks = useMemo<Mark[]>(() => [
    ...hubs.filter((h) => h.id !== f?.id).map((h) => ({ id: h.id, lat: h.lat, lng: h.lng, color: h.is_active ? "#1f1b17" : "#999", size: 9, label: "H", title: `${h.name} · ${h.parcels_in} parcels in` })),
    ...(f && f.lat ? [{ id: "edit", lat: f.lat, lng: f.lng, color: "#df6518", size: 11, label: "H", title: "Drag to move", draggable: true }] : []),
  ], [hubs, f]);
  const can = (city: string) => editable.includes(city);
  const hours = (d: typeof DAYS[number], i: 0 | 1, v: string) => f && setF({ ...f, opening_hours: { ...f.opening_hours, [d]: [i === 0 ? v : f.opening_hours[d]?.[0] ?? "08:00", i === 1 ? v : f.opening_hours[d]?.[1] ?? "18:00"] } });

  return (
    <>
      <table>
        <thead><tr><th>Hub</th><th>Address</th><th>Parcels in / capacity</th><th>Staff</th><th></th></tr></thead>
        <tbody>
          {hubs.map((h) => (
            <tr key={h.id}>
              <td><a href={`/hubs/${h.id}`}><strong>{h.name}</strong></a> <span className="muted">{h.code}</span>{!h.is_active && <span className="tag">closed</span>}</td>
              <td>{h.address}<br /><span className="muted">{h.phone}</span></td>
              <td style={{ color: h.capacity && h.parcels_in > h.capacity * 0.9 ? "var(--danger)" : undefined }}>{h.parcels_in} / {h.capacity}</td>
              <td>{h.staff.map((s) => `${s.name} (${s.role.replace("_", " ")})`).join(", ") || <span className="muted">none</span>}</td>
              <td>{can(h.city_id) && <button className="btn small secondary" onClick={() => setF(h)}>Edit</button>}</td>
            </tr>
          ))}
          {!hubs.length && <tr><td colSpan={5} className="muted">No hubs yet.</td></tr>}
        </tbody>
      </table>
      {editable.length > 0 && !f && <p><button className="btn" onClick={() => setF(blank(defaultCity))}>+ Add a hub</button></p>}
      {f && (
        <div className="card" style={{ marginTop: 16 }}>
          <strong>{f.id ? `Edit ${f.name}` : "New hub"}</strong> <span className="muted">— click the map to place it, or drag the orange pin</span>
          <div className="row">
            <div><label>City</label><select value={f.city_id} onChange={(e) => setF({ ...f, city_id: e.target.value })}>{cities.filter((c) => can(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label>Code</label><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="ACC-HUB2" /></div>
            <div><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          </div>
          <div className="row">
            <div><label>Address</label><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
            <div><label>Phone</label><input value={f.phone ?? ""} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
            <div><label>Capacity (parcels)</label><input inputMode="numeric" value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) || 0 })} /></div>
          </div>
          <label>Opening hours</label>
          <div className="row">{DAYS.map((d) => (
            <div key={d} style={{ flex: "1 1 120px" }}>
              <label style={{ fontWeight: 400, display: "flex", gap: 6, margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={!!f.opening_hours[d]}
                onChange={(e) => setF({ ...f, opening_hours: { ...f.opening_hours, [d]: e.target.checked ? ["08:00", "18:00"] : null } })} />{d}</label>
              {f.opening_hours[d] && <><input type="time" value={f.opening_hours[d]![0]} onChange={(e) => hours(d, 0, e.target.value)} />
                <input type="time" value={f.opening_hours[d]![1]} onChange={(e) => hours(d, 1, e.target.value)} /></>}
            </div>))}
          </div>
          <label style={{ fontWeight: 400, display: "flex", gap: 6 }}><input type="checkbox" style={{ width: "auto" }} checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />Open for parcels</label>
          <div className="row" style={{ alignItems: "end" }}>
            <div><label>Latitude</label><input value={f.lat || ""} onChange={(e) => setF({ ...f, lat: Number(e.target.value) })} /></div>
            <div><label>Longitude</label><input value={f.lng || ""} onChange={(e) => setF({ ...f, lng: Number(e.target.value) })} /></div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn" disabled={a.pending} onClick={() => a.run(() => rpcAction("save_hub", { p_id: f.id || null, p: {
              city_id: f.city_id, code: f.code, name: f.name, address: f.address, phone: f.phone, lat: f.lat, lng: f.lng, capacity: f.capacity, opening_hours: f.opening_hours, is_active: f.is_active } }, "Hub saved"), () => setF(null))}>Save hub</button>
            <button className="btn secondary" onClick={() => setF(null)}>Cancel</button>
          </div>
          <a.Msg />
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <OpsMap marks={marks} height={420} fitKey={f ? `e-${f.id}` : "list"}
          onClick={(p) => f && setF({ ...f, lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) })}
          onMarkDrag={(id, p) => id === "edit" && f && setF({ ...f, lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) })} />
      </div>
    </>
  );
}
