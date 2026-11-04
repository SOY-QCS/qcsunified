"use client";
/**
 * Google map for the dashboard: many markers (riders, parcels, hubs) and zone shapes, optionally editable.
 * Uses Google's own script (no extra package). Needs NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY.
 */
import { useEffect, useRef, useState } from "react";
import { loadGoogle } from "@qcs/ui/web";

type G = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Pt { lat: number; lng: number }
export interface Mark extends Pt { id: string; color: string; title: string; label?: string; size?: number; href?: string; draggable?: boolean }
export interface Shape { id: string; rings: Pt[][]; color: string; label?: string; editable?: boolean }

export const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;

export function OpsMap({ marks = [], shapes = [], height = 560, center, onClick, onShapeChange, onMarkDrag, fitKey }: {
  marks?: Mark[]; shapes?: Shape[]; height?: number | string; center?: Pt;
  onClick?: (p: Pt) => void; onShapeChange?: (id: string, rings: Pt[][]) => void; onMarkDrag?: (id: string, p: Pt) => void;
  /** change this to re-fit the map to everything on it */ fitKey?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const g = useRef<G>(null);
  const map = useRef<G>(null);
  const info = useRef<G>(null);
  const mk = useRef(new Map<string, G>());
  const sh = useRef(new Map<string, G>());
  const fitted = useRef<string | undefined>(undefined);
  const cb = useRef({ onClick, onShapeChange, onMarkDrag });
  cb.current = { onClick, onShapeChange, onMarkDrag };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!MAPS_KEY || !box.current) return;
    loadGoogle(MAPS_KEY).then((google) => {
      g.current = google;
      map.current = new google.maps.Map(box.current, { center: center ?? { lat: 5.6037, lng: -0.187 }, zoom: 12, mapTypeControl: false, streetViewControl: false, gestureHandling: "greedy" });
      info.current = new google.maps.InfoWindow();
      map.current.addListener("click", (e: G) => cb.current.onClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
      setReady(true);
    }).catch(() => setFailed(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // markers: update in place so a refresh doesn't make the map jump
  useEffect(() => {
    if (!ready) return;
    const google = g.current, seen = new Set<string>();
    for (const m of marks) {
      seen.add(m.id);
      const icon = { path: google.maps.SymbolPath.CIRCLE, scale: m.size ?? 7, fillColor: m.color, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 };
      let x = mk.current.get(m.id);
      if (!x) {
        x = new google.maps.Marker({ map: map.current, position: m, icon, title: m.title, draggable: !!m.draggable,
          label: m.label ? { text: m.label, color: "#fff", fontSize: "10px", fontWeight: "700" } : undefined });
        x.addListener("click", () => {
          const cur = x.__m as Mark;
          info.current.setContent(`<div style="font:14px system-ui">${escapeHtml(cur.title)}${cur.href ? `<br><a href="${cur.href}">Open</a>` : ""}</div>`);
          info.current.open({ map: map.current, anchor: x });
        });
        x.addListener("dragend", () => { const p = x.getPosition(); cb.current.onMarkDrag?.(m.id, { lat: p.lat(), lng: p.lng() }); });
        mk.current.set(m.id, x);
      } else { x.setPosition(m); x.setIcon(icon); x.setTitle(m.title); }
      x.__m = m;
    }
    for (const [id, x] of mk.current) if (!seen.has(id)) { x.setMap(null); mk.current.delete(id); }
  }, [ready, marks]);

  // shapes (zones)
  useEffect(() => {
    if (!ready) return;
    const google = g.current;
    for (const p of sh.current.values()) p.setMap(null);
    sh.current.clear();
    for (const s of shapes) {
      const poly = new google.maps.Polygon({ map: map.current, paths: s.rings, strokeColor: s.color, strokeWeight: s.editable ? 3 : 1.5,
        fillColor: s.color, fillOpacity: s.editable ? 0.25 : 0.12, editable: !!s.editable, draggable: false, clickable: !s.editable, zIndex: s.editable ? 2 : 1 });
      if (s.editable) {
        const emit = () => cb.current.onShapeChange?.(s.id, poly.getPaths().getArray().map((path: G) => path.getArray().map((ll: G) => ({ lat: ll.lat(), lng: ll.lng() }))));
        poly.getPaths().forEach((path: G) => { path.addListener("set_at", emit); path.addListener("insert_at", emit); path.addListener("remove_at", emit); });
        // right-click a corner to delete it
        poly.addListener("rightclick", (e: G) => { if (e.vertex != null && e.path != null) poly.getPaths().getAt(e.path).removeAt(e.vertex); });
      } else {
        poly.addListener("click", (e: G) => cb.current.onClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
      }
      sh.current.set(s.id, poly);
    }
  }, [ready, shapes]);

  useEffect(() => {
    if (!ready || fitted.current === (fitKey ?? "x")) return;
    const google = g.current, b = new google.maps.LatLngBounds();
    let n = 0;
    for (const m of marks) { b.extend(m); n++; }
    for (const s of shapes) for (const r of s.rings) for (const p of r) { b.extend(p); n++; }
    if (n > 1) map.current.fitBounds(b, 40); else if (n === 1) { map.current.setCenter(b.getCenter()); map.current.setZoom(15); }
    else if (center) map.current.setCenter(center);
    if (n > 0 || center) fitted.current = fitKey ?? "x";
  }, [ready, marks, shapes, fitKey, center]);

  if (!MAPS_KEY || failed) {
    return <div className="card muted" style={{ height: 120, display: "grid", placeItems: "center", textAlign: "center" }}>
      Map unavailable — set NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY (Google Maps JavaScript API) to see the map. Lists below still work.</div>;
  }
  return <div ref={box} style={{ height, borderRadius: 10, overflow: "hidden", border: "1px solid var(--line)", background: "#e9e5df" }} />;
}

function escapeHtml(s: string) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
