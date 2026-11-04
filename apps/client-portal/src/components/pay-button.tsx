"use client";
import { useState } from "react";
import { api } from "./api";

/** Starts a Hubtel checkout for unpaid orders and sends the person to Hubtel's payment page. */
export function PayButton({ orderIds, label = "Pay now" }: { orderIds: string[]; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pay() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ checkout_url: string }>("/api/v1/payments", { method: "POST", body: JSON.stringify({ purpose: "order", order_ids: orderIds }) });
      window.location.href = r.checkout_url;
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <>
    <button className="btn" onClick={pay} disabled={busy}>{busy ? "Opening Hubtel…" : label}</button>
    {error && <p className="error">{error}</p>}
  </>;
}
