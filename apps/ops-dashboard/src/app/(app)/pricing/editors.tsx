"use client";
import { useState, useTransition } from "react";
import type { WeightBand } from "@qcs/pricing";
import { createFlatPromo, createPromoCode, saveCitySetting, saveCutoff, saveInsurance, saveRule, setPromoActive, setRuleActive, type Result } from "./actions";

// People type cedis and kilograms; the database stores pesewas and grams.
const toGhs = (p: number) => (p / 100).toFixed(2);
const toP = (ghs: string) => Math.round(Number(ghs || 0) * 100);
const toKg = (g: number) => String(g / 1000);
const toG = (kg: string) => Math.round(Number(kg || 0) * 1000);

function useSave() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const run = (fn: () => Promise<Result>) => start(async () => setResult(await fn()));
  const Msg = () => (result ? <p className={result.ok ? "notice" : "error"}>{result.message}</p> : null);
  return { pending, run, Msg };
}

function Money({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <div><label>{label}</label><input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} /></div>;
}

/** Weight bands: "up to X kg costs GHS Y". */
function Bands({ bands, onChange, feeLabel = "Price (GHS)" }: { bands: { kg: string; ghs: string }[]; onChange: (b: { kg: string; ghs: string }[]) => void; feeLabel?: string }) {
  return (
    <table style={{ marginTop: 8 }}>
      <thead><tr><th>Up to (kg)</th><th>{feeLabel}</th><th /></tr></thead>
      <tbody>
        {bands.map((b, i) => (
          <tr key={i}>
            <td><input inputMode="decimal" value={b.kg} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, kg: e.target.value } : x)))} /></td>
            <td><input inputMode="decimal" value={b.ghs} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, ghs: e.target.value } : x)))} /></td>
            <td><button type="button" className="btn danger small" onClick={() => onChange(bands.filter((_, j) => j !== i))} disabled={bands.length === 1}>✕</button></td>
          </tr>
        ))}
        <tr><td colSpan={3}><button type="button" className="btn secondary small" onClick={() => onChange([...bands, { kg: "", ghs: "" }])}>+ Add weight band</button></td></tr>
      </tbody>
    </table>
  );
}
const fromBands = (b: WeightBand[]) => b.map((x) => ({ kg: toKg(x.maxG), ghs: toGhs(x.feePesewas) }));
const toBands = (b: { kg: string; ghs: string }[]): WeightBand[] => b.map((x) => ({ maxG: toG(x.kg), feePesewas: toP(x.ghs) })).sort((a, b) => a.maxG - b.maxG);

export interface ExpressConfig { baseFee: number; perKm: number; perMinute: number; minimumFee?: number; fragileSurcharge: number; nightSurcharge: number; weightSurcharges: WeightBand[] }

export function ExpressEditor({ ruleId, cityId, cityName, config, surge, night, canEdit }: {
  ruleId: string | null; cityId: string; cityName: string; config: ExpressConfig | null; surge: number; night: { start: string; end: string }; canEdit: boolean;
}) {
  const c = config ?? { baseFee: 1000, perKm: 300, perMinute: 20, minimumFee: 1500, fragileSurcharge: 300, nightSurcharge: 500, weightSurcharges: [{ maxG: 15000, feePesewas: 0 }] };
  const [f, setF] = useState({ base: toGhs(c.baseFee), km: toGhs(c.perKm), min: toGhs(c.perMinute), minimum: toGhs(c.minimumFee ?? 0), fragile: toGhs(c.fragileSurcharge), night: toGhs(c.nightSurcharge) });
  const [bands, setBands] = useState(fromBands(c.weightSurcharges));
  const [s, setS] = useState(String(surge));
  const [w, setW] = useState(night);
  const save = useSave(), saveS = useSave();
  const example = toP(f.base) + Math.round(5 * toP(f.km)) + Math.round(20 * toP(f.min));

  return (
    <div className="card">
      <strong>Express — {cityName}</strong>
      <p className="muted">Price = base + per km + per minute + surcharges. Bike-only, 15 kg max. Example: 5 km, 20 min ≈ GHS {toGhs(Math.max(example, toP(f.minimum)))}</p>
      <div className="row">
        <Money label="Base fee (GHS)" value={f.base} onChange={(v) => setF({ ...f, base: v })} />
        <Money label="Per km (GHS)" value={f.km} onChange={(v) => setF({ ...f, km: v })} />
        <Money label="Per minute (GHS)" value={f.min} onChange={(v) => setF({ ...f, min: v })} />
        <Money label="Minimum fare (GHS)" value={f.minimum} onChange={(v) => setF({ ...f, minimum: v })} />
      </div>
      <div className="row">
        <Money label="Fragile surcharge (GHS)" value={f.fragile} onChange={(v) => setF({ ...f, fragile: v })} />
        <Money label="Night surcharge (GHS)" value={f.night} onChange={(v) => setF({ ...f, night: v })} />
      </div>
      <label>Weight surcharges</label>
      <Bands bands={bands} onChange={setBands} feeLabel="Surcharge (GHS)" />
      {canEdit && <button className="btn" style={{ marginTop: 12 }} disabled={save.pending} onClick={() => save.run(() => saveRule({
        id: ruleId ?? undefined, kind: "express", name: `Express — ${cityName}`, city_id: cityId,
        config: { baseFee: toP(f.base), perKm: toP(f.km), perMinute: toP(f.min), minimumFee: toP(f.minimum) || undefined,
                  fragileSurcharge: toP(f.fragile), nightSurcharge: toP(f.night), weightSurcharges: toBands(bands) },
      }))}>Save Express prices</button>}
      <save.Msg />
      <h2>Busy times and night hours</h2>
      <div className="row">
        <div><label>Surge multiplier (1.0 = off)</label><input inputMode="decimal" value={s} onChange={(e) => setS(e.target.value)} /></div>
        <div><label>Night starts</label><input type="time" value={w.start} onChange={(e) => setW({ ...w, start: e.target.value })} /></div>
        <div><label>Night ends</label><input type="time" value={w.end} onChange={(e) => setW({ ...w, end: e.target.value })} /></div>
      </div>
      {canEdit && <button className="btn secondary" style={{ marginTop: 12 }} disabled={saveS.pending} onClick={() => saveS.run(async () => {
        const a = await saveCitySetting(cityId, "surge_multiplier", Number(s));
        return a.ok ? saveCitySetting(cityId, "night_window", w) : a;
      })}>Save surge and night hours</button>}
      <saveS.Msg />
    </div>
  );
}

export function CutoffEditor({ cityId, cutoff, canEdit }: { cityId: string; cutoff: string; canEdit: boolean }) {
  const [t, setT] = useState(cutoff.slice(0, 5));
  const save = useSave();
  return (
    <div className="card">
      <strong>Same-day cut-off</strong>
      <p className="muted">E-commerce orders booked before this time are picked up the same day; later ones the next working day.</p>
      <div className="row" style={{ alignItems: "end" }}>
        <div><label>Cut-off time</label><input type="time" value={t} onChange={(e) => setT(e.target.value)} /></div>
        <div>{canEdit && <button className="btn" disabled={save.pending} onClick={() => save.run(() => saveCutoff(cityId, t))}>Save cut-off</button>}</div>
      </div>
      <save.Msg />
    </div>
  );
}

export function ZoneEditor({ ruleId, cityId, zone, bands, canEdit }: { ruleId: string | null; cityId: string; zone: { id: string; name: string; code: string }; bands: WeightBand[] | null; canEdit: boolean }) {
  const [b, setB] = useState(fromBands(bands ?? [{ maxG: 2000, feePesewas: 2500 }]));
  const save = useSave();
  return (
    <details className="card">
      <summary><strong>{zone.name}</strong> <span className="muted">({zone.code}) — {bands ? b.map((x) => `≤${x.kg}kg GHS ${x.ghs}`).join(" · ") : "no prices yet"}</span></summary>
      <Bands bands={b} onChange={setB} />
      {canEdit && <button className="btn" style={{ marginTop: 12 }} disabled={save.pending} onClick={() => save.run(() => saveRule({
        id: ruleId ?? undefined, kind: "ecommerce_zone", name: `E-commerce — ${zone.name}`, city_id: cityId, zone_id: zone.id, config: { bands: toBands(b) },
      }))}>Save {zone.name}</button>}
      <save.Msg />
    </details>
  );
}

export function LaneEditor({ ruleId, cityId, from, to, config, canEdit }: {
  ruleId: string | null; cityId: string; from: { id: string; name: string }; to: { id: string; name: string };
  config: { bands: WeightBand[]; doorstepFee: number } | null; canEdit: boolean;
}) {
  const [b, setB] = useState(fromBands(config?.bands ?? [{ maxG: 5000, feePesewas: 5000 }]));
  const [door, setDoor] = useState(toGhs(config?.doorstepFee ?? 1500));
  const save = useSave();
  return (
    <details className="card">
      <summary><strong>{from.name} → {to.name}</strong> <span className="muted">{config ? `from GHS ${toGhs(Math.min(...config.bands.map((x) => x.feePesewas)))}` : "not set"}</span></summary>
      <Bands bands={b} onChange={setB} />
      <div className="row"><Money label="Doorstep delivery at destination (GHS)" value={door} onChange={setDoor} /></div>
      {canEdit && <button className="btn" style={{ marginTop: 12 }} disabled={save.pending} onClick={() => save.run(() => saveRule({
        id: ruleId ?? undefined, kind: "intercity_lane", name: `${from.name} → ${to.name}`, city_id: cityId, origin_hub_id: from.id, dest_hub_id: to.id,
        config: { bands: toBands(b), doorstepFee: toP(door) },
      }))}>Save lane</button>}
      <save.Msg />
    </details>
  );
}

export interface PromoRow { id: string; name: string; zone_id: string | null; flatFee: number; valid_from: string | null; valid_to: string | null; is_active: boolean }

export function PromoEditor({ cityId, zones, promos, canEdit }: { cityId: string; zones: { id: string; name: string }[]; promos: PromoRow[]; canEdit: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ name: "", zone: "", ghs: "25", from: today, to: today });
  const save = useSave(), toggle = useSave();
  const zoneName = (id: string | null) => (id ? zones.find((z) => z.id === id)?.name ?? "zone" : "Whole city");
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { timeZone: "Africa/Accra" }) : "—");
  return (
    <div className="card">
      <strong>Flat-rate offers</strong>
      <p className="muted">A fixed price for a zone (or the whole city) between two dates. Every delivery in that area is charged exactly this amount.</p>
      <table>
        <thead><tr><th>Offer</th><th>Where</th><th>Price</th><th>Dates</th><th /></tr></thead>
        <tbody>
          {promos.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td><td>{zoneName(p.zone_id)}</td><td>GHS {toGhs(p.flatFee)}</td><td>{fmt(p.valid_from)} – {fmt(p.valid_to)}</td>
              <td>{canEdit && <button className={`btn small ${p.is_active ? "danger" : "secondary"}`} onClick={() => toggle.run(() => setRuleActive(p.id, !p.is_active))}>{p.is_active ? "Switch off" : "Switch on"}</button>}</td>
            </tr>
          ))}
          {promos.length === 0 && <tr><td colSpan={5} className="muted">No offers yet.</td></tr>}
        </tbody>
      </table>
      <toggle.Msg />
      {canEdit && <>
        <h2>New offer</h2>
        <div className="row">
          <div><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="December GHS 25 anywhere" /></div>
          <div><label>Where</label><select value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}><option value="">Whole city</option>{zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></div>
          <Money label="Flat price (GHS)" value={f.ghs} onChange={(v) => setF({ ...f, ghs: v })} />
        </div>
        <div className="row">
          <div><label>From</label><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
          <div><label>To (inclusive)</label><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={save.pending} onClick={() => save.run(() => createFlatPromo({
          name: f.name, city_id: cityId, zone_id: f.zone || null, flatFee: toP(f.ghs),
          valid_from: new Date(`${f.from}T00:00:00Z`).toISOString(), valid_to: new Date(`${f.to}T23:59:59Z`).toISOString(),
        }))}>Create offer</button>
        <save.Msg />
      </>}
    </div>
  );
}

/** Insurance for high-value items (platform-wide; Finance and Super Admin). */
export function InsuranceEditor({ rate, threshold, canEdit }: { rate: number; threshold: number; canEdit: boolean }) {
  const [pct, setPct] = useState(String(+(rate * 100).toFixed(2)));
  const [min, setMin] = useState(toGhs(threshold));
  const save = useSave();
  const example = Math.round(toP("2000") * Number(pct || 0) / 100);
  return (
    <div className="card">
      <strong>Insurance for high-value items</strong>
      <p className="muted">Items declared at or above the threshold are offered insurance. The premium is added to the delivery fee. Insured parcels are refunded in full if damaged or missing. Example: GHS 2,000 item → GHS {toGhs(example)} premium.</p>
      <div className="row">
        <div><label>Premium (% of declared value)</label><input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /></div>
        <Money label="High-value threshold (GHS)" value={min} onChange={setMin} />
      </div>
      {canEdit ? <button className="btn" style={{ marginTop: 12 }} disabled={save.pending} onClick={() => save.run(() => saveInsurance(Number(pct) / 100, toP(min)))}>Save insurance</button>
               : <p className="muted">Only Finance or a Super Admin can change insurance.</p>}
      <save.Msg />
    </div>
  );
}

export interface PromoCodeRow { id: string; code: string; kind: "percent" | "fixed"; value: number; max_discount: number | null; service_type: string | null; max_uses: number | null; used_count: number; per_user_limit: number; valid_to: string | null; is_active: boolean }

export function PromoCodeEditor({ cityId, codes, canEdit }: { cityId: string; codes: PromoCodeRow[]; canEdit: boolean }) {
  const [f, setF] = useState({ code: "", kind: "percent" as "percent" | "fixed", value: "10", cap: "", service: "", uses: "", per: "1", to: "", wholeCountry: false });
  const save = useSave(), toggle = useSave();
  return (
    <div className="card">
      <strong>Promo codes</strong>
      <p className="muted">Customers type the code when booking. Discounts apply to delivery fees only (never to insurance).</p>
      <table>
        <thead><tr><th>Code</th><th>Discount</th><th>For</th><th>Used</th><th>Ends</th><th /></tr></thead>
        <tbody>
          {codes.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.code}</strong></td>
              <td>{c.kind === "percent" ? `${c.value}%${c.max_discount ? ` (max GHS ${toGhs(c.max_discount)})` : ""}` : `GHS ${toGhs(c.value)}`}</td>
              <td>{c.service_type ?? "All services"} · {c.per_user_limit}× per customer</td>
              <td>{c.used_count}{c.max_uses ? ` / ${c.max_uses}` : ""}</td>
              <td>{c.valid_to ? new Date(c.valid_to).toLocaleDateString("en-GB", { timeZone: "Africa/Accra" }) : "—"}</td>
              <td>{canEdit && <button className={`btn small ${c.is_active ? "danger" : "secondary"}`} onClick={() => toggle.run(() => setPromoActive(c.id, !c.is_active))}>{c.is_active ? "Switch off" : "Switch on"}</button>}</td>
            </tr>
          ))}
          {codes.length === 0 && <tr><td colSpan={6} className="muted">No promo codes yet.</td></tr>}
        </tbody>
      </table>
      <toggle.Msg />
      {canEdit && <>
        <h2>New promo code</h2>
        <div className="row">
          <div><label>Code</label><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="XMAS20" /></div>
          <div><label>Type</label><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "percent" | "fixed" })}><option value="percent">% off</option><option value="fixed">GHS off</option></select></div>
          <div><label>{f.kind === "percent" ? "Percent" : "Amount (GHS)"}</label><input inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></div>
          {f.kind === "percent" && <Money label="Max discount (GHS, optional)" value={f.cap} onChange={(v) => setF({ ...f, cap: v })} />}
        </div>
        <div className="row">
          <div><label>Service</label><select value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}><option value="">All</option><option value="express">Express</option><option value="ecommerce">E-commerce</option></select></div>
          <div><label>Total uses (optional)</label><input inputMode="numeric" value={f.uses} onChange={(e) => setF({ ...f, uses: e.target.value })} /></div>
          <div><label>Uses per customer</label><input inputMode="numeric" value={f.per} onChange={(e) => setF({ ...f, per: e.target.value })} /></div>
          <div><label>Ends (optional)</label><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}><input type="checkbox" style={{ width: "auto" }} checked={f.wholeCountry} onChange={(e) => setF({ ...f, wholeCountry: e.target.checked })} /> Valid in every city (otherwise this city only)</label>
        <button className="btn" style={{ marginTop: 12 }} disabled={save.pending} onClick={() => save.run(() => createPromoCode({
          code: f.code, kind: f.kind, value: f.kind === "percent" ? Math.round(Number(f.value)) : toP(f.value), max_discount: f.cap ? toP(f.cap) : null,
          city_id: f.wholeCountry ? null : cityId, service_type: (f.service || null) as "express" | "ecommerce" | null,
          max_uses: f.uses ? Number(f.uses) : null, per_user_limit: Number(f.per || 1),
          valid_from: new Date().toISOString(), valid_to: f.to ? new Date(`${f.to}T23:59:59Z`).toISOString() : null,
        }))}>Create code</button>
        <save.Msg />
      </>}
    </div>
  );
}
