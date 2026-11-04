"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PACKAGE_SIZES, normalizeGhanaPhone } from "@qcs/types";
import { AddressField, emptyPlace, type PlaceValue } from "./address-field";
import { api, ApiProblem, ghs, type BookingResult, type QuoteResult } from "./api";

export interface Party { name: string; phone: string }
interface Stop { place: PlaceValue; recipient: Party; weightKg: string; size: string; fragile: boolean; item: string; valueGhs: string; insured: boolean; codGhs: string; instructions: string; ref: string }
const newStop = (): Stop => ({ place: emptyPlace(), recipient: { name: "", phone: "" }, weightKg: "1", size: "small", fragile: false, item: "", valueGhs: "", insured: false, codGhs: "", instructions: "", ref: "" });
const p = (ghsText: string) => Math.round(Number(ghsText || 0) * 100);

export interface VendorInfo { id: string; name: string; accountType: string; pickup: PlaceValue & { contact_name: string; contact_phone: string } | null }
export interface InsuranceInfo { rate: number; threshold: number }

/** One form for Express (1 drop-off) and e-commerce trips (up to 25 drop-offs). */
export function BookingForm({ vendor, me, insurance }: { vendor: VendorInfo; me: Party; insurance: InsuranceInfo }) {
  const router = useRouter();
  const [service, setService] = useState<"ecommerce" | "express">("ecommerce");
  const [pickup, setPickup] = useState<PlaceValue>(vendor.pickup ?? emptyPlace());
  const [sender, setSender] = useState<Party>({ name: vendor.pickup?.contact_name || me.name, phone: vendor.pickup?.contact_phone || me.phone });
  const [pickupNote, setPickupNote] = useState("");
  const [stops, setStops] = useState<Stop[]>([newStop()]);
  const [payer, setPayer] = useState<"vendor_wallet" | "corporate_invoice" | "sender">(vendor.accountType === "corporate" ? "corporate_invoice" : "vendor_wallet");
  const [method, setMethod] = useState<"momo" | "card" | "cash">("momo");
  const [when, setWhen] = useState("");
  const [promo, setPromo] = useState("");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const max = service === "express" ? 1 : 25;
  const setStop = (i: number, s: Partial<Stop>) => { setQuote(null); setStops(stops.map((x, j) => (j === i ? { ...x, ...s } : x))); };
  const anyCod = stops.some((s) => p(s.codGhs) > 0);

  function request() {
    const local: string[] = [];
    if (pickup.lat == null) local.push("Pickup: set the pin (search, saved address or your location)");
    stops.forEach((s, i) => {
      if (s.place.lat == null) local.push(`Drop-off ${i + 1}: set the pin`);
      if (!normalizeGhanaPhone(s.recipient.phone)) local.push(`Drop-off ${i + 1}: enter the recipient's Ghana phone number`);
    });
    if (local.length) throw new ApiProblem("Please check the booking", local);
    const payment_method = payer === "vendor_wallet" ? "wallet" : payer === "corporate_invoice" ? "invoice" : method;
    return {
      service, vendor_id: vendor.id, payer, payment_method, promo_code: promo || null,
      scheduled_at: when ? new Date(when).toISOString() : null,
      pickup: { ...pickup, contact_name: sender.name, contact_phone: sender.phone, instructions: pickupNote || null },
      dropoffs: stops.map((s) => ({
        ...s.place, contact_name: s.recipient.name, contact_phone: s.recipient.phone, instructions: s.instructions || null,
        weight_g: Math.round(Number(s.weightKg || 0) * 1000), size: s.size, fragile: s.fragile, item_description: s.item || null,
        item_value: p(s.valueGhs), insured: s.insured && p(s.valueGhs) >= insurance.threshold, cod_amount: p(s.codGhs), external_ref: s.ref || null,
      })),
    };
  }

  async function getQuote() {
    setBusy(true); setProblems([]); setQuote(null);
    try { setQuote(await api<QuoteResult>("/api/v1/quotes", { method: "POST", body: JSON.stringify(request()) })); }
    catch (e) { const a = e as ApiProblem; setProblems(a.details?.length ? a.details : [a.message]); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!quote) return;
    setBusy(true); setProblems([]);
    try {
      const r = await api<BookingResult>("/api/v1/bookings", { method: "POST", body: JSON.stringify({ quote_id: quote.quote_id }) });
      if (r.needs_payment) {
        // straight to Hubtel's payment page
        const pay = await api<{ checkout_url: string }>("/api/v1/payments", { method: "POST", body: JSON.stringify({ purpose: "order", order_ids: r.orders.map((o) => o.id) }) }).catch(() => null);
        if (pay) { window.location.href = pay.checkout_url; return; }
      }
      router.push(`/booked?orders=${r.orders.map((o) => o.id).join(",")}`);
    } catch (e) { setProblems([(e as Error).message]); setBusy(false); }
  }

  return (
    <div>
      <div className="card">
        <strong>Service</strong>
        <div className="tabs" style={{ marginTop: 8 }}>
          <button type="button" aria-pressed={service === "ecommerce"} onClick={() => { setService("ecommerce"); setQuote(null); }}>E-commerce trip (1–25 drop-offs)</button>
          <button type="button" aria-pressed={service === "express"} onClick={() => { setService("express"); setStops(stops.slice(0, 1)); setQuote(null); }}>Express (now, 1 drop-off, ≤15 kg)</button>
        </div>
        <p className="muted">{service === "ecommerce" ? "Priced per drop-off by zone and weight. You pay per successful delivery." : "Bike picks up now. Price by distance and time, locked when you confirm."}</p>
      </div>

      <div className="card">
        <strong>Pickup</strong>
        <AddressField label="Pickup address" value={pickup} onChange={(v) => { setPickup(v); setQuote(null); }} vendorId={vendor.id} />
        <div className="row">
          <div><label>Contact name</label><input value={sender.name} onChange={(e) => setSender({ ...sender, name: e.target.value })} /></div>
          <div><label>Contact phone</label><input value={sender.phone} onChange={(e) => setSender({ ...sender, phone: e.target.value })} /></div>
        </div>
        <label>Note for the rider at pickup</label><input value={pickupNote} onChange={(e) => setPickupNote(e.target.value)} placeholder="e.g. Ask for Ama at the counter" />
        <label>Pickup time</label>
        <input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setQuote(null); }} />
        <p className="muted">Leave empty for {service === "express" ? "now" : "the next pickup run (same day if before the cut-off)"}.</p>
      </div>

      {stops.map((s, i) => (
        <div className="card stop" key={i}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>Drop-off {i + 1}</strong>
            {stops.length > 1 && <button type="button" className="btn danger small" onClick={() => { setQuote(null); setStops(stops.filter((_, j) => j !== i)); }}>Remove</button>}
          </div>
          <AddressField label="Delivery address" value={s.place} onChange={(v) => setStop(i, { place: v })} vendorId={vendor.id}
            onSaved={(c) => setStop(i, { recipient: { name: c.contact_name ?? s.recipient.name, phone: c.contact_phone ?? s.recipient.phone } })} />
          <div className="row">
            <div><label>Recipient name</label><input value={s.recipient.name} onChange={(e) => setStop(i, { recipient: { ...s.recipient, name: e.target.value } })} /></div>
            <div><label>Recipient phone</label><input value={s.recipient.phone} onChange={(e) => setStop(i, { recipient: { ...s.recipient, phone: e.target.value } })} placeholder="024 123 4567" /></div>
          </div>
          <div className="row">
            <div><label>Weight (kg)</label><input inputMode="decimal" value={s.weightKg} onChange={(e) => setStop(i, { weightKg: e.target.value })} /></div>
            <div><label>Size</label><select value={s.size} onChange={(e) => setStop(i, { size: e.target.value })}>{PACKAGE_SIZES.map((z) => <option key={z.value} value={z.value}>{z.label} — {z.hint}</option>)}</select></div>
            <div><label>Item</label><input value={s.item} onChange={(e) => setStop(i, { item: e.target.value })} placeholder="2 dresses" /></div>
          </div>
          <div className="row">
            <div><label>Item value (GHS)</label><input inputMode="decimal" value={s.valueGhs} onChange={(e) => setStop(i, { valueGhs: e.target.value })} /></div>
            <div><label>Cash to collect (COD, GHS)</label><input inputMode="decimal" value={s.codGhs} onChange={(e) => setStop(i, { codGhs: e.target.value })} placeholder="0 = none" /></div>
            <div><label>Your order no.</label><input value={s.ref} onChange={(e) => setStop(i, { ref: e.target.value })} /></div>
          </div>
          {p(s.valueGhs) >= insurance.threshold && (
            <div className="notice" style={{ color: "var(--text)" }}>
              <strong>High-value item — insure it?</strong> Add {ghs(Math.round(p(s.valueGhs) * insurance.rate))} ({+(insurance.rate * 100).toFixed(2)}% of the declared value).
              Insured parcels are refunded in full if damaged or missing. Without insurance, a lost parcel is compensated at 3× the delivery fee.
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}><input type="checkbox" style={{ width: "auto" }} checked={s.insured} onChange={(e) => setStop(i, { insured: e.target.checked })} /> Yes, insure this parcel</label>
            </div>
          )}
          <label>Delivery instructions</label><input value={s.instructions} onChange={(e) => setStop(i, { instructions: e.target.value })} placeholder="e.g. Call on arrival, blue gate" />
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={s.fragile} onChange={(e) => setStop(i, { fragile: e.target.checked })} /> Fragile — handle with care</label>
        </div>
      ))}
      {stops.length < max && <button type="button" className="btn secondary" onClick={() => { setQuote(null); setStops([...stops, newStop()]); }}>+ Add drop-off ({stops.length}/{max})</button>}

      <div className="card" style={{ marginTop: 16 }}>
        <strong>Payment</strong>
        <label>Who pays the delivery fee?</label>
        <select value={payer} onChange={(e) => { setPayer(e.target.value as typeof payer); setQuote(null); }}>
          {vendor.accountType === "corporate" && <option value="corporate_invoice">Monthly invoice</option>}
          <option value="vendor_wallet">My business wallet</option>
          <option value="sender">Pay now / at pickup</option>
        </select>
        {payer === "sender" && (
          <select value={method} onChange={(e) => { setMethod(e.target.value as typeof method); setQuote(null); }} style={{ marginTop: 8 }}>
            <option value="momo">Mobile Money</option><option value="card">Card</option><option value="cash">Cash to rider at pickup</option>
          </select>
        )}
        {anyCod && <p className="muted">Cash collected from your customers is paid out to you in full on your payout schedule. Delivery fees are billed separately.</p>}
        <label>Promo code</label><input value={promo} onChange={(e) => { setPromo(e.target.value.toUpperCase()); setQuote(null); }} style={{ maxWidth: 220 }} />
      </div>

      {problems.length > 0 && <div className="error"><strong>Please fix:</strong><ul>{problems.map((x) => <li key={x}>{x}</li>)}</ul></div>}

      {!quote ? (
        <button className="btn block" onClick={getQuote} disabled={busy}>{busy ? "Getting price…" : "Get price"}</button>
      ) : (
        <div className="card">
          <strong>Your price</strong>
          {quote.stops.map((st, i) => (
            <div key={i} className="quote-line"><span>Drop-off {i + 1}: {stops[i]?.recipient.name}{st.insurancePesewas ? ` (incl. insurance ${ghs(st.insurancePesewas)})` : ""}</span><span>{ghs(st.totalPesewas)}</span></div>
          ))}
          {quote.discountPesewas > 0 && <div className="quote-line muted"><span>Promo code</span><span>−{ghs(quote.discountPesewas)}</span></div>}
          <div className="quote-line total"><span>Total</span><span>{ghs(quote.totalPesewas)}</span></div>
          {quote.notes.map((n) => <p key={n} className="muted">• {n}</p>)}
          <p className="muted">This price is held until {new Date(quote.expires_at).toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" })}.</p>
          <div className="row">
            <button className="btn" onClick={confirm} disabled={busy}>{busy ? "Booking…" : `Confirm booking (${stops.length} ${stops.length === 1 ? "parcel" : "parcels"})`}</button>
            <button className="btn secondary" onClick={() => setQuote(null)} disabled={busy}>Change details</button>
          </div>
        </div>
      )}
    </div>
  );
}
