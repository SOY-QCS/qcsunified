"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { readSheet } from "read-excel-file/browser";
import { BULK_COLUMNS, checkBulkRows, problemsCsv, splitIntoTrips, type BulkProblem, type BulkRow } from "@qcs/types";
import { AddressField, emptyPlace, type PlaceValue } from "@/components/address-field";
import { api, ghs, type BookingResult, type QuoteResult } from "@/components/api";
import type { Party, VendorInfo } from "@/components/booking-form";

type Located = BulkRow & { dropoff: BulkRow["dropoff"] & { lat: number; lng: number } };

async function readFile(file: File): Promise<Record<string, unknown>[]> {
  if (/\.xlsx$/i.test(file.name)) {
    const sheet = await readSheet(file); // first sheet
    const [head, ...rows] = sheet;
    if (!head) return [];
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [String(h ?? ""), r[i] == null ? "" : String(r[i])])));
  }
  if (/\.xls$/i.test(file.name)) throw new Error("Old .xls files aren't supported — in Excel choose File → Save As → .xlsx or .csv");
  return new Promise((resolve, reject) => Papa.parse<Record<string, unknown>>(file, { header: true, skipEmptyLines: true, complete: (r) => resolve(r.data), error: reject }));
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}

/** Upload → check every row → find missing pins → price in trips of 25 → book all. */
export function BulkUpload({ vendor, me }: { vendor: VendorInfo; me: Party }) {
  const router = useRouter();
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Located[]>([]);
  const [problems, setProblems] = useState<BulkProblem[]>([]);
  const [pickup, setPickup] = useState<PlaceValue>(vendor.pickup ?? emptyPlace());
  const [payer, setPayer] = useState<"vendor_wallet" | "corporate_invoice">(vendor.accountType === "corporate" ? "corporate_invoice" : "vendor_wallet");
  const [quotes, setQuotes] = useState<QuoteResult[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name); setQuotes(null); setStatus("Reading the file…"); setRows([]); setProblems([]);
    try {
      const raw = await readFile(file);
      const checked = checkBulkRows(raw);
      const probs = [...checked.problems];
      let located = checked.rows;
      if (checked.needsLocation.length) {
        setStatus(`Finding pins for ${checked.needsLocation.length} addresses…`);
        const need = checked.rows.filter((r) => r.dropoff.lat == null);
        const { results, available } = await api<{ results: { row: number; location: { lat: number; lng: number } | null }[]; available: boolean }>(
          "/api/v1/geocode", { method: "POST", body: JSON.stringify({ rows: need.map((r) => ({ row: r.row, address: r.dropoff.formatted_address, landmark: r.dropoff.landmark, ghana_post_gps: r.dropoff.ghana_post_gps })) }) });
        located = checked.rows.map((r) => {
          const hit = results.find((x) => x.row === r.row)?.location;
          return hit ? { ...r, dropoff: { ...r.dropoff, ...hit } } : r;
        });
        located.filter((r) => r.dropoff.lat == null).forEach((r) => probs.push({ row: r.row, column: "latitude",
          message: available ? "Couldn't find this address on the map — add latitude/longitude or a clearer address" : "Add latitude and longitude (map search isn't switched on yet)" }));
      }
      const bad = new Set(probs.map((p) => p.row));
      setRows(located.filter((r) => r.dropoff.lat != null && !bad.has(r.row)) as Located[]);
      setProblems(probs.sort((a, b) => a.row - b.row));
      setStatus(null);
    } catch (e) {
      setStatus(null); setProblems([{ row: 0, column: "", message: (e as Error).message }]);
    }
  }

  function bookingFor(trip: Located[]) {
    return {
      service: "ecommerce", vendor_id: vendor.id, payer, payment_method: payer === "vendor_wallet" ? "wallet" : "invoice",
      pickup: { ...pickup, contact_name: vendor.pickup?.contact_name || me.name, contact_phone: vendor.pickup?.contact_phone || me.phone },
      dropoffs: trip.map((r) => r.dropoff),
    };
  }

  async function price() {
    if (pickup.lat == null) return setStatus("Set your pickup pin first.");
    setBusy(true); setStatus(null);
    const trips = splitIntoTrips(rows);
    try {
      const qs: QuoteResult[] = [];
      for (const t of trips) qs.push(await api<QuoteResult>("/api/v1/quotes", { method: "POST", body: JSON.stringify(bookingFor(t)) }));
      setQuotes(qs);
    } catch (e) {
      const a = e as { message: string; details?: string[] };
      setStatus([a.message, ...(a.details ?? [])].join(" · "));
    } finally { setBusy(false); }
  }

  async function bookAll() {
    if (!quotes) return;
    setBusy(true);
    const ids: string[] = [];
    try {
      for (const [i, q] of quotes.entries()) {
        setStatus(`Booking trip ${i + 1} of ${quotes.length}…`);
        const r = await api<BookingResult>("/api/v1/bookings", { method: "POST", body: JSON.stringify({ quote_id: q.quote_id }) });
        ids.push(...r.orders.map((o) => o.id));
      }
      router.push(`/booked?orders=${ids.join(",")}`);
    } catch (e) {
      setStatus(`${(e as Error).message}${ids.length ? ` — ${ids.length} orders were booked before this; see Orders.` : ""}`);
      setBusy(false);
    }
  }

  const total = quotes?.reduce((t, q) => t + q.totalPesewas, 0) ?? 0;
  return (
    <>
      <div className="card">
        <strong>1. Your file</strong>
        <p className="muted">CSV or Excel (.xlsx), one row per parcel. Columns: {BULK_COLUMNS.filter((c) => c.required).map((c) => c.label).join(", ")} (required), plus optional landmark, Ghana Post GPS, latitude/longitude, size, fragile, item, value, insure (yes/no — for items of GHS 1,000+, adds 5% of the value), cash to collect, instructions and your order number.</p>
        <a className="btn secondary small" href="/api/v1/bulk-template">Download template</a>
        <input type="file" accept=".csv,.xlsx,.xls" style={{ marginTop: 12 }} onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      {status && <p className="notice">{status}</p>}

      {(rows.length > 0 || problems.length > 0) && (
        <div className="card">
          <strong>2. Check</strong>
          <p>{fileName}: <strong>{rows.length}</strong> ready{problems.length > 0 && <>, <strong style={{ color: "var(--danger)" }}>{new Set(problems.map((p) => p.row)).size}</strong> need fixing</>}.</p>
          {problems.length > 0 && <>
            <table>
              <thead><tr><th>Row</th><th>Column</th><th>What to fix</th></tr></thead>
              <tbody>{problems.slice(0, 50).map((p, i) => <tr key={i} className="bad"><td>{p.row || "—"}</td><td>{p.column}</td><td>{p.message}</td></tr>)}</tbody>
            </table>
            {problems.length > 50 && <p className="muted">…and {problems.length - 50} more in the report.</p>}
            <button className="btn secondary small" style={{ marginTop: 8 }} onClick={() => download(`${fileName.replace(/\.\w+$/, "")}-problems.csv`, problemsCsv(problems))}>Download error report</button>
            <p className="muted">Fix these rows in your file and upload it again — or book the {rows.length} good rows now and upload the rest later.</p>
          </>}
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <strong>3. Pickup and payment</strong>
          <AddressField label="Pickup address" value={pickup} onChange={(v) => { setPickup(v); setQuotes(null); }} vendorId={vendor.id} />
          <label>Who pays the delivery fees?</label>
          <select value={payer} onChange={(e) => { setPayer(e.target.value as typeof payer); setQuotes(null); }}>
            {vendor.accountType === "corporate" && <option value="corporate_invoice">Monthly invoice</option>}
            <option value="vendor_wallet">My business wallet</option>
          </select>
          <p className="muted">{rows.length} parcels → {splitIntoTrips(rows).length} trip(s) of up to 25 drop-offs.</p>
          {!quotes ? (
            <button className="btn" onClick={price} disabled={busy}>{busy ? "Pricing…" : "Get price"}</button>
          ) : (
            <>
              {quotes.map((q, i) => <div key={q.quote_id} className="quote-line"><span>Trip {i + 1}: {q.stops.length} drop-offs{q.pickupDate ? ` · pickup ${q.pickupDate}` : ""}</span><span>{ghs(q.totalPesewas)}</span></div>)}
              <div className="quote-line total"><span>Total</span><span>{ghs(total)}</span></div>
              {[...new Set(quotes.flatMap((q) => q.notes))].map((n) => <p key={n} className="muted">• {n}</p>)}
              <button className="btn" onClick={bookAll} disabled={busy}>{busy ? "Booking…" : `Book ${rows.length} parcels`}</button>
            </>
          )}
        </div>
      )}
    </>
  );
}
