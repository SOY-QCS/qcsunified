"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const TEXT: Record<string, { title: string; body: string }> = {
  paid: { title: "Payment received ✓", body: "Thank you. Your booking is confirmed." },
  failed: { title: "Payment didn't go through", body: "Nothing was taken. You can try again from your booking." },
  expired: { title: "Payment timed out", body: "This payment link has expired. Please book again." },
  cancelled: { title: "Payment cancelled", body: "You can pay later from your booking." },
  pending: { title: "Checking your payment…", body: "This usually takes a few seconds. Please approve the prompt on your phone if you paid by MoMo." },
};

function Status() {
  const sp = useSearchParams();
  const ref = sp.get("ref") ?? "";
  const app = sp.get("app") === "1";
  const [state, setState] = useState<string>(sp.get("cancelled") ? "cancelled" : "pending");

  useEffect(() => {
    if (state !== "pending" && state !== "initiated") return;
    let n = 0;
    const t = setInterval(async () => {
      n++;
      const r = await fetch(`/api/v1/payments/${ref}`).then((x) => x.json()).catch(() => null);
      if (r?.state && r.state !== "pending" && r.state !== "initiated") { setState(r.state); clearInterval(t); }
      if (n > 40) clearInterval(t);   // stop after ~2 minutes; the booking page will still update
    }, 3000);
    return () => clearInterval(t);
  }, [ref, state]);

  useEffect(() => {
    if (app && state !== "pending") window.location.href = `qcs-client://payment?ref=${ref}&state=${state}`;
  }, [app, ref, state]);

  const t = TEXT[state] ?? TEXT.pending!;
  return (
    <main className="auth-wrap">
      <div className="auth-card" style={{ textAlign: "center" }}>
        <div className="brand" style={{ justifyContent: "center" }}><span className="brand-mark">Q</span>QCS</div>
        <h1>{t.title}</h1>
        <p className="muted">{t.body}</p>
        {app ? <a className="btn block" href={`qcs-client://payment?ref=${ref}&state=${state}`}>Back to the QCS app</a>
             : <a className="btn block" href="/orders">See my orders</a>}
        <p className="muted" style={{ marginTop: 12, fontSize: ".8rem" }}>Reference {ref}</p>
      </div>
    </main>
  );
}

export default function PayReturn() {
  return <Suspense><Status /></Suspense>;
}
