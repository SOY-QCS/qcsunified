"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { PRESETS } from "@/lib/period";

/** One row of filters above the charts: city, period (presets or exact dates), service. They live in the address bar, so a view can be shared. */
export function Filters({ cities, allowAll, from, to, preset, tab, showService = true }: {
  cities: { id: string; name: string }[]; allowAll: boolean; from: string; to: string; preset: string | null; tab: string; showService?: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const go = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams(sp.toString());
    u.set("tab", tab);
    for (const [k, v] of Object.entries(patch)) { if (v) u.set(k, v); else u.delete(k); }
    router.push(`/analytics?${u}`);
  };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "0 0 14px" }}>
      {(cities.length > 1 || allowAll) && <select value={sp.get("city") ?? ""} onChange={(e) => go({ city: e.target.value || null })} style={{ maxWidth: 180 }}>
        {allowAll && <option value="">All cities</option>}{cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      {PRESETS.map(([k, l]) => <button key={k} className={`btn small ${preset === k ? "" : "secondary"}`} onClick={() => go({ p: k, from: null, to: null })}>{l}</button>)}
      <input type="date" value={from} max={to} onChange={(e) => go({ from: e.target.value, to, p: null })} style={{ maxWidth: 150 }} aria-label="From" />
      <span>→</span>
      <input type="date" value={to} min={from} onChange={(e) => go({ from, to: e.target.value, p: null })} style={{ maxWidth: 150 }} aria-label="To" />
      {showService && <select value={sp.get("service") ?? ""} onChange={(e) => go({ service: e.target.value || null })} style={{ maxWidth: 160 }}>
        <option value="">All services</option><option value="express">Express</option><option value="ecommerce">E-commerce</option><option value="intercity">Inter-city</option></select>}
    </div>
  );
}
