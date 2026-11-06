"use client";
import { useState } from "react";
import { BRAND_BLUE, BRAND_ORANGE } from "@qcs/config";

interface City { code: string; name: string; zones: { id: string; name: string }[] }
interface Rate { service: string; option: string | null; name: string; who: string; display: string; notes: string[] }
interface Result { from: string; to: string; rates: Rate[]; problems: string[] }

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const field = { width: "100%", padding: 12, fontSize: 16, borderRadius: 10, border: "1px solid #ccc", background: "#fff" } as const;

function AreaSelect({ label, cities, value, onChange }: { label: string; cities: City[]; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "block", marginBottom: 12, fontWeight: 600 }}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} required style={{ ...field, marginTop: 4 }}>
        <option value="">Choose an area</option>
        {cities.map((c) => (
          <optgroup key={c.code} label={c.name}>
            {c.zones.map((z) => <option key={z.id} value={z.id}>{z.name}, {c.name}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export function RateForm({ cities }: { cities: City[] }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kg, setKg] = useState("1");
  const [fragile, setFragile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await fetch(`${API}/api/v1/rates`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_zone: from, to_zone: to, weight_kg: Number(kg), fragile }) });
      const body = await r.json();
      if (!r.ok) setError([body.error, ...(body.details ?? [])].filter(Boolean).join(" "));
      else setResult(body as Result);
    } catch { setError("We couldn't check the price. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <>
      <form onSubmit={check} style={{ background: "#fff", padding: 16, borderRadius: 14, border: "1px solid #e6e1da" }}>
        <AreaSelect label="From" cities={cities} value={from} onChange={setFrom} />
        <AreaSelect label="To" cities={cities} value={to} onChange={setTo} />
        <label style={{ display: "block", marginBottom: 12, fontWeight: 600 }}>
          Weight (kg)
          <input type="number" inputMode="decimal" min="0.1" max="100" step="0.1" value={kg} onChange={(e) => setKg(e.target.value)} required style={{ ...field, marginTop: 4 }} />
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <input type="checkbox" checked={fragile} onChange={(e) => setFragile(e.target.checked)} style={{ width: 20, height: 20 }} /> Fragile
        </label>
        <button disabled={busy} style={{ width: "100%", padding: 14, borderRadius: 10, border: 0, background: BRAND_ORANGE, color: "#fff", fontWeight: 800, fontSize: 16 }}>
          {busy ? "Checking…" : "Check the price"}
        </button>
      </form>

      {error && <p role="alert" style={{ color: "#c0392b", marginTop: 16 }}>{error}</p>}
      {result && (
        <section aria-live="polite" style={{ marginTop: 20 }}>
          <p style={{ margin: "0 0 8px" }}>{result.from} → {result.to}</p>
          {result.rates.map((r) => (
            <div key={r.service + (r.option ?? "")} style={{ background: "#fff", borderRadius: 14, border: "1px solid #e6e1da", padding: 14, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                <strong>{r.name}</strong>
                <strong style={{ fontSize: 20, color: BRAND_BLUE, whiteSpace: "nowrap" }}>{r.display}</strong>
              </div>
              <div style={{ color: "#6b6b6b", fontSize: 14, marginTop: 4 }}>For: {r.who}</div>
              {r.notes.map((n) => <div key={n} style={{ color: "#6b6b6b", fontSize: 13, marginTop: 4 }}>{n}</div>)}
            </div>
          ))}
          {result.problems.map((p) => <p key={p} style={{ color: "#6b6b6b", fontSize: 14 }}>{p}</p>)}
          {!result.rates.length && <p>We don&apos;t have a price for this yet. Please message us on WhatsApp and we&apos;ll help.</p>}
        </section>
      )}
    </>
  );
}
