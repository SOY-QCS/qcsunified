/** Choosing which admin rule applies to a booking. */
import { EcommerceZoneRule, ExpressRule, FlatPromoRule, IntercityLaneRule, type PricingRuleRow } from "./rules";

const live = (r: PricingRuleRow, now: Date) =>
  r.is_active && (!r.valid_from || new Date(r.valid_from) <= now) && (!r.valid_to || new Date(r.valid_to) >= now);

export class MissingPriceError extends Error {}

export function expressRuleFor(rows: PricingRuleRow[], cityId: string, now: Date): ExpressRule {
  const r = rows.find((x) => x.rule_kind === "express" && x.city_id === cityId && !x.zone_id && live(x, now));
  if (!r) throw new MissingPriceError("Express prices aren't set for this city yet");
  return ExpressRule.parse(r.config);
}

export function zoneBandsFor(rows: PricingRuleRow[], zoneId: string, now: Date) {
  const r = rows.find((x) => x.rule_kind === "ecommerce_zone" && x.zone_id === zoneId && live(x, now));
  if (!r) throw new MissingPriceError("We don't deliver to that area yet");
  return EcommerceZoneRule.parse(r.config).bands;
}

export function laneFor(rows: PricingRuleRow[], originHubId: string, destHubId: string, now: Date) {
  const r = rows.find((x) => x.rule_kind === "intercity_lane" && x.origin_hub_id === originHubId && x.dest_hub_id === destHubId && live(x, now));
  if (!r) throw new MissingPriceError("That inter-city route isn't available yet");
  return IntercityLaneRule.parse(r.config);
}

/** The cheapest live flat-rate promo covering this drop-off (zone-specific or whole city), if any. */
export function flatPromoFor(rows: PricingRuleRow[], cityId: string, zoneId: string | null, now: Date): { name: string; flatFee: number } | null {
  const candidates = rows
    .filter((x) => x.rule_kind === "flat_promo" && live(x, now) && (x.zone_id ? x.zone_id === zoneId : x.city_id === cityId))
    .map((x) => ({ name: x.name ?? "Flat-rate offer", flatFee: FlatPromoRule.parse(x.config).flatFee }));
  return candidates.sort((a, b) => a.flatFee - b.flatFee)[0] ?? null;
}
