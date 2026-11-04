import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BookingRequest, bookingProblems } from "@qcs/types";
import { NightWindow, priceBooking, PricingError, MissingPriceError, type PricingRuleRow, type PromoCode } from "@qcs/pricing";
import { DEFAULT_HIGH_VALUE_PESEWAS, DEFAULT_INSURANCE_RATE } from "@qcs/config";
import { ApiError } from "./supabase";
import { roadRoute, type LatLng } from "./maps";

/** Everything the quote needs from the outside world — passed in so it can be tested without a database. */
export interface QuoteDeps {
  userId: string;
  vendorIds: string[];                                            // vendors this user may book for
  zoneFor: (p: LatLng) => Promise<{ zone_id: string; city_id: string; city_code: string } | null>;
  rulesFor: (cityId: string) => Promise<PricingRuleRow[]>;
  cityCutoff: (cityId: string) => Promise<string>;
  setting: (key: string, cityId: string) => Promise<unknown>;
  promo: (code: string, cityId: string, service: "express" | "ecommerce") => Promise<PromoCode>;
  route: typeof roadRoute;
  saveQuote: (q: { user_id: string; vendor_id: string | null; service_type: string; city_id: string; request: unknown; price: unknown; zones: (string | null)[]; promo_code_id: string | null; total: number }) => Promise<{ id: string; expires_at: string }>;
  now?: Date;
}

export async function buildQuote(body: unknown, deps: QuoteDeps) {
  const parsed = BookingRequest.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "Please check the booking details", bookingProblems(parsed.error));
  const req = parsed.data;
  if (req.vendor_id && !deps.vendorIds.includes(req.vendor_id)) throw new ApiError(403, "You can't book for that business");

  const pickupZone = await deps.zoneFor(req.pickup);
  if (!pickupZone) throw new ApiError(400, "We don't pick up from that area yet", ["Pickup: outside our service areas"]);
  const cityId = pickupZone.city_id;

  const zones = await Promise.all(req.dropoffs.map((d) => deps.zoneFor(d)));
  const problems: string[] = [];
  zones.forEach((z, i) => {
    if (!z) problems.push(`Drop-off ${i + 1}: outside our delivery areas`);
    else if (z.city_id !== cityId) problems.push(`Drop-off ${i + 1}: in another city — inter-city booking is coming soon`);
  });
  if (problems.length) throw new ApiError(400, "Some drop-offs can't be delivered", problems);

  const now = deps.now ?? new Date();
  const [rules, cutoff, nightRaw, surgeRaw, rateRaw, minRaw] = await Promise.all([
    deps.rulesFor(cityId), deps.cityCutoff(cityId), deps.setting("night_window", cityId), deps.setting("surge_multiplier", cityId),
    deps.setting("insurance_rate", cityId), deps.setting("high_value_threshold", cityId),
  ]);
  const insurance = {
    rate: Number.isFinite(Number(rateRaw)) && Number(rateRaw) > 0 ? Number(rateRaw) : DEFAULT_INSURANCE_RATE,
    minValue: Number.isFinite(Number(minRaw)) && Number(minRaw) > 0 ? Number(minRaw) : DEFAULT_HIGH_VALUE_PESEWAS,
  };
  const nightWindow = NightWindow.safeParse(nightRaw).success ? NightWindow.parse(nightRaw) : { start: "20:00", end: "06:00" };
  const surge = Math.min(3, Math.max(1, Number(surgeRaw ?? 1) || 1));

  let promo: (PromoCode & { id: string }) | null = null;
  if (req.promo_code) {
    try { promo = await deps.promo(req.promo_code, cityId, req.service) as PromoCode & { id: string }; }
    catch (e) { throw new ApiError(400, (e as Error).message, [(e as Error).message]); }
  }

  let estimatedRoute = false;
  const stops = await Promise.all(req.dropoffs.map(async (d, i) => {
    const base = { weightG: d.weight_g, fragile: d.fragile, zoneId: zones[i]!.zone_id, declaredValue: d.item_value, insured: d.insured };
    if (req.service !== "express") return base;
    const r = await deps.route(req.pickup, d);
    estimatedRoute ||= r.estimated;
    return { ...base, distanceM: r.distanceM, durationS: r.durationS };
  }));

  let price;
  try {
    price = priceBooking({
      service: req.service, cityId, stops, rules, now, cutoff, nightWindow, surge, promo, insurance,
      pickupAt: req.scheduled_at ? new Date(req.scheduled_at) : null,
    });
  } catch (e) {
    if (e instanceof PricingError || e instanceof MissingPriceError) throw new ApiError(400, e.message, [e.message]);
    throw e;
  }
  if (estimatedRoute) price.notes.push("Distance estimated (map service unavailable).");

  const saved = await deps.saveQuote({
    user_id: deps.userId, vendor_id: req.vendor_id ?? null, service_type: req.service, city_id: cityId,
    request: req, price, zones: zones.map((z) => z!.zone_id), promo_code_id: promo?.id ?? null, total: price.totalPesewas,
  });
  return { quote_id: saved.id, expires_at: saved.expires_at, city: pickupZone.city_code, ...price };
}

/** Real dependencies: the service-role database plus Google. */
export function liveDeps(service: SupabaseClient, userId: string, vendorIds: string[]): QuoteDeps {
  return {
    userId, vendorIds, route: roadRoute,
    zoneFor: async (p) => {
      const { data } = await service.rpc("zone_for_point", { p_lng: p.lng, p_lat: p.lat });
      return (data as { zone_id: string; city_id: string; city_code: string }[] | null)?.[0] ?? null;
    },
    rulesFor: async (cityId) => {
      const { data, error } = await service.from("pricing_rules").select("*").eq("is_active", true).or(`city_id.eq.${cityId},city_id.is.null`);
      if (error) throw error;
      return data as PricingRuleRow[];
    },
    cityCutoff: async (cityId) => (await service.from("cities").select("same_day_cutoff").eq("id", cityId).single()).data?.same_day_cutoff ?? "09:00",
    setting: async (key, cityId) => {
      const { data } = await service.from("app_settings").select("value, city_id").eq("key", key).or(`city_id.eq.${cityId},city_id.is.null`);
      return (data ?? []).sort((a, b) => (a.city_id ? -1 : 1) - (b.city_id ? -1 : 1))[0]?.value;
    },
    promo: async (code, cityId, svc) => {
      const { data, error } = await service.rpc("check_promo", { p_code: code, p_user: userId, p_service: svc, p_city: cityId });
      if (error) throw new Error(error.message);
      return { id: data.id, kind: data.kind, value: data.value, maxDiscount: data.max_discount };
    },
    saveQuote: async (q) => {
      const { data, error } = await service.from("quotes").insert(q).select("id, expires_at").single();
      if (error) throw error;
      return data;
    },
  };
}
