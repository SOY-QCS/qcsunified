/**
 * Price a whole booking: one Express drop-off, or 1–25 e-commerce drop-offs.
 * Inputs are already-validated booking details plus the facts the server looked up
 * (rules, zones, road distance). Pure: same inputs always give the same price.
 */
import { applyFlatPromo, promoDiscount, quoteEcommerceStop, quoteExpress, PricingError, type QuoteLine } from "./engine";
import { expressRuleFor, flatPromoFor, zoneBandsFor } from "./select";
import { deliveryDay, isNight } from "./time";
import type { NightWindow, PricingRuleRow, PromoCode } from "./rules";

export const MAX_BULK_STOPS = 25;

export interface StopInput { weightG: number; fragile: boolean; zoneId: string | null; distanceM?: number; durationS?: number }
export interface PriceBookingInput {
  service: "express" | "ecommerce";
  cityId: string;
  stops: StopInput[];
  rules: PricingRuleRow[];
  now: Date;
  pickupAt?: Date | null;        // scheduled pickup (null = now)
  cutoff: string;                // city same-day cut-off "09:00"
  nightWindow: NightWindow;
  surge: number;
  promo?: PromoCode | null;
}
/** feePesewas = before promo code; netPesewas = what this stop actually costs after the promo code is shared out. */
export interface StopPrice { feePesewas: number; netPesewas: number; lines: QuoteLine[] }
export interface BookingPrice {
  stops: StopPrice[];
  subtotalPesewas: number;
  discountPesewas: number;
  totalPesewas: number;
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
    priced = [{ feePesewas: q.totalPesewas, netPesewas: q.totalPesewas, lines: q.lines }];
    notes.push("Express price is locked now — traffic won't change it.");
  } else {
    priced = stops.map((s, i) => {
      if (!s.zoneId) throw new PricingError(`Drop-off ${i + 1}: we don't deliver to that area yet`);
      try {
        let q = quoteEcommerceStop(zoneBandsFor(rules, s.zoneId, now), s.weightG);
        const flat = flatPromoFor(rules, input.cityId, s.zoneId, now);
        if (flat) q = applyFlatPromo(q, flat.flatFee, flat.name);
        return { feePesewas: q.totalPesewas, netPesewas: q.totalPesewas, lines: q.lines };
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
  return { stops: priced, subtotalPesewas: subtotal, discountPesewas: discount, totalPesewas: subtotal - discount, pickupDate, notes };
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
