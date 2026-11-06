import { describe, expect, it } from "vitest";
import type { PricingRuleRow } from "@qcs/pricing";
import { publicRates, type PublicCity, type PublicRateDeps } from "./public-rates";
import { ApiError } from "./supabase";

const OSU = "11111111-1111-4111-8111-111111111111", MADINA = "22222222-2222-4222-8222-222222222222", ADUM = "33333333-3333-4333-8333-333333333333";
const hub = (id: string, name: string, lat: number, lng: number) => ({ id, code: id, name, address: "", phone: null, opening_hours: {}, lat, lng });
const cities: PublicCity[] = [
  { code: "ACC", name: "Accra", cutoff: "09:00", zones: [{ id: OSU, name: "Osu", lat: 5.556, lng: -0.178 }, { id: MADINA, name: "Madina", lat: 5.68, lng: -0.165 }],
    hubs: [hub("acc-hub", "Accra Hub", 5.57, -0.23)] },
  { code: "KSI", name: "Kumasi", cutoff: "09:00", zones: [{ id: ADUM, name: "Adum", lat: 6.69, lng: -1.62 }], hubs: [hub("ksi-hub", "Kumasi Hub", 6.7, -1.63)] },
];
const rule = (o: Partial<PricingRuleRow>): PricingRuleRow => ({ id: "x", rule_kind: "express", city_id: "acc", zone_id: null, origin_hub_id: null, dest_hub_id: null,
  valid_from: null, valid_to: null, is_active: true, config: {}, ...o });
const rules: PricingRuleRow[] = [
  rule({ id: "1", config: { baseFee: 1000, perKm: 300, perMinute: 20, weightSurcharges: [{ maxG: 15000, feePesewas: 0 }], fragileSurcharge: 300, nightSurcharge: 500 } }),
  rule({ id: "2", rule_kind: "ecommerce_zone", zone_id: MADINA, config: { bands: [{ maxG: 5000, feePesewas: 2500 }] } }),
  rule({ id: "3", rule_kind: "intercity_lane", origin_hub_id: "acc-hub", dest_hub_id: "ksi-hub", config: { bands: [{ maxG: 5000, feePesewas: 5000 }], doorstepFee: 1500 } }),
];
const deps = (o: Partial<PublicRateDeps> = {}): PublicRateDeps => ({
  places: async () => cities, cityId: async () => "acc", rulesFor: async () => rules, setting: async () => undefined,
  now: new Date("2026-11-04T10:00:00Z"), ...o,
});

describe("public rate calculator", () => {
  it("same city: Express (estimated distance) and e-commerce, from the real price list", async () => {
    const r = await publicRates({ from_zone: OSU, to_zone: MADINA, weight_kg: 2 }, deps());
    expect(r.from).toBe("Osu, Accra");
    const ex = r.rates.find((x) => x.service === "express")!;
    expect(ex.amount).toBeGreaterThan(1000);                       // base fee + distance + time
    expect(ex.notes[0]).toMatch(/Estimate/);
    expect(ex.notes.join()).not.toMatch(/locked now/);
    expect(r.rates.find((x) => x.service === "ecommerce")?.amount).toBe(2500);
  });
  it("another city: inter-city doorstep and hub collection", async () => {
    const r = await publicRates({ from_zone: OSU, to_zone: ADUM, weight_kg: 3 }, deps());
    expect(r.rates.map((x) => [x.option, x.amount])).toEqual([["doorstep", 6500], ["hub_collection", 5000]]);
    expect(r.rates[1]!.name).toMatch(/Kumasi Hub/);
  });
  it("over 15 kg: no Express, and says why", async () => {
    const r = await publicRates({ from_zone: OSU, to_zone: MADINA, weight_kg: 16 }, deps());
    expect(r.rates.some((x) => x.service === "express")).toBe(false);
    expect(r.problems.join()).toMatch(/15 kg/);
  });
  it("an area without a price is explained, not an error", async () => {
    const r = await publicRates({ from_zone: MADINA, to_zone: OSU, weight_kg: 1 }, deps());
    expect(r.rates.map((x) => x.service)).toEqual(["express"]);
    expect(r.problems.length).toBe(1);
  });
  it("bad input and unknown areas are refused", async () => {
    await expect(publicRates({ from_zone: "x", to_zone: OSU, weight_kg: 0 }, deps())).rejects.toBeInstanceOf(ApiError);
    await expect(publicRates({ from_zone: OSU, to_zone: "44444444-4444-4444-8444-444444444444", weight_kg: 1 }, deps())).rejects.toThrow(/don't deliver/);
  });
});
