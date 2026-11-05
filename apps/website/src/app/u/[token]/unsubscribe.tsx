"use client";
import { useState } from "react";
import { API } from "../../shell";

/** A button, not an automatic opt-out: link previews in WhatsApp/SMS apps open links and must not unsubscribe anyone. */
export function Unsubscribe({ token }: { token: string }) {
  const [state, setState] = useState<"ask" | "busy" | "done" | "bad">("ask");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  if (state === "done") return <><h1 style={{ fontSize: 22 }}>Done{name ? `, ${name}` : ""}.</h1><p>You won&apos;t receive QCS offers any more. Delivery updates about your parcels still come through.</p>
    <p>Changed your mind? Turn offers back on in the QCS app (Settings), or reply START on WhatsApp.</p></>;
  if (state === "bad") return <><h1 style={{ fontSize: 22 }}>This link doesn&apos;t work</h1><p>It may be incomplete. You can turn offers off in the QCS app (Settings), or reply STOP on WhatsApp.</p></>;
  return (
    <>
      <h1 style={{ fontSize: 22 }}>Stop receiving QCS offers?</h1>
      <p>You will still get messages about your own deliveries (delivery codes, rider on the way).</p>
      <button disabled={state === "busy"} style={{ background: "#df6518", color: "#fff", border: 0, borderRadius: 10, padding: "12px 18px", fontWeight: 700, fontSize: 16 }}
        onClick={async () => {
          setState("busy");
          try {
            const r = await (await fetch(`${API}/api/v1/unsubscribe/${encodeURIComponent(token)}`, { method: "POST" })).json() as { ok: boolean; name?: string };
            if (r.ok) { setName(r.name ?? ""); setState("done"); } else setState("bad");
          } catch { setState("ask"); setErr("Please check your connection and try again."); }
        }}>Yes, stop offers</button>
      {err && <p style={{ color: "#c0392b" }}>{err}</p>}
    </>
  );
}
