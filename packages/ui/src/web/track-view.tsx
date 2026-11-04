"use client";
/**
 * Live tracking card used by the business portal and the public website.
 * Polls the tracking API every 10 seconds while the parcel is moving (riders report their position every 10–15 s,
 * so this is as "live" as the data) and stops polling once it's delivered.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { STATUS_LABELS, etaText, isFinished, isLive, RIDER_RATING_TAGS, whatsappLink, type TrackResult } from "@qcs/types";
import { colors } from "../index";
import { QcsMap, type MapPin } from "./map";

const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const card: React.CSSProperties = { background: "#fff", border: "1px solid #e6e1da", borderRadius: 14, padding: 16, marginBottom: 12 };
const btn: React.CSSProperties = { display: "inline-block", padding: "10px 14px", borderRadius: 10, background: colors.primary, color: "#fff", fontWeight: 700, textDecoration: "none", border: 0, cursor: "pointer" };
const btn2: React.CSSProperties = { ...btn, background: "#fff", color: colors.text, border: "1px solid #e6e1da" };

export function TrackView({ apiBase, tracking, mapsKey, askForCode = true, rateUrl, credentials }: {
  apiBase: string; tracking: string; mapsKey?: string; askForCode?: boolean;
  /** Where to POST a rating (portal only, signed in). */ rateUrl?: string;
  credentials?: RequestCredentials;
}) {
  const [last4, setLast4] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [r, setR] = useState<TrackResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = code ? `?last4=${encodeURIComponent(code)}` : "";
      const res = await fetch(`${apiBase}/api/v1/track/${encodeURIComponent(tracking)}${q}`, { cache: "no-store", credentials });
      const j = await res.json() as TrackResult & { error?: string };
      if (res.status === 404 || !j.found) { setR(null); setError("We couldn't find that tracking number. Check it and try again."); return; }
      if (!res.ok) throw new Error(j.error ?? "Try again");
      setR(j); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [apiBase, tracking, code, credentials]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (r?.status && isFinished(r.status)) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load, r?.status]);

  const pins = useMemo<MapPin[]>(() => {
    if (!r?.verified) return [];
    const p: MapPin[] = [];
    if (r.dropoff) p.push({ id: "drop", lat: r.dropoff.lat, lng: r.dropoff.lng, label: "Drop-off", color: colors.success });
    if (r.rider?.location) p.push({ id: "rider", lat: r.rider.location.lat, lng: r.rider.location.lng, label: "Rider" });
    if (r.status && ["ASSIGNED", "RIDER_AT_PICKUP"].includes(r.status) && r.pickup) p.push({ id: "pick", lat: r.pickup.lat, lng: r.pickup.lng, label: "Pickup", color: "#333" });
    return p;
  }, [r]);

  if (error && !r) return <div style={card}><p style={{ color: colors.danger, margin: 0 }}>{error}</p></div>;
  if (!r) return <div style={card}>Loading…</div>;
  const live = r.status ? isLive(r.status) : false;
  const eta = etaText(r.eta_minutes);

  return (
    <div>
      <div style={card}>
        <div style={{ color: colors.muted, fontSize: 13 }}>{r.tracking_number}</div>
        <div style={{ fontSize: 24, fontWeight: 900, margin: "4px 0" }}>{r.status ? STATUS_LABELS[r.status] : ""}</div>
        {eta && live && <div style={{ fontWeight: 700, color: colors.primary }}>{r.status === "ARRIVED_AT_DROPOFF" ? "The rider is at the door" : `Arrives ${eta}`}</div>}
        {r.verified && r.dropoff?.address && <div style={{ color: colors.muted, marginTop: 6 }}>To {r.recipient_name} · {r.dropoff.address}{r.dropoff.landmark ? ` (${r.dropoff.landmark})` : ""}</div>}
      </div>

      {!r.verified && askForCode && (
        <div style={card}>
          {r.locked
            ? <p style={{ margin: 0 }}>Too many wrong tries. Please wait an hour, or ask the sender for help.</p>
            : <form onSubmit={(e) => { e.preventDefault(); setCode(last4); }} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
                <label style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 13, color: colors.muted }}>To see the map and the rider, enter the last 4 digits of the recipient&apos;s phone number</div>
                  <input inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))}
                    style={{ fontSize: 20, letterSpacing: 6, padding: 8, width: 120, marginTop: 6, borderRadius: 8, border: "1px solid #ccc" }} />
                </label>
                <button style={btn} disabled={last4.length !== 4}>Show details</button>
                {code && !r.verified && <div style={{ color: colors.danger, width: "100%" }}>Those digits don&apos;t match.</div>}
              </form>}
        </div>
      )}

      {r.verified && live && pins.length > 0 && <div style={{ marginBottom: 12 }}><QcsMap apiKey={mapsKey} pins={pins} /></div>}

      {r.verified && r.rider && (
        <div style={{ ...card, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {r.rider.photo_url
            ? <img src={r.rider.photo_url} alt="" width={56} height={56} style={{ borderRadius: 28, objectFit: "cover" }} />
            : <div style={{ width: 56, height: 56, borderRadius: 28, background: colors.primary, color: "#fff", display: "grid", placeItems: "center", fontSize: 22, fontWeight: 800 }}>{r.rider.first_name.slice(0, 1)}</div>}
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontWeight: 800 }}>{r.rider.first_name} · ★ {Number(r.rider.rating).toFixed(1)}</div>
            <div style={{ color: colors.muted }}>{[r.rider.make_model ?? r.rider.vehicle, r.rider.plate].filter(Boolean).join(" · ")}</div>
          </div>
          {r.rider.phone && <div style={{ display: "flex", gap: 8 }}>
            <a style={btn} href={`tel:${r.rider.phone}`}>Call</a>
            <a style={btn2} href={whatsappLink(r.rider.phone, `Hello, I'm checking on QCS parcel ${r.tracking_number}`)} target="_blank" rel="noreferrer">WhatsApp</a>
          </div>}
        </div>
      )}

      {r.can_rate && rateUrl && <RateRider orderTn={r.tracking_number!} rateUrl={rateUrl} riderName={r.rider?.first_name ?? "your rider"} onDone={load} />}

      <div style={card}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>History</div>
        {[...(r.timeline ?? [])].reverse().map((e, i) => (
          <div key={i} style={{ display: "flex", gap: 10, padding: "6px 0", borderTop: i ? "1px solid #f0ebe4" : 0 }}>
            <div style={{ width: 10, height: 10, borderRadius: 5, marginTop: 5, background: i === 0 ? colors.primary : "#ccc" }} />
            <div style={{ flex: 1 }}>{STATUS_LABELS[e.status] ?? e.status}</div>
            <div style={{ color: colors.muted, fontSize: 13 }}>{when(e.at)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RateRider({ orderTn, rateUrl, riderName, onDone }: { orderTn: string; rateUrl: string; riderName: string; onDone: () => void }) {
  const [score, setScore] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const options = score >= 4 ? RIDER_RATING_TAGS.good : score ? RIDER_RATING_TAGS.bad : [];
  async function send() {
    const res = await fetch(rateUrl, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
      body: JSON.stringify({ tracking_number: orderTn, score, tags, comment: comment || undefined }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg(j.error ?? "Couldn't save the rating");
    setMsg("Thank you!"); onDone();
  }
  return (
    <div style={card}>
      <div style={{ fontWeight: 800 }}>How was {riderName}?</div>
      <div style={{ fontSize: 34, margin: "6px 0" }}>
        {[1, 2, 3, 4, 5].map((n) => <button key={n} onClick={() => { setScore(n); setTags([]); }} aria-label={`${n} stars`}
          style={{ background: "none", border: 0, cursor: "pointer", fontSize: 34, color: n <= score ? colors.primary : "#ccc" }}>★</button>)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {options.map((t) => <button key={t} onClick={() => setTags((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))}
          style={{ ...btn2, padding: "6px 10px", fontWeight: 500, background: tags.includes(t) ? "#fbeee4" : "#fff" }}>{t}</button>)}
      </div>
      {score > 0 && <>
        <textarea placeholder="Anything else? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
          style={{ width: "100%", marginTop: 8, borderRadius: 8, border: "1px solid #ccc", padding: 8 }} />
        <button style={{ ...btn, marginTop: 8 }} onClick={send}>Send rating</button>
      </>}
      {msg && <p>{msg}</p>}
    </div>
  );
}
