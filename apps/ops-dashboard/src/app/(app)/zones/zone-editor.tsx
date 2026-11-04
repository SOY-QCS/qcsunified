"use client";
import { useMemo, useState } from "react";
import { OpsMap, type Mark, type Pt, type Shape } from "@/components/ops-map";
import { rpcAction } from "@/lib/rpc-action";
import { useRun } from "@/components/run";

export interface ZoneRow { id: string; code: string; name: string; is_active: boolean; area_km2: number; geojson: { type: string; coordinates: number[][][][] | number[][][] } }
const PALETTE = ["#1f6fd1", "#1f8a4c", "#7b3fbf", "#c98a00", "#0f8a8a", "#b8500f", "#a3336b"];

/** GeoJSON ([lng, lat], closed rings) ⇄ map paths ({lat, lng}, open rings). Each polygon's outer ring becomes one path. */
function toRings(g: ZoneRow["geojson"]): Pt[][] {
  const polys = (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]) as number[][][][];
  return polys.map((poly) => poly[0]!.slice(0, -1).map(([lng, lat]) => ({ lat: lat!, lng: lng! })));
}
function toGeoJSON(rings: Pt[][]) {
  return { type: "MultiPolygon", coordinates: rings.filter((r) => r.length >= 3).map((r) => [[...r, r[0]!].map((p) => [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6))])]) };
}

export function ZoneEditor({ cityId, cityCode, zones, hubs, canEdit }: { cityId: string; cityCode: string; zones: ZoneRow[]; hubs: { id: string; name: string; lat: number; lng: number }[]; canEdit: boolean }) {
  const [sel, setSel] = useState<string | null>(null);              // zone id, or "new"
  const [rings, setRings] = useState<Pt[][]>([]);                     // the shape being edited
  const [form, setForm] = useState({ code: "", name: "", active: true });
  const a = useRun();

  const start = (z: ZoneRow | null) => {
    if (!z) { setSel("new"); setRings([[]]); setForm({ code: `${cityCode}-`, name: "", active: true }); return; }
    setSel(z.id); setRings(toRings(z.geojson)); setForm({ code: z.code, name: z.name, active: z.is_active });
  };
  const drawing = sel === "new" && (rings[0]?.length ?? 0) < 3;

  const shapes = useMemo<Shape[]>(() => [
    ...zones.filter((z) => z.id !== sel).map((z, i) => ({ id: z.id, rings: toRings(z.geojson), color: z.is_active ? PALETTE[i % PALETTE.length]! : "#999" })),
    ...(sel && rings[0] && rings[0].length >= 3 ? [{ id: "edit", rings, color: "#df6518", editable: canEdit }] : []),
  ], [zones, sel, rings, canEdit]);
  const marks = useMemo<Mark[]>(() => [
    ...hubs.map((h) => ({ id: `h-${h.id}`, lat: h.lat, lng: h.lng, color: "#1f1b17", size: 8, label: "H", title: h.name })),
    ...(drawing ? (rings[0] ?? []).map((p, i) => ({ id: `d-${i}`, ...p, color: "#df6518", size: 5, title: `Corner ${i + 1}` })) : []),
  ], [hubs, drawing, rings]);

  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <div style={{ flex: "1 1 260px", maxWidth: 340 }}>
        {canEdit && <button className="btn block" style={{ marginTop: 0 }} onClick={() => start(null)}>+ Draw a new zone</button>}
        <table style={{ marginTop: 12 }}>
          <tbody>{zones.map((z, i) => (
            <tr key={z.id} onClick={() => start(z)} style={{ cursor: "pointer", background: sel === z.id ? "#fbeee4" : undefined }}>
              <td><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: z.is_active ? PALETTE[i % PALETTE.length] : "#999", marginRight: 6 }} />
                <strong>{z.name}</strong><br /><span className="muted">{z.code} · {z.area_km2} km²{z.is_active ? "" : " · off"}</span></td>
            </tr>))}
            {!zones.length && <tr><td className="muted">No zones yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ flex: "3 1 480px" }}>
        {sel && (
          <div className="card" style={{ padding: 12 }}>
            {drawing
              ? <p style={{ margin: 0 }}><strong>Click on the map to place the corners</strong> of the zone ({rings[0]?.length ?? 0} so far, at least 3). Then drag the corners to adjust.</p>
              : <p className="muted" style={{ margin: 0 }}>{canEdit ? "Drag the white corner dots to reshape; drag a middle dot to add a corner; right-click a corner to remove it." : "View only."}</p>}
            {canEdit && <div className="row" style={{ alignItems: "end" }}>
              <div><label>Code</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></div>
              <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. East Legon" /></div>
              <div style={{ flex: "0 0 auto" }}><label style={{ fontWeight: 400, display: "flex", gap: 6 }}><input type="checkbox" style={{ width: "auto" }} checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />In service</label></div>
            </div>}
            {canEdit && <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn" disabled={a.pending || (rings[0]?.length ?? 0) < 3}
                onClick={() => a.run(() => rpcAction("save_zone", { p_id: sel === "new" ? null : sel, p_city: cityId, p_code: form.code, p_name: form.name, p_geojson: toGeoJSON(rings), p_active: form.active }, "Zone saved. New bookings use it straight away."), () => setSel(null))}>Save zone</button>
              {sel === "new" && (rings[0]?.length ?? 0) > 0 && <button className="btn secondary" onClick={() => setRings([[]])}>Start again</button>}
              <button className="btn secondary" onClick={() => setSel(null)}>Close</button>
            </div>}
            <a.Msg />
          </div>
        )}
        <OpsMap shapes={shapes} marks={marks} height={600} fitKey={cityId}
          onClick={(p) => { if (drawing) setRings((r) => [[...(r[0] ?? []), p]]); }}
          onShapeChange={(_, r) => setRings(r)} />
        <p className="muted">Changing a zone&apos;s shape changes which e-commerce price applies to new bookings there. Existing bookings keep their price.</p>
      </div>
    </div>
  );
}
