import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NightWindow, priceBooking, PricingError, MissingPriceError, type PricingRuleRow } from "@qcs/pricing";
import { ApiError } from "./supabase";
import { straightLineM, type LatLng } from "./maps";

/**
 * The public rate calculator on the website: "from this area to that area, this heavy".
 * Uses the same pricing engine and price list as a real booking, but nothing is saved and no map service is
 * called (Express distance is estimated from the straight line), so it costs nothing and can't be abused.
 */

export interface PublicZone { id: string; name: string; lat: number; lng: number }
export interface PublicHub { id: string; code: string; name: string; address: string; phone: string | null; opening_hours: Record<string, [string, string]>; lat: number; lng: number }
export interface PublicCity { code: string; name: string; cutoff: string; zones: PublicZone[]; hubs: PublicHub[] }

export interface PublicRateDeps {
  places: () => Promise<PublicCity[]>;
  cityId: (code: string) => Promise<string>;
  rulesFor: (cityId: string) => Promise<PricingRuleRow[]>;
  setting: (key: string, cityId: string) => Promise<unknown>;
  now?: Date;
}

export const PublicRateRequest = z.object({
  from_zone: z.uuid("Choose where it is picked up"),
  to_zone: z.uuid("Choose where it goes"),
  weight_kg: z.coerce.number().positive("Enter the weight").max(100, "For parcels over 100 kg, please call us"),
  fragile: z.coerce.boolean().optional().default(false),
});

/** Roads are longer than the straight line; 1.3 is a common rule of thumb for city streets. */
const ROAD_FACTOR = 1.3;
const SPEED_KMH = 22;

export interface PublicRate { service: "express" | "ecommerce" | "intercity"; option: "doorstep" | "hub_collection" | null; name: string; who: string; amount: number; display: string; notes: string[] }

export async function publicRates(body: unknown, deps: PublicRateDeps): Promise<{ from: string; to: string; rates: PublicRate[]; problems: string[] }> {
  const p = PublicRateRequest.safeParse(body);
  if (!p.success) throw new ApiError(400, "Please check the details", p.error.issues.map((i) => i.message));
  const r = p.data;
  const cities = await deps.places();
  const find = (id: string) => {
    for (const c of cities) { const z = c.zones.find((x) => x.id === id); if (z) return { city: c, zone: z }; }
    throw new ApiError(400, "We don't deliver to that area yet");
  };
  const from = find(r.from_zone), to = find(r.to_zone);
  const sameCity = from.city.code === to.city.code;
  const cityId = await deps.cityId(from.city.code);
  const now = deps.now ?? new Date();
  const [rules, nightRaw, surgeRaw] = await Promise.all([deps.rulesFor(cityId), deps.setting("night_window", cityId), deps.setting("surge_multiplier", cityId)]);
  const nightWindow = NightWindow.safeParse(nightRaw).success ? NightWindow.parse(nightRaw) : { start: "20:00", end: "06:00" };
  const surge = Math.min(3, Math.max(1, Number(surgeRaw ?? 1) || 1));
  const weightG = Math.round(r.weight_kg * 1000);
  const base = { weightG, fragile: r.fragile, zoneId: to.zone.id };
  const common = { cityId, rules, now, cutoff: from.city.cutoff, nightWindow, surge, promo: null };

  const options: { service: PublicRate["service"]; option: PublicRate["option"]; name: string; who: string; stop: Parameters<typeof priceBooking>[0]["stops"][number]; note?: string }[] = [];
  if (sameCity) {
    const km = (straightLineM(from.zone, to.zone) * ROAD_FACTOR) / 1000;
    const distanceM = Math.max(1000, Math.round(km * 1000));
    options.push({ service: "express", option: null, name: "Express (same day, on a bike)", who: "Everyone",
                   stop: { ...base, distanceM, durationS: Math.round((distanceM / 1000 / SPEED_KMH) * 3600) },
                   note: "Estimate: the exact price uses the real road distance between your two addresses when you book, and is then fixed." });
    options.push({ service: "ecommerce", option: null, name: "E-commerce delivery (next pickup round)", who: "Online shops with a business account", stop: base });
  } else {
    const nearest = (hubs: PublicHub[], pt: LatLng) => [...hubs].sort((a, b) => straightLineM(a, pt) - straightLineM(b, pt))[0];
    const o = nearest(from.city.hubs, from.zone), d = nearest(to.city.hubs, to.zone);
    for (const doorstep of [true, false]) {
      options.push({ service: "intercity", option: doorstep ? "doorstep" : "hub_collection",
                     name: doorstep ? `Inter-city to ${to.city.name}, delivered to the door` : `Inter-city to ${to.city.name}, collect at the ${d?.name ?? "QCS hub"}`,
                     who: "Everyone", stop: { ...base, originHubId: o?.id, destHubId: d?.id, doorstep } });
    }
  }

  const rates: PublicRate[] = [];
  const problems: string[] = [];
  for (const o of options) {
    if (o.service === "express" && weightG > 15_000) { problems.push("Express is bike-only, up to 15 kg."); continue; }
    try {
      const q = priceBooking({ ...common, service: o.service, stops: [o.stop] });
      rates.push({ service: o.service, option: o.option, name: o.name, who: o.who, amount: q.totalPesewas,
                   display: `GHS ${(q.totalPesewas / 100).toFixed(2)}`, notes: [o.note, ...q.notes.filter((n) => !/locked now/i.test(n))].filter((n): n is string => !!n) });   // nothing is locked on the calculator
    } catch (e) {
      if (e instanceof PricingError || e instanceof MissingPriceError) problems.push(e.message); else throw e;
    }
  }
  return { from: `${from.zone.name}, ${from.city.name}`, to: `${to.zone.name}, ${to.city.name}`, rates, problems: [...new Set(problems)] };
}

/** Real dependencies: the service-role database. */
export function publicDeps(service: SupabaseClient): PublicRateDeps {
  return {
    places: () => publicPlaces(service),
    cityId: async (code) => (await service.from("cities").select("id").eq("code", code).single()).data?.id as string,
    rulesFor: async (cityId) => {
      const { data, error } = await service.from("pricing_rules").select("*").eq("is_active", true).or(`city_id.eq.${cityId},city_id.is.null`);
      if (error) throw error;
      return data as PricingRuleRow[];
    },
    setting: async (key, cityId) => {
      const { data } = await service.from("app_settings").select("value, city_id").eq("key", key).or(`city_id.eq.${cityId},city_id.is.null`);
      return (data ?? []).sort((a, b) => (a.city_id ? -1 : 1) - (b.city_id ? -1 : 1))[0]?.value;
    },
  };
}

export async function publicPlaces(service: SupabaseClient): Promise<PublicCity[]> {
  const { data, error } = await service.rpc("public_places");
  if (error) throw error;
  return (data ?? []) as PublicCity[];
}
