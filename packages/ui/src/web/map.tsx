"use client";
/**
 * A Google map without extra packages: loads Google's own Maps JavaScript script once.
 * Needs a browser key (NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY) restricted to our websites in Google Cloud.
 * With no key it shows a plain "open in Google Maps" link, so pages still work.
 */
import { useEffect, useRef, useState } from "react";
import { colors } from "../index";

export interface MapPin { id: string; lat: number; lng: number; label: string; color?: string; draggable?: boolean }

// Google's script puts everything on window.google; we only use a few calls, typed loosely on purpose.
type G = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let loading: Promise<G> | null = null;
export function loadGoogle(key: string): Promise<G> {
  const w = window as unknown as { google?: G; __qcsMapsReady?: () => void };
  if (w.google?.maps) return Promise.resolve(w.google);
  loading ??= new Promise((resolve, reject) => {
    w.__qcsMapsReady = () => resolve(w.google);
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__qcsMapsReady&loading=async`;
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error("Google Maps failed to load")); };
    document.head.appendChild(s);
  });
  return loading;
}

export function QcsMap({ apiKey, pins, height = 320, onDrag, fit = true }: {
  apiKey: string | undefined; pins: MapPin[]; height?: number; fit?: boolean;
  onDrag?: (id: string, p: { lat: number; lng: number }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<G>(null);
  const markers = useRef(new Map<string, G>());
  const fitted = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!apiKey || !box.current) return;
    let gone = false;
    loadGoogle(apiKey).then((g) => {
      if (gone || !box.current) return;
      map.current ??= new g.maps.Map(box.current, { center: pins[0] ?? { lat: 5.6037, lng: -0.187 }, zoom: 14, disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy" });
      const seen = new Set<string>();
      for (const p of pins) {
        seen.add(p.id);
        let m = markers.current.get(p.id);
        if (!m) {
          m = new g.maps.Marker({ map: map.current, position: p, draggable: !!p.draggable, title: p.label,
            label: { text: p.label.slice(0, 1), color: "#fff", fontWeight: "700" },
            icon: { path: g.maps.SymbolPath.CIRCLE, scale: 13, fillColor: p.color ?? colors.primary, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 } });
          if (p.draggable && onDrag) m.addListener("dragend", () => { const q = m.getPosition(); onDrag(p.id, { lat: q.lat(), lng: q.lng() }); });
          markers.current.set(p.id, m);
        } else m.setPosition(p);   // rider moves smoothly without redrawing the map
      }
      for (const [id, m] of markers.current) if (!seen.has(id)) { m.setMap(null); markers.current.delete(id); }
      if (fit && !fitted.current && pins.length > 1) {
        const b = new g.maps.LatLngBounds(); pins.forEach((p) => b.extend(p)); map.current.fitBounds(b, 48); fitted.current = true;
      }
    }).catch(() => setFailed(true));
    return () => { gone = true; };
  }, [apiKey, pins, onDrag, fit]);

  if (!apiKey || failed) {
    const p = pins.find((x) => x.draggable) ?? pins[pins.length - 1];
    return (
      <div style={{ height: 120, borderRadius: 12, background: "#eee", display: "grid", placeItems: "center", color: colors.muted }}>
        {p ? <a href={`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">Open the location in Google Maps</a> : "Map unavailable"}
      </div>
    );
  }
  return <div ref={box} style={{ height, borderRadius: 12, overflow: "hidden", background: "#e9e5df" }} />;
}
