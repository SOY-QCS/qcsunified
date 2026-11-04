import { describe, expect, it } from "vitest";
import { priceBooking, deliveryDay, isNight, scheduleProblem, ExpressRule, type PricingRuleRow } from "./index";

const ACC = "city-acc", OSU = "zone-osu", LEGON = "zone-legon";
const row = (o: Partial<PricingRuleRow>): PricingRuleRow => ({
  id: Math.random().toString(), rule_kind: "express", city_id: ACC, zone_id: null, origin_hub_id: null, dest_hub_id: null,
  config: {}, valid_from: null, valid_to: null, is_active: true, ...o,
});
const rules: PricingRuleRow[] = [
  row({ rule_kind: "express", config: { baseFee: 1000, perKm: 300, perMinute: 20, weightSurcharges: [{ maxG: 15000, feePesewas: 0 }], fragileSurcharge: 300, nightSurcharge: 500, minimumFee: 1500 } }),
  row({ rule_kind: "ecommerce_zone", zone_id: OSU, config: { bands: [{ maxG: 2000, feePesewas: 2500 }, { maxG: 10000, feePesewas: 4000 }] } }),
  row({ rule_kind: "ecommerce_zone", zone_id: LEGON, config: { bands: [{ maxG: 2000, feePesewas: 3000 }, { maxG: 10000, feePesewas: 4500 }] } }),
];
const base = { cityId: ACC, rules, cutoff: "09:00", nightWindow: { start: "20:00", end: "06:00" }, surge: 1 };
const morning = new Date("2026-11-04T08:00:00Z"); // Wednesday 08:00 Accra

describe("priceBooking — Express", () => {
  it("prices one drop-off and locks it", () => {
    const p = priceBooking({ ...base, service: "express", now: morning, stops: [{ weightG: 1000, fragile: false, zoneId: OSU, distanceM: 8000, durationS: 1200 }] });
    expect(p.totalPesewas).toBe(1000 + 2400 + 400);
    expect(p.notes.join()).toMatch(/locked/);
  });
  it("night surcharge applies to the pickup time", () => {
    const p = priceBooking({ ...base, service: "express", now: new Date("2026-11-04T21:30:00Z"), stops: [{ weightG: 1000, fragile: false, zoneId: OSU, distanceM: 8000, durationS: 1200 }] });
    expect(p.stops[0]!.lines.some((l) => l.label === "Night delivery")).toBe(true);
  });
  it("refuses several drop-offs", () => {
    const s = { weightG: 1000, fragile: false, zoneId: OSU, distanceM: 1, durationS: 1 };
    expect(() => priceBooking({ ...base, service: "express", now: morning, stops: [s, s] })).toThrow(/one drop-off/);
  });
  it("needs express prices for the city", () => {
    expect(() => priceBooking({ ...base, cityId: "other", service: "express", now: morning, stops: [{ weightG: 1, fragile: false, zoneId: null, distanceM: 1, durationS: 1 }] })).toThrow(/aren't set/);
  });
});

describe("priceBooking — E-commerce / bulk", () => {
  const stops = [
    { weightG: 1500, fragile: false, zoneId: OSU },
    { weightG: 5000, fragile: false, zoneId: OSU },
    { weightG: 1000, fragile: false, zoneId: LEGON },
  ];
  it("adds up each stop's zone price", () => {
    const p = priceBooking({ ...base, service: "ecommerce", now: morning, stops });
    expect(p.stops.map((s) => s.feePesewas)).toEqual([2500, 4000, 3000]);
    expect(p.totalPesewas).toBe(9500);
    expect(p.pickupDate).toBe("2026-11-04");
  });
  it("after the cut-off, pickup moves to the next day", () => {
    const p = priceBooking({ ...base, service: "ecommerce", now: new Date("2026-11-04T10:00:00Z"), stops });
    expect(p.pickupDate).toBe("2026-11-05");
    expect(p.notes.join()).toMatch(/cut-off/);
  });
  it("max 25 stops", () => {
    const many = Array.from({ length: 26 }, () => stops[0]!);
    expect(() => priceBooking({ ...base, service: "ecommerce", now: morning, stops: many })).toThrow(/at most 25/);
  });
  it("area we don't serve", () => {
    expect(() => priceBooking({ ...base, service: "ecommerce", now: morning, stops: [{ weightG: 1, fragile: false, zoneId: null }] })).toThrow(/Drop-off 1/);
  });
  it("flat-rate offer for the whole city sets every stop to the flat fee (even cheaper ones)", () => {
    const promo = row({ rule_kind: "flat_promo", name: "GHS 25 Accra", config: { flatFee: 2500 }, valid_from: "2026-11-01T00:00:00Z", valid_to: "2026-11-30T00:00:00Z" });
    const p = priceBooking({ ...base, rules: [...rules, promo], service: "ecommerce", now: morning, stops: [...stops, { weightG: 500, fragile: false, zoneId: OSU }] });
    expect(p.stops.map((s) => s.feePesewas)).toEqual([2500, 2500, 2500, 2500]);
    const cheap = row({ rule_kind: "flat_promo", config: { flatFee: 9900 } });
    expect(priceBooking({ ...base, rules: [...rules, cheap], service: "ecommerce", now: morning, stops: [stops[0]!] }).totalPesewas).toBe(9900);
  });
  it("expired flat promo is ignored", () => {
    const promo = row({ rule_kind: "flat_promo", config: { flatFee: 100 }, valid_to: "2026-10-01T00:00:00Z" });
    expect(priceBooking({ ...base, rules: [...rules, promo], service: "ecommerce", now: morning, stops }).totalPesewas).toBe(9500);
  });
  it("promo code discount is shared across stops and adds up exactly", () => {
    const p = priceBooking({ ...base, service: "ecommerce", now: morning, stops, promo: { id: "p", kind: "percent", value: 10 } });
    expect(p.discountPesewas).toBe(950);
    expect(p.totalPesewas).toBe(8550);
    expect(p.stops.reduce((t, s) => t + s.netPesewas, 0)).toBe(8550);
  });
});

describe("insurance on high-value items", () => {
  const ecommerce = (extra: object) => priceBooking({ ...base, service: "ecommerce", now: morning, stops: [{ weightG: 1500, fragile: false, zoneId: OSU, ...extra }] });
  it("adds 5% of the declared value to the stop and the total", () => {
    const p = ecommerce({ declaredValue: 200_000, insured: true });  // GHS 2,000
    expect(p.stops[0]).toMatchObject({ netPesewas: 2500, insurancePesewas: 10_000, totalPesewas: 12_500 });
    expect(p.totalPesewas).toBe(12_500);
    expect(p.notes.join()).toMatch(/refunded in full/);
  });
  it("uses the admin's rate and threshold", () => {
    const p = priceBooking({ ...base, service: "ecommerce", now: morning, insurance: { rate: 0.03, minValue: 50_000 },
      stops: [{ weightG: 1500, fragile: false, zoneId: OSU, declaredValue: 60_000, insured: true }] });
    expect(p.insurancePesewas).toBe(1800);
  });
  it("is only for items at or above the threshold", () => {
    expect(() => ecommerce({ declaredValue: 50_000, insured: true })).toThrow(/GHS 1,000 or more/);
  });
  it("reminds the client when a high-value item isn't insured", () => {
    expect(ecommerce({ declaredValue: 150_000 }).notes.join()).toMatch(/not insured/);
  });
  it("promo codes don't reduce the insurance premium", () => {
    const p = priceBooking({ ...base, service: "ecommerce", now: morning, promo: { id: "p", kind: "percent", value: 50 },
      stops: [{ weightG: 1500, fragile: false, zoneId: OSU, declaredValue: 200_000, insured: true }] });
    expect(p).toMatchObject({ discountPesewas: 1250, insurancePesewas: 10_000, totalPesewas: 1250 + 10_000 });
  });
});

describe("times", () => {
  const w = { start: "20:00", end: "06:00" };
  it("night window crosses midnight", () => {
    expect(isNight(new Date("2026-11-04T21:00:00Z"), w)).toBe(true);
    expect(isNight(new Date("2026-11-04T05:59:00Z"), w)).toBe(true);
    expect(isNight(new Date("2026-11-04T12:00:00Z"), w)).toBe(false);
  });
  it("Saturday after cut-off rolls past Sunday to Monday", () => {
    expect(deliveryDay(new Date("2026-11-07T11:00:00Z"), "09:00").date).toBe("2026-11-09");
  });
  it("scheduled pickups must be 15 min to 14 days ahead", () => {
    expect(scheduleProblem(new Date("2026-11-04T08:05:00Z"), morning)).toMatch(/15 minutes/);
    expect(scheduleProblem(new Date("2026-11-30T08:00:00Z"), morning)).toMatch(/14 days/);
    expect(scheduleProblem(new Date("2026-11-05T08:00:00Z"), morning)).toBeNull();
  });
});

describe("rule validation (admin screens use these)", () => {
  it("rejects negative fees and duplicate bands", () => {
    expect(ExpressRule.safeParse({ baseFee: -1, perKm: 1, perMinute: 1, weightSurcharges: [{ maxG: 1, feePesewas: 0 }], fragileSurcharge: 0, nightSurcharge: 0 }).success).toBe(false);
    expect(ExpressRule.safeParse({ baseFee: 1, perKm: 1, perMinute: 1, weightSurcharges: [{ maxG: 1, feePesewas: 0 }, { maxG: 1, feePesewas: 2 }], fragileSurcharge: 0, nightSurcharge: 0 }).success).toBe(false);
  });
});
