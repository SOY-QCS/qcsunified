/** QCS pricing engine — the ONLY place prices are calculated (CLAUDE.md §5). */
import type { ExpressRule, IntercityLaneRule, PromoCode, WeightBand } from "./rules";

export const EXPRESS_MAX_WEIGHT_G = 15_000;
export const FAILED_OR_RETURN_RATE = 0.5;
export const PIN_CORRECTION_REPRICE_THRESHOLD_M = 1_000;

export interface QuoteLine { label: string; pesewas: number }
export interface Quote { totalPesewas: number; lines: QuoteLine[] }

export class PricingError extends Error {}

export function bandFee(bands: WeightBand[], weightG: number): number {
  const band = [...bands].sort((a, b) => a.maxG - b.maxG).find((b) => weightG <= b.maxG);
  if (!band) {
    const max = Math.max(...bands.map((b) => b.maxG));
    throw new PricingError(`Too heavy: ${(weightG / 1000).toFixed(1)} kg is over the ${(max / 1000).toFixed(0)} kg limit for this service`);
  }
  return band.feePesewas;
}

const total = (lines: QuoteLine[]): Quote => ({ lines, totalPesewas: lines.reduce((t, l) => t + l.pesewas, 0) });

export interface ExpressInput {
  distanceM: number;
  durationS: number;
  weightG: number;
  fragile?: boolean;
  night?: boolean;
  /** 1.2 = +20%. Applied to the distance and time part only. */
  surge?: number;
}

/** Express: base + per-km + per-minute + surcharges. Bike-only: over 15 kg is refused. */
export function quoteExpress(rule: ExpressRule, input: ExpressInput): Quote {
  if (input.weightG > EXPRESS_MAX_WEIGHT_G) throw new PricingError("Express is bike-only: parcels over 15 kg can't be sent by Express");
  if (input.weightG <= 0) throw new PricingError("Enter the parcel weight");
  const surge = input.surge ?? 1;
  const lines: QuoteLine[] = [
    { label: "Base fee", pesewas: rule.baseFee },
    { label: `Distance (${(input.distanceM / 1000).toFixed(1)} km)`, pesewas: Math.round((input.distanceM / 1000) * rule.perKm * surge) },
    { label: `Time (${Math.round(input.durationS / 60)} min)`, pesewas: Math.round((input.durationS / 60) * rule.perMinute * surge) },
  ];
  const w = bandFee(rule.weightSurcharges, input.weightG);
  if (w) lines.push({ label: "Weight surcharge", pesewas: w });
  if (input.fragile && rule.fragileSurcharge) lines.push({ label: "Fragile handling", pesewas: rule.fragileSurcharge });
  if (input.night && rule.nightSurcharge) lines.push({ label: "Night delivery", pesewas: rule.nightSurcharge });
  if (surge > 1) lines.push({ label: `Busy-time pricing ×${surge}`, pesewas: 0 });
  const q = total(lines);
  if (rule.minimumFee && q.totalPesewas < rule.minimumFee) {
    lines.push({ label: "Minimum fare top-up", pesewas: rule.minimumFee - q.totalPesewas });
    return total(lines);
  }
  return q;
}

/** E-commerce / bulk: each stop is a fixed fee by weight band for its destination zone. */
export function quoteEcommerceStop(zoneBands: WeightBand[], weightG: number): Quote {
  if (weightG <= 0) throw new PricingError("Enter the parcel weight");
  return total([{ label: "Delivery (per stop)", pesewas: bandFee(zoneBands, weightG) }]);
}

/** Inter-city: origin hub → destination hub lane by weight band, plus doorstep delivery if chosen. */
export function quoteIntercity(lane: IntercityLaneRule, weightG: number, doorstep: boolean): Quote {
  if (weightG <= 0) throw new PricingError("Enter the parcel weight");
  const lines: QuoteLine[] = [{ label: "Inter-city", pesewas: bandFee(lane.bands, weightG) }];
  if (doorstep && lane.doorstepFee) lines.push({ label: "Doorstep delivery", pesewas: lane.doorstepFee });
  return total(lines);
}

/** A flat-rate offer (e.g. GHS 25 anywhere in Accra) replaces the normal price — exactly the amount set, higher or lower. */
export function applyFlatPromo(_quote: Quote, flatFee: number, name = "Flat-rate offer"): Quote {
  return total([{ label: name, pesewas: flatFee }]);
}

/** Insurance for high-value items: a share of the declared value (5% by default), rounded to the pesewa. */
export function insurancePremium(declaredValuePesewas: number, rate: number): number {
  return Math.round(declaredValuePesewas * rate);
}

/** Promo code discount on a subtotal (never more than the subtotal). */
export function promoDiscount(subtotal: number, promo: PromoCode): number {
  const raw = promo.kind === "percent" ? Math.round((subtotal * promo.value) / 100) : promo.value;
  const capped = promo.maxDiscount ? Math.min(raw, promo.maxDiscount) : raw;
  return Math.max(0, Math.min(capped, subtotal));
}

/** Failed and returned deliveries are charged 50% of the original delivery fee. */
export function failedOrReturnFee(originalFeePesewas: number): number {
  return Math.round(originalFeePesewas * FAILED_OR_RETURN_RATE);
}

/** Express quotes are locked; a recipient pin correction re-prices only if the drop-off moved > 1 km. */
export function pinCorrectionExtra(lockedTotal: number, movedM: number, newQuoteTotal: number): number {
  if (movedM <= PIN_CORRECTION_REPRICE_THRESHOLD_M) return 0;
  return Math.max(0, newQuoteTotal - lockedTotal);
}
