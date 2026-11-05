"use client";
import { useState } from "react";
import { useRun } from "@/components/run";
import { rpcAction } from "@/lib/rpc-action";

/** Pause new bookings in a city (Hubtel outage, flooding, hub closed). Bookings already made carry on. */
export function CityPause({ cityId, cityName, pausedUntil, message, canEdit }:
  { cityId: string; cityName: string; pausedUntil: string | null; message: string | null; canEdit: boolean }) {
  const a = useRun();
  const [hours, setHours] = useState("2");
  const [msg, setMsg] = useState("");
  const paused = pausedUntil && new Date(pausedUntil) > new Date();
  const until = paused ? new Date(pausedUntil!).toLocaleString("en-GB", { timeZone: "Africa/Accra", weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <section className="card" style={{ borderLeft: paused ? "4px solid #c62828" : undefined }}>
      <strong>New bookings in {cityName}: {paused ? `PAUSED until ${until}` : "open"}</strong>
      {paused && <p style={{ margin: "6px 0" }}>Customers see: &quot;{message}&quot;</p>}
      <p className="muted" style={{ margin: "6px 0" }}>Pausing stops new bookings in the apps, portal and API, and shows your message at the top of both apps. Deliveries already booked carry on.</p>
      {canEdit && (paused ? (
        <button className="btn small secondary" disabled={a.pending} onClick={() => a.run(() => rpcAction("set_city_pause", { p_city: cityId, p_until: null, p_message: null }, "Bookings open again", "/zones"))}>Open bookings now</button>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={hours} onChange={(e) => setHours(e.target.value)}>
            {[["1", "1 hour"], ["2", "2 hours"], ["4", "4 hours"], ["8", "rest of the day (8 h)"], ["24", "24 hours"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input style={{ minWidth: 280 }} placeholder="Message for customers, e.g. Heavy rain: back at 2pm" value={msg} onChange={(e) => setMsg(e.target.value)} />
          <button className="btn small danger" disabled={a.pending || msg.trim().length < 3}
            onClick={() => a.run(() => rpcAction("set_city_pause", { p_city: cityId, p_until: new Date(Date.now() + Number(hours) * 3600_000).toISOString(), p_message: msg }, "Bookings paused", "/zones"))}>
            Pause bookings
          </button>
        </div>
      ))}
      <a.Msg />
    </section>
  );
}
