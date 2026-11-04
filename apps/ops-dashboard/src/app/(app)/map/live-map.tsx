"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OpsMap, type Mark } from "@/components/ops-map";

interface Rider { id: string; name: string; phone: string | null; lat: number; lng: number; at: string; state: "on_job" | "idle" | "no_signal" | "offline"; plate: string | null; trip_id: string | null; cod_held: number }
interface Order { id: string; tracking_number: string; status: string; service_type: string; rider_id: string | null; trip_id: string | null; at: "pickup" | "dropoff";
  pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; recipient_name: string }

export const RIDER_COLORS = { on_job: "#df6518", idle: "#1f8a4c", no_signal: "#c0392b", offline: "#9a948c" } as const;
const RIDER_TEXT = { on_job: "On a job", idle: "Online, free", no_signal: "On a job, no signal", offline: "Offline (seen recently)" };
const ORDER_COLORS = { waiting: "#7b3fbf", moving: "#1f6fd1", failed: "#000000" };
const orderKind = (o: Order) => (o.status === "FAILED_ATTEMPT" ? "failed" : o.rider_id ? "moving" : "waiting");
const ORDER_TEXT = { waiting: "Parcel waiting for a rider", moving: "Parcel with a rider", failed: "Failed attempt" };

/** Riders and parcels, refreshed every 10 seconds. Click a dot for details. */
export function LiveMap({ city, hubs }: { city: string | null; hubs: { id: string; name: string; lat: number; lng: number }[] }) {
  const [data, setData] = useState<{ riders: Rider[]; orders: Order[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState({ on_job: true, idle: true, no_signal: true, offline: false, waiting: true, moving: false, failed: true, hubs: true });
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/live${city ? `?city=${city}` : ""}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) setError(j.error ?? "Couldn't load"); else { setData(j); setError(null); }
  }, [city]);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);

  const marks = useMemo<Mark[]>(() => {
    if (!data) return [];
    const m: Mark[] = [];
    for (const r of data.riders) if (show[r.state])
      m.push({ id: `r-${r.id}`, lat: r.lat, lng: r.lng, color: RIDER_COLORS[r.state], size: 8, label: r.name.slice(0, 1),
        title: `${r.name} · ${RIDER_TEXT[r.state]}${r.plate ? ` · ${r.plate}` : ""}${r.phone ? ` · ${r.phone}` : ""}`, href: `/riders/${r.id}` });
    for (const o of data.orders) {
      const k = orderKind(o);
      if (!show[k]) continue;
      const p = o.at === "pickup" ? o.pickup : o.dropoff;
      m.push({ id: `o-${o.id}`, lat: p.lat, lng: p.lng, color: ORDER_COLORS[k], size: 5,
        title: `${o.tracking_number} · ${o.status.replaceAll("_", " ").toLowerCase()} · to ${o.recipient_name}`, href: `/orders/${o.tracking_number}` });
    }
    if (show.hubs) for (const h of hubs) m.push({ id: `h-${h.id}`, lat: h.lat, lng: h.lng, color: "#1f1b17", size: 9, label: "H", title: h.name });
    return m;
  }, [data, show, hubs]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { on_job: 0, idle: 0, no_signal: 0, offline: 0, waiting: 0, moving: 0, failed: 0 };
    data?.riders.forEach((r) => c[r.state]++); data?.orders.forEach((o) => c[orderKind(o)]++);
    return c;
  }, [data]);

  const found = q.trim().length >= 2 && data
    ? [...data.riders.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()) || r.phone?.includes(q)).map((r) => ({ href: `/riders/${r.id}`, text: `${r.name} — ${RIDER_TEXT[r.state]}` })),
       ...data.orders.filter((o) => o.tracking_number.includes(q.toUpperCase())).map((o) => ({ href: `/orders/${o.tracking_number}`, text: `${o.tracking_number} — ${o.status.toLowerCase()}` }))].slice(0, 8)
    : [];

  const chip = (k: keyof typeof show, color: string, text: string, n?: number) => (
    <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: "0 12px 6px 0", fontWeight: 500 }}>
      <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} style={{ width: "auto" }} />
      <span style={{ width: 12, height: 12, borderRadius: 6, background: color, display: "inline-block" }} />{text}{n != null ? ` (${n})` : ""}
    </label>
  );
  return (
    <div>
      <div className="card" style={{ padding: 12 }}>
        <div>{chip("idle", RIDER_COLORS.idle, "Free riders", counts.idle)}{chip("on_job", RIDER_COLORS.on_job, "On a job", counts.on_job)}
          {chip("no_signal", RIDER_COLORS.no_signal, "No signal", counts.no_signal)}{chip("offline", RIDER_COLORS.offline, "Offline", counts.offline)}</div>
        <div>{chip("waiting", ORDER_COLORS.waiting, "Parcels waiting", counts.waiting)}{chip("moving", ORDER_COLORS.moving, "Parcels with rider", counts.moving)}
          {chip("failed", ORDER_COLORS.failed, "Failed", counts.failed)}{chip("hubs", "#1f1b17", "Hubs")}</div>
        <input placeholder="Find a rider (name/phone) or tracking number" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380 }} />
        {found.length > 0 && <div style={{ marginTop: 6 }}>{found.map((f) => <div key={f.href}><a href={f.href}>{f.text}</a></div>)}</div>}
        {error && <p className="error">{error}</p>}
      </div>
      <OpsMap marks={marks} height="70vh" fitKey={city ?? "all"} />
      <p className="muted">Refreshes every 10 seconds. Riders send their position every 10–15 s on a job and every minute when free.</p>
    </div>
  );
}
