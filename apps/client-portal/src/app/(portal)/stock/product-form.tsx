"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveProduct } from "./actions";

type P = { id: string; sku: string; name: string; barcode: string | null; weight_g: number; unit_value: number; low_stock_at: number } | null;

export function ProductForm({ vendorId, p }: { vendorId: string; p: P }) {
  const [f, setF] = useState({ sku: p?.sku ?? "", name: p?.name ?? "", barcode: p?.barcode ?? "", kg: p ? String(p.weight_g / 1000) : "0.5", ghs: p ? String(p.unit_value / 100) : "", low: String(p?.low_stock_at ?? 5) });
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const save = () => start(async () => {
    const r = await saveProduct(vendorId, p?.id ?? null, { sku: f.sku, name: f.name, barcode: f.barcode, weight_g: Math.round(Number(f.kg) * 1000), unit_value: Math.round(Number(f.ghs || 0) * 100), low_stock_at: Number(f.low) || 0 });
    setMsg(r.ok ? "Saved" : r.message);
    if (r.ok) { router.refresh(); if (!p) setF({ sku: "", name: "", barcode: "", kg: "0.5", ghs: "", low: "5" }); }
  });
  return (
    <tr>
      <td><input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value.toUpperCase() })} placeholder={p ? "" : "New: TSHIRT-M"} style={{ width: 120 }} /></td>
      <td><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Product name" /></td>
      <td><input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} placeholder="optional" style={{ width: 120 }} /></td>
      <td><input inputMode="decimal" value={f.kg} onChange={(e) => setF({ ...f, kg: e.target.value })} style={{ width: 60 }} /> kg</td>
      <td><input inputMode="decimal" value={f.ghs} onChange={(e) => setF({ ...f, ghs: e.target.value })} style={{ width: 80 }} placeholder="GHS" /></td>
      <td><input inputMode="numeric" value={f.low} onChange={(e) => setF({ ...f, low: e.target.value })} style={{ width: 60 }} /></td>
      <td><button className="btn small" disabled={pending || !f.sku || !f.name} onClick={save}>{p ? "Save" : "Add"}</button>{msg && <div className="muted">{msg}</div>}</td>
    </tr>
  );
}
