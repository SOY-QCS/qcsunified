"use client";
/** The page the recipient opens from the SMS/WhatsApp link: confirm the pin, or drag it to the right place. No login. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { colors } from "../index";
import { QcsMap, type MapPin } from "./map";

interface Link { tracking_number: string; service_type: string; status: string; recipient_name: string; sender: string; address: string | null;
  landmark: string | null; gps: string | null; lat: number; lng: number; confirmation: string; can_change: boolean }
const card: React.CSSProperties = { background: "#fff", border: "1px solid #e6e1da", borderRadius: 14, padding: 16, marginBottom: 12 };
const btn: React.CSSProperties = { padding: "12px 16px", borderRadius: 10, background: colors.primary, color: "#fff", fontWeight: 800, border: 0, cursor: "pointer", fontSize: 16, width: "100%" };

export function ConfirmView({ apiBase, token, mapsKey }: { apiBase: string; token: string; mapsKey?: string }) {
  const [link, setLink] = useState<Link | null>(null);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [landmark, setLandmark] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/v1/confirm/${encodeURIComponent(token)}`).then(async (r) => {
      if (!r.ok) return setMsg("This link is not valid or has expired.");
      const j = await r.json() as Link; setLink(j); setLandmark(j.landmark ?? "");
    }).catch(() => setMsg("Couldn't load. Check your connection and try again."));
  }, [apiBase, token]);

  const onDrag = useCallback((_: string, p: { lat: number; lng: number }) => setPin(p), []);
  const pins = useMemo<MapPin[]>(() => (link ? [{ id: "me", ...(pin ?? { lat: link.lat, lng: link.lng }), label: "Drop-off", draggable: link.can_change }] : []), [link, pin]);

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition((p) => setPin({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setMsg("Couldn't get your location. Drag the pin instead."), { enableHighAccuracy: true, timeout: 10_000 });
  }
  async function send(body: unknown) {
    setState("busy"); setMsg(null);
    const r = await fetch(`${apiBase}/api/v1/confirm/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setState("idle"); return setMsg(j.error ?? "Something went wrong. Try again."); }
    setState("done");
    setMsg(j.extra > 0 ? `Saved. Because the new place is further away, the sender pays GHS ${(j.extra / 100).toFixed(2)} more.` : "Thank you! Your rider will come to this location.");
  }

  if (!link) return <div style={card}>{msg ?? "Loading…"}</div>;
  if (state === "done") return <div style={card}><h2 style={{ marginTop: 0 }}>✅ Done</h2><p>{msg}</p><p style={{ color: colors.muted }}>Parcel {link.tracking_number}</p></div>;
  return (
    <div>
      <div style={card}>
        <h2 style={{ margin: "0 0 6px" }}>Hello {link.recipient_name.split(" ")[0]} 👋</h2>
        <p style={{ margin: 0 }}><strong>{link.sender}</strong> is sending you a parcel ({link.tracking_number}). Is this where the rider should bring it?</p>
        {link.address && <p style={{ color: colors.muted, marginBottom: 0 }}>{link.address}{link.gps ? ` · ${link.gps}` : ""}</p>}
      </div>
      <QcsMap apiKey={mapsKey} pins={pins} height={360} onDrag={onDrag} fit={false} />
      {link.can_change ? <>
        <p style={{ color: colors.muted, fontSize: 14 }}>Wrong place? {mapsKey ? "Drag the pin, or " : "Stand at the delivery spot and "}<button onClick={useMyLocation} style={{ background: "none", border: 0, color: colors.primary, fontWeight: 700, padding: 0, cursor: "pointer" }}>use my current location</button>.</p>
        <div style={card}>
          <label>Landmark the rider can look for<input value={landmark} onChange={(e) => setLandmark(e.target.value)} placeholder="e.g. Blue gate opposite Shell"
            style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ccc", marginTop: 4 }} /></label>
          <label style={{ display: "block", marginTop: 8 }}>Note for the rider (optional)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Call when you reach the junction"
            style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ccc", marginTop: 4 }} /></label>
        </div>
        {pin || landmark !== (link.landmark ?? "") || note
          ? <button style={btn} disabled={state === "busy"} onClick={() => { const p = pin ?? { lat: link.lat, lng: link.lng }; send({ action: "move", ...p, landmark, note }); }}>Save this location</button>
          : <button style={btn} disabled={state === "busy"} onClick={() => send({ action: "confirm" })}>Yes, this is correct</button>}
        {link.service_type === "express" && <p style={{ color: colors.muted, fontSize: 13 }}>Moving the pin more than 1 km may change the delivery price for the sender.</p>}
      </> : <p style={{ color: colors.muted }}>The rider is already on the way or has arrived, so the location can&apos;t be changed here. Please call the rider.</p>}
      {msg && <p style={{ color: colors.danger }}>{msg}</p>}
    </div>
  );
}
