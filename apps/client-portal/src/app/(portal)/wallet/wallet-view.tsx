"use client";
import { useEffect, useState } from "react";
import { api, ghs } from "@/components/api";

interface Wallet { vendors: { vendor_id: string; business_name: string; balance: number }[]; entries: { at: string; amount: number; kind: string; description: string }[] }

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + "01";

export function WalletView({ vendorId }: { vendorId: string }) {
  const [w, setW] = useState<Wallet | null>(null);
  const [amount, setAmount] = useState("200");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<Wallet>(`/api/v1/wallet?vendor_id=${vendorId}`).then(setW).catch((e) => setError(e.message)); }, [vendorId]);
  const balance = w?.vendors.find((v) => v.vendor_id === vendorId)?.balance ?? 0;

  async function topUp() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ checkout_url: string }>("/api/v1/payments", { method: "POST", body: JSON.stringify({ purpose: "wallet_topup", amount: Math.round(Number(amount) * 100), vendor_id: vendorId }) });
      window.location.href = r.checkout_url;
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  const statement = (format: "pdf" | "csv") => `/api/v1/statements?vendor_id=${vendorId}&from=${from}&to=${to}&format=${format}`;
  return (
    <>
      <div className="card">
        <span className="muted">Business wallet balance</span>
        <div className="total" style={{ color: balance < 0 ? "var(--danger)" : undefined }}>{ghs(balance)}</div>
        {balance < 0 && <p className="muted">A negative balance is delivery fees you owe. Top up to clear it — overdue fees hold back COD payouts.</p>}
        <div className="row" style={{ alignItems: "end" }}>
          <div><label>Top up (GHS)</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div><button className="btn" onClick={topUp} disabled={busy}>{busy ? "Opening Hubtel…" : "Top up with MoMo or card"}</button></div>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      <div className="card">
        <strong>Statement</strong>
        <p className="muted">Deliveries charged, refunds, top-ups, COD collected and remitted, and your balance.</p>
        <div className="row" style={{ alignItems: "end" }}>
          <div><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div style={{ display: "flex", gap: 6 }}>
            <a className="btn" href={statement("pdf")} target="_blank" rel="noreferrer">PDF</a>
            <a className="btn secondary" href={statement("csv")}>CSV (Excel)</a>
          </div>
        </div>
      </div>
      <table>
        <thead><tr><th>Date</th><th>What</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
        <tbody>
          {(w?.entries ?? []).map((e, i) => (
            <tr key={i}><td>{new Date(e.at).toLocaleString("en-GB", { timeZone: "Africa/Accra" })}</td><td>{e.description}</td>
              <td style={{ textAlign: "right", color: e.amount < 0 ? "var(--danger)" : "var(--success)" }}>{e.amount > 0 ? "+" : ""}{ghs(e.amount)}</td></tr>
          ))}
          {w && w.entries.length === 0 && <tr><td colSpan={3} className="muted">No wallet activity yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
