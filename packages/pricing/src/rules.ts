/**
 * The shape of every admin-editable price rule (stored as JSON in pricing_rules.config).
 * All money is integer pesewas (GHS 1 = 100). Weights in grams.
 */
import { z } from "zod";

const pesewas = z.number().int().min(0);

export const WeightBand = z.object({ maxG: z.number().int().positive(), feePesewas: pesewas });
export type WeightBand = z.infer<typeof WeightBand>;

const Bands = z.array(WeightBand).min(1).refine(
  (b) => new Set(b.map((x) => x.maxG)).size === b.length,
  "Two weight bands have the same upper limit",
);

export const ExpressRule = z.object({
  baseFee: pesewas,
  perKm: pesewas,
  perMinute: pesewas,
  weightSurcharges: Bands,
  fragileSurcharge: pesewas,
  nightSurcharge: pesewas,
  minimumFee: pesewas.optional(),
});
export type ExpressRule = z.infer<typeof ExpressRule>;

export const EcommerceZoneRule = z.object({ bands: Bands });
export type EcommerceZoneRule = z.infer<typeof EcommerceZoneRule>;

export const IntercityLaneRule = z.object({ bands: Bands, doorstepFee: pesewas });
export type IntercityLaneRule = z.infer<typeof IntercityLaneRule>;

export const FlatPromoRule = z.object({ flatFee: pesewas });
export type FlatPromoRule = z.infer<typeof FlatPromoRule>;

export const FulfilmentRule = z.object({ storagePerItemMonthly: pesewas, storagePerBinMonthly: pesewas, pickPackPerOrder: pesewas });
export const CsServiceRule = z.object({ feePerDeliveredOrder: pesewas });
export const RiderPayRule = z.object({ pickupFee: pesewas, perStopFee: pesewas });

export const RULE_SCHEMAS = {
  express: ExpressRule,
  ecommerce_zone: EcommerceZoneRule,
  intercity_lane: IntercityLaneRule,
  flat_promo: FlatPromoRule,
  fulfilment: FulfilmentRule,
  cs_service: CsServiceRule,
  rider_pay: RiderPayRule,
} as const;
export type RuleKind = keyof typeof RULE_SCHEMAS;

/** Night window, e.g. 20:00 → 06:00 (crosses midnight). */
export const NightWindow = z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) });
export type NightWindow = z.infer<typeof NightWindow>;

/** Surge multiplier: 1 = normal, 1.5 = +50%. Capped at 3× as a safety net. */
export const Surge = z.number().min(1).max(3);

/** Promo code (checked at quote time, counted at booking). */
export interface PromoCode { id: string; kind: "percent" | "fixed"; value: number; maxDiscount?: number | null }

/** A pricing_rules row as read from the database. */
export interface PricingRuleRow {
  id: string;
  name?: string;
  rule_kind: RuleKind;
  city_id: string | null;
  zone_id: string | null;
  origin_hub_id: string | null;
  dest_hub_id: string | null;
  config: unknown;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
}

/** Cedis typed by a person → pesewas. "25", "25.5", "25.50" → 2500, 2550, 2550. */
export function cedisToPesewas(input: string | number): number {
  const n = typeof input === "number" ? input : Number(String(input).replace(/[,\s]/g, "").replace(/^GH[S₵]?/i, ""));
  if (!Number.isFinite(n) || n < 0) throw new Error(`Not a valid amount: ${input}`);
  return Math.round(n * 100);
}
export const formatCedis = (p: number) => `GHS ${(p / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
