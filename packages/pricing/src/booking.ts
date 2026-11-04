/**
 * Price a whole booking: one Express drop-off, or 1–25 e-commerce drop-offs.
 * Inputs are already-validated booking details plus the facts the server looked up
 * (rules, zones, road distance). Pure: same inputs always give the same price.
 */
import { applyFlatPromo, insurancePremium, promoDiscount, quoteEcommerceStop, quoteExpress, quoteIntercity, PricingError, type QuoteLine } from "./engine";
import { expressRuleFor, flatPromoFor, laneFor, zoneBandsFor } from "./select";
import { deliveryDay, isNight } from "./time";
import type { NightWindow, PricingRuleRow, PromoCode } from "./rules";

export const MAX_BULK_STOPS = 25;

export interface StopInput {
  weightG: number; fragile: boolean; zoneId: string | null; distanceM?: number; durationS?: number;
  /** inter-city only: the hubs the parcel travels between, and whether it is delivered to the door at the end */
  originHubId?: string; destHubId?: string; doorstep?: boolean;
  declaredValue?: number;   // pesewas
  insured?: boolean;
}
/** Insurance settings (admin-editable): offered from `minValue` declared, premium = rate × declared value. */
export interface InsuranceSettings { rate: number; minValue: number }
export interface PriceBookingInput {
  service: "express" | "ecommerce" | "intercity";
  cityId: string;
  stops: StopInput[];
  rules: PricingRuleRow[];
  now: Date;
  pickupAt?: Date | null;        // scheduled pickup (null = now)
  cutoff: string;                // city same-day cut-off "09:00"
  nightWindow: NightWindow;
  surge: number;
  promo?: PromoCode | null;
  insurance?: InsuranceSettings;
}
/**
 * feePesewas = delivery fee before promo code; netPesewas = delivery fee after the promo code is shared out;
 * insurancePesewas = insurance premium (promo codes never reduce it); totalPesewas = net + insurance.
 */
export interface StopPrice { feePesewas: number; netPesewas: number; insurancePesewas: number; totalPesewas: number; lines: QuoteLine[] }
export interface BookingPrice {
  stops: StopPrice[];
  subtotalPesewas: number;      // delivery fees before promo
  discountPesewas: number;
  insurancePesewas: number;
  totalPesewas: number;         // what the client pays: delivery after promo + insurance
  pickupDate: string | null;     // e-commerce: the day it will be picked up
  notes: string[];
}

export function priceBooking(input: PriceBookingInput): BookingPrice {
  const { service, stops, rules, now } = input;
  if (stops.length === 0) throw new PricingError("Add at least one drop-off");
  if (service === "express" && stops.length !== 1) throw new PricingError("Express takes one drop-off. Use a bulk trip for several.");
  if (stops.length > MAX_BULK_STOPS) throw new PricingError(`A trip can have at most ${MAX_BULK_STOPS} drop-offs`);

  const notes: string[] = [];
  const at = input.pickupAt ?? now;
  let pickupDate: string | null = null;
  let priced: StopPrice[];

  if (service === "express") {
    const rule = expressRuleFor(rules, input.cityId, now);
    const s = stops[0]!;
    if (s.distanceM == null || s.durationS == null) throw new PricingError("Road distance missing for Express");
    const night = isNight(at, input.nightWindow);
    let q = quoteExpress(rule, { distanceM: s.distanceM, durationS: s.durationS, weightG: s.weightG, fragile: s.fragile, night, surge: input.surge });
    const flat = flatPromoFor(rules, input.cityId, s.zoneId, now);
    if (flat) q = applyFlatPromo(q, flat.flatFee, flat.name);
    priced = [{ feePesewas: q.totalPesewas, netPesewas: q.totalPesewas, insurancePesewas: 0, totalPesewas: q.totalPesewas, lines: q.lines }];
    notes.push("Express price is locked now — traffic won't change it.");
  } else if (service === "intercity") {
    // hub → hub lane price by weight band, plus the doorstep fee when delivered to the door (CLAUDE.md §5)
    priced = stops.map((s, i) => {
      if (!s.originHubId || !s.destHubId) throw new PricingError(`Drop-off ${i + 1}: no QCS hub serves that city yet`);
      try {
        const q = quoteIntercity(laneFor(rules, s.originHubId, s.destHubId, now), s.weightG, !!s.doorstep);
        return { feePesewas: q.totalPesewas, netPesewas: q.totalPesewas, insurancePesewas: 0, totalPesewas: q.totalPesewas, lines: q.lines };
      } catch (e) {
        throw new PricingError(`Drop-off ${i + 1}: ${(e as Error).message}`);
      }
    });
    const day = input.pickupAt ? { date: input.pickupAt.toISOString().slice(0, 10), sameDay: true } : deliveryDay(now, input.cutoff);
    pickupDate = day.date;
    if (!day.sameDay) notes.push(`Booked after the ${input.cutoff.slice(0, 5)} cut-off, so pickup is on ${day.date}.`);
    notes.push(stops.some((s) => s.doorstep) ? "Travels by bus between QCS hubs, then delivered to the door." : "Travels by bus between QCS hubs; the recipient collects it at the destination hub with their code.");
  } else {
    priced = stops.map((s, i) => {
      if (!s.zoneId) throw new PricingError(`Drop-off ${i + 1}: we don't deliver to that area yet`);
      try {
        let q = quoteEcommerceStop(zoneBandsFor(rules, s.zoneId, now), s.weightG);
        const flat = flatPromoFor(rules, input.cityId, s.zoneId, now);
        if (flat) q = applyFlatPromo(q, flat.flatFee, flat.name);
        return { feePesewas: q.totalPesewas, netPesewas: q.totalPesewas, insurancePesewas: 0, totalPesewas: q.totalPesewas, lines: q.lines };
      } catch (e) {
        throw new PricingError(`Drop-off ${i + 1}: ${(e as Error).message}`);
      }
    });
    if (input.pickupAt) {
      pickupDate = input.pickupAt.toISOString().slice(0, 10);
    } else {
      const day = deliveryDay(now, input.cutoff);
      pickupDate = day.date;
      if (!day.sameDay) notes.push(`Booked after the ${input.cutoff.slice(0, 5)} cut-off, so pickup is on ${day.date}.`);
    }
    notes.push("You pay per successful delivery. Failed or returned deliveries are charged 50%.");
  }

  const subtotal = priced.reduce((t, s) => t + s.feePesewas, 0);
  const discount = input.promo ? promoDiscount(subtotal, input.promo) : 0;
  shareDiscount(priced, discount, subtotal);

  // Insurance on high-value items (added after the promo code, which only applies to delivery fees).
  const ins = input.insurance ?? { rate: 0.05, minValue: 100_000 };
  let insuranceTotal = 0, uninsuredHighValue = 0;
  stops.forEach((s, i) => {
    const value = s.declaredValue ?? 0;
    const p = priced[i]!;
    if (s.insured) {
      if (value < ins.minValue) throw new PricingError(`Drop-off ${i + 1}: insurance is for items worth GHS ${(ins.minValue / 100).toLocaleString("en-GH")} or more`);
      p.insurancePesewas = insurancePremium(value, ins.rate);
      p.lines = [...p.lines, { label: `Insurance (${+(ins.rate * 100).toFixed(2)}% of GHS ${(value / 100).toLocaleString("en-GH")})`, pesewas: p.insurancePesewas }];
      insuranceTotal += p.insurancePesewas;
    } else if (value >= ins.minValue) {
      uninsuredHighValue++;
    }
    p.totalPesewas = p.netPesewas + p.insurancePesewas;
  });
  if (insuranceTotal) notes.push("Insured parcels are refunded in full if damaged or missing.");
  if (uninsuredHighValue) notes.push(`${uninsuredHighValue === 1 ? "This item is" : `${uninsuredHighValue} items are`} high value and not insured. If lost, uninsured parcels are compensated at 3× the delivery fee. Insure for ${+(ins.rate * 100).toFixed(2)}% of the declared value to be covered in full.`);

  return { stops: priced, subtotalPesewas: subtotal, discountPesewas: discount, insurancePesewas: insuranceTotal,
           totalPesewas: subtotal - discount + insuranceTotal, pickupDate, notes };
}

/** Spread a discount across stops in proportion to their fees (each order then shows its own net price). */
function shareDiscount(stops: StopPrice[], discount: number, subtotal: number) {
  if (!discount || !subtotal) return;
  const exact = stops.map((s) => (s.feePesewas * discount) / subtotal);
  const shares = exact.map(Math.floor);
  let left = discount - shares.reduce((a, b) => a + b, 0);
  exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac).forEach(({ i }) => { if (left > 0) { shares[i]! += 1; left--; } });
  stops.forEach((s, i) => {
    s.netPesewas = s.feePesewas - shares[i]!;
    if (shares[i]) s.lines = [...s.lines, { label: "Promo code", pesewas: -shares[i]! }];
  });
}
