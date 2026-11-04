/**
 * QCS pricing engine — the ONLY place prices are calculated (CLAUDE.md §5).
 * All money is integer pesewas. All weights are grams. Distances metres, durations seconds.
 * Rates come from the `pricing_rules` table; this code never hard-codes a price.
 */

export const EXPRESS_MAX_WEIGHT_G = 15_000;
export const FAILED_OR_RETURN_RATE = 0.5;
export const PIN_CORRECTION_REPRICE_THRESHOLD_M = 1_000;

/** A weight band: applies when weight_g <= maxG (bands sorted ascending). */
export interface WeightBand { maxG: number; feePesewas: number }

export interface ExpressRule {
  baseFee: number;          // pesewas
  perKm: number;            // pesewas per km
  perMinute: number;        // pesewas per minute
  weightSurcharges: WeightBand[]; // surcharge by weight band
  fragileSurcharge: number;
  nightSurcharge: number;
  minimumFee?: number;
}

export interface QuoteLine { label: string; pesewas: number }
export interface Quote { totalPesewas: number; lines: QuoteLine[] }

export class PricingError extends Error {}

function bandFee(bands: WeightBand[], weightG: number): number {
  const sorted = [...bands].sort((a, b) => a.maxG - b.maxG);
  const band = sorted.find((b) => weightG <= b.maxG);
  if (!band) throw new PricingError(`No weight band covers ${weightG} g`);
  return band.feePesewas;
}

function sum(lines: QuoteLine[]): Quote {
  return { lines, totalPesewas: lines.reduce((t, l) => t + l.pesewas, 0) };
}

export interface ExpressInput {
  distanceM: number;
  durationS: number;
  weightG: number;
  fragile?: boolean;
  night?: boolean;
  /** Surge as a multiplier, e.g. 1.2 = +20%. Applied to the distance/time part only. */
  surge?: number;
}

/** Express: base + per-km + per-minute + surcharges. Over 15 kg is refused (bike-only). */
export function quoteExpress(rule: ExpressRule, input: ExpressInput): Quote {
  if (input.weightG > EXPRESS_MAX_WEIGHT_G) {
    throw new PricingError("Express is bike-only: parcels over 15 kg are refused");
  }
  const surge = input.surge ?? 1;
  const km = input.distanceM / 1000;
  const minutes = input.durationS / 60;
  const lines: QuoteLine[] = [
    { label: "Base fee", pesewas: rule.baseFee },
    { label: "Distance", pesewas: Math.round(km * rule.perKm * surge) },
    { label: "Time", pesewas: Math.round(minutes * rule.perMinute * surge) },
  ];
  const w = bandFee(rule.weightSurcharges, input.weightG);
  if (w) lines.push({ label: "Weight surcharge", pesewas: w });
  if (input.fragile) lines.push({ label: "Fragile", pesewas: rule.fragileSurcharge });
  if (input.night) lines.push({ label: "Night", pesewas: rule.nightSurcharge });
  const q = sum(lines);
  if (rule.minimumFee && q.totalPesewas < rule.minimumFee) {
    lines.push({ label: "Minimum fare top-up", pesewas: rule.minimumFee - q.totalPesewas });
    return sum(lines);
  }
  return q;
}

/** E-commerce/bulk: each stop is a fixed fee by weight band for its destination zone. */
export function quoteEcommerceStop(zoneBands: WeightBand[], weightG: number): Quote {
  return sum([{ label: "Delivery (per stop)", pesewas: bandFee(zoneBands, weightG) }]);
}

/** Inter-city: lane (origin hub → destination hub) fee by weight band, plus optional doorstep fee. */
export function quoteIntercity(laneBands: WeightBand[], weightG: number, doorstepFee?: number): Quote {
  const lines: QuoteLine[] = [{ label: "Inter-city lane", pesewas: bandFee(laneBands, weightG) }];
  if (doorstepFee) lines.push({ label: "Doorstep delivery", pesewas: doorstepFee });
  return sum(lines);
}

/** Flat-rate promo replaces the computed delivery fee (e.g. GHS 25 anywhere in Accra). */
export function applyFlatPromo(_quote: Quote, flatFee: number): Quote {
  return sum([{ label: "Flat-rate promo", pesewas: flatFee }]);
}

/** Failed and returned deliveries are charged 50% of the original delivery fee. */
export function failedOrReturnFee(originalFeePesewas: number): number {
  return Math.round(originalFeePesewas * FAILED_OR_RETURN_RATE);
}

/**
 * Express quotes are locked. A recipient pin correction re-prices only if the drop-off moved > 1 km.
 * Returns the extra amount to collect (never negative — no refund for a shorter trip).
 */
export function pinCorrectionExtra(lockedTotal: number, movedM: number, newQuoteTotal: number): number {
  if (movedM <= PIN_CORRECTION_REPRICE_THRESHOLD_M) return 0;
  return Math.max(0, newQuoteTotal - lockedTotal);
}
