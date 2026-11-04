"use client";
import { useState } from "react";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";
import type { City } from "@/lib/ops";

/** Super Admin: add a city or change its code, name, same-day cut-off and whether it's in service. */
export function CityEditor({ cities }: { cities: City[] }) {
  return (
    <>
      <h2>Cities</h2>
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Same-day cut-off</th><th>In service</th><th></th></tr></thead>
        <tbody>
          {cities.map((c) => <CityRow key={c.id} c={c} />)}
          <CityRow c={{ id: "", code: "", name: "", same_day_cutoff: "09:00", is_active: true }} />
        </tbody>
      </table>
      <p className="muted">The city code is the first part of tracking numbers (e.g. ACC-…). Draw at least one zone before turning a new city on.</p>
    </>
  );
}

function CityRow({ c }: { c: City }) {
  const [f, setF] = useState({ code: c.code, name: c.name, cutoff: c.same_day_cutoff.slice(0, 5), active: c.is_active });
  const a = useRun();
  return (
    <tr>
      <td><input value={f.code} maxLength={3} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} style={{ width: 70 }} placeholder="CPC" /></td>
      <td><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={c.id ? "" : "New city"} /></td>
      <td><input type="time" value={f.cutoff} onChange={(e) => setF({ ...f, cutoff: e.target.value })} style={{ width: 120 }} /></td>
      <td><input type="checkbox" style={{ width: "auto" }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /></td>
      <td><button className="btn small" disabled={a.pending || !f.code || !f.name}
        onClick={() => a.run(() => rpcAction("save_city", { p_id: c.id || null, p_code: f.code, p_name: f.name, p_cutoff: f.cutoff, p_active: f.active }, c.id ? "Saved" : "City added"))}>{c.id ? "Save" : "Add"}</button><a.Msg /></td>
    </tr>
  );
}
