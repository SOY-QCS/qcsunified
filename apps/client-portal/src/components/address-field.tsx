"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

export interface PlaceValue {
  address_id?: string | null; formatted_address: string; lat: number | null; lng: number | null;
  ghana_post_gps: string; landmark: string; google_place_id?: string | null;
}
export const emptyPlace = (): PlaceValue => ({ formatted_address: "", lat: null, lng: null, ghana_post_gps: "", landmark: "" });

interface Suggestion { place_id: string; main: string; secondary: string }
interface Saved { id: string; label: string | null; contact_name: string | null; contact_phone: string | null; formatted_address: string; landmark: string | null; ghana_post_gps: string | null; lat: number; lng: number }

/**
 * Address entry: type to search Google (Ghana only), pick a saved address, or use this device's location.
 * The pin (lat/lng) is what riders navigate to; the text, landmark and Ghana Post GPS help them find the door.
 */
export function AddressField({ label, value, onChange, vendorId, onSaved }: {
  label: string; value: PlaceValue; onChange: (v: PlaceValue) => void; vendorId?: string | null;
  onSaved?: (s: { contact_name: string | null; contact_phone: string | null }) => void;
}) {
  const [q, setQ] = useState(value.formatted_address);
  const [open, setOpen] = useState(false);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [googleOn, setGoogleOn] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const session = useMemo(() => crypto.randomUUID(), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setQ(value.formatted_address); }, [value.formatted_address]);

  function search(text: string) {
    setQ(text);
    onChange({ ...value, formatted_address: text, address_id: null });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const qs = new URLSearchParams({ q: text, session, ...(vendorId ? { vendor_id: vendorId } : {}) });
      const [g, s] = await Promise.all([
        text.length >= 3 ? api<{ suggestions: Suggestion[]; available: boolean }>(`/api/v1/places/autocomplete?${qs}`).catch(() => ({ suggestions: [], available: false })) : Promise.resolve({ suggestions: [], available: true }),
        api<{ addresses: Saved[] }>(`/api/v1/addresses?${qs}`).catch(() => ({ addresses: [] })),
      ]);
      setGoogleOn(g.available); setSugs(g.suggestions); setSaved(s.addresses); setOpen(true);
    }, 300);
  }

  async function pickGoogle(s: Suggestion) {
    setOpen(false);
    try {
      const d = await api<{ formatted_address: string; lat: number; lng: number; google_place_id: string }>(`/api/v1/places/details?id=${encodeURIComponent(s.place_id)}&session=${session}`);
      onChange({ ...value, ...d, address_id: null });
      setMsg(null);
    } catch { setMsg("Couldn't load that place — try another or use your location."); }
  }

  function pickSaved(a: Saved) {
    setOpen(false);
    onChange({ address_id: a.id, formatted_address: a.formatted_address, lat: a.lat, lng: a.lng, ghana_post_gps: a.ghana_post_gps ?? "", landmark: a.landmark ?? "" });
    onSaved?.({ contact_name: a.contact_name, contact_phone: a.contact_phone });
  }

  function here() {
    if (!navigator.geolocation) return setMsg("This browser can't share its location.");
    navigator.geolocation.getCurrentPosition(
      (p) => { onChange({ ...value, lat: p.coords.latitude, lng: p.coords.longitude, address_id: null }); setMsg(null); },
      () => setMsg("Location was blocked. Allow it in the browser, or search for the address."),
      { enableHighAccuracy: true },
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <label>{label}</label>
      <input value={q} onChange={(e) => search(e.target.value)} onFocus={() => q.length >= 1 && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder="Search a place, street or customer name" autoComplete="off" />
      {open && (saved.length > 0 || sugs.length > 0 || !googleOn) && (
        <div className="card" style={{ position: "absolute", zIndex: 10, left: 0, right: 0, marginTop: 4, padding: 6, maxHeight: 280, overflowY: "auto" }}>
          {saved.map((a) => (
            <button type="button" key={a.id} className="suggest" onMouseDown={() => pickSaved(a)}>
              ★ <strong>{a.contact_name ?? a.label}</strong> <span className="muted">{a.formatted_address}</span>
            </button>
          ))}
          {sugs.map((s) => (
            <button type="button" key={s.place_id} className="suggest" onMouseDown={() => pickGoogle(s)}>
              📍 <strong>{s.main}</strong> <span className="muted">{s.secondary}</span>
            </button>
          ))}
          {!googleOn && <p className="muted" style={{ margin: 6 }}>Map search isn&apos;t switched on yet — use a saved address, your location, or type the coordinates below.</p>}
        </div>
      )}
      <div className="row">
        <div><label>Landmark</label><input value={value.landmark} onChange={(e) => onChange({ ...value, landmark: e.target.value })} placeholder="e.g. opposite the Total station" /></div>
        <div><label>Ghana Post GPS</label><input value={value.ghana_post_gps} onChange={(e) => onChange({ ...value, ghana_post_gps: e.target.value.toUpperCase() })} placeholder="GA-123-4567" /></div>
      </div>
      <div className="row" style={{ alignItems: "end" }}>
        <div><label>Pin (lat, lng)</label>
          <input value={value.lat != null && value.lng != null ? `${value.lat.toFixed(6)}, ${value.lng.toFixed(6)}` : ""} placeholder="5.6037, -0.1870"
            onChange={(e) => { const [a, b] = e.target.value.split(",").map((x) => Number(x.trim())); onChange({ ...value, lat: Number.isFinite(a) ? a! : null, lng: Number.isFinite(b) ? b! : null, address_id: null }); }} />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn secondary small" onClick={here}>Use my location</button>
          {value.lat != null && value.lng != null && <a className="btn secondary small" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${value.lat},${value.lng}`}>Check on map</a>}
        </div>
      </div>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}
