import { describe, expect, it } from "vitest";
import {
  applyFlatPromo, compensationFor, insurancePremium, failedOrReturnFee, pinCorrectionExtra, promoDiscount, quoteEcommerceStop, quoteExpress, quoteIntercity,
  PricingError, cedisToPesewas, formatCedis, type ExpressRule,
} from "./index";

const rule: ExpressRule = {
  baseFee: 1000, perKm: 300, perMinute: 20,
  weightSurcharges: [{ maxG: 5000, feePesewas: 0 }, { maxG: 15000, feePesewas: 500 }],
  fragileSurcharge: 300, nightSurcharge: 500, minimumFee: 1500,
};
const bands = [{ maxG: 2000, feePesewas: 2500 }, { maxG: 5000, feePesewas: 3000 }, { maxG: 25000, feePesewas: 5500 }];

describe("Express", () => {
  it("base + per-km + per-minute", () => {
    expect(quoteExpress(rule, { distanceM: 10_000, durationS: 1800, weightG: 2000 }).totalPesewas).toBe(1000 + 3000 + 600);
  });
  it("weight, fragile and night surcharges", () => {
    expect(quoteExpress(rule, { distanceM: 10_000, durationS: 1800, weightG: 8000, fragile: true, night: true }).totalPesewas).toBe(4600 + 500 + 300 + 500);
  });
  it("surge multiplies distance and time only", () => {
    const q = quoteExpress(rule, { distanceM: 10_000, durationS: 1800, weightG: 1000, surge: 1.5 });
    expect(q.totalPesewas).toBe(1000 + 4500 + 900);
  });
  it("minimum fare", () => expect(quoteExpress(rule, { distanceM: 500, durationS: 60, weightG: 100 }).totalPesewas).toBe(1500));
  it("refuses over 15 kg (bike-only)", () => {
    expect(() => quoteExpress(rule, { distanceM: 1000, durationS: 60, weightG: 15_001 })).toThrow(PricingError);
  });
  it("exactly 15 kg is allowed", () => expect(quoteExpress(rule, { distanceM: 1000, durationS: 60, weightG: 15_000 }).totalPesewas).toBeGreaterThan(0));
  it("needs a weight", () => expect(() => quoteExpress(rule, { distanceM: 1, durationS: 1, weightG: 0 })).toThrow());
});

describe("E-commerce (per stop, weight band per zone)", () => {
  it("fixed fee by band, no distance/time", () => {
    expect(quoteEcommerceStop(bands, 1500).totalPesewas).toBe(2500);
    expect(quoteEcommerceStop(bands, 2000).totalPesewas).toBe(2500);
    expect(quoteEcommerceStop(bands, 2001).totalPesewas).toBe(3000);
  });
  it("too heavy for any band", () => expect(() => quoteEcommerceStop(bands, 30_000)).toThrow(/over the 25 kg limit/));
});

describe("Inter-city (lane + weight band)", () => {
  const lane = { bands, doorstepFee: 1500 };
  it("hub-to-hub", () => expect(quoteIntercity(lane, 3000, false).totalPesewas).toBe(3000));
  it("doorstep adds the doorstep fee", () => expect(quoteIntercity(lane, 3000, true).totalPesewas).toBe(4500));
});

describe("promos and rules", () => {
  it("flat-rate offer: exactly the amount set, whether the normal price is higher or lower", () => {
    expect(applyFlatPromo({ totalPesewas: 4000, lines: [] }, 2500).totalPesewas).toBe(2500);
    expect(applyFlatPromo({ totalPesewas: 1800, lines: [] }, 2500).totalPesewas).toBe(2500);
  });
  it("insurance premium is 5% of the declared value", () => {
    expect(insurancePremium(120_000, 0.05)).toBe(6000);   // GHS 1,200 → GHS 60
    expect(insurancePremium(100_001, 0.05)).toBe(5000);
  });
  it("promo codes: percent with cap, fixed, never below zero", () => {
    expect(promoDiscount(10_000, { id: "a", kind: "percent", value: 10 })).toBe(1000);
    expect(promoDiscount(50_000, { id: "a", kind: "percent", value: 10, maxDiscount: 1000 })).toBe(1000);
    expect(promoDiscount(500, { id: "a", kind: "fixed", value: 2000 })).toBe(500);
  });
  it("compensation: insured = full value; uninsured lost = 3× delivery fee; uninsured damaged = decided by a person", () => {
    expect(compensationFor({ insured: true, declaredValue: 200_000, deliveryFee: 2500, outcome: "damaged" })).toBe(200_000);
    expect(compensationFor({ insured: false, declaredValue: 200_000, deliveryFee: 2500, outcome: "lost" })).toBe(7500);
    expect(compensationFor({ insured: false, declaredValue: 200_000, deliveryFee: 2500, outcome: "damaged" })).toBeNull();
  });
  it("failed/returned = 50%", () => expect(failedOrReturnFee(3500)).toBe(1750));
  it("pin correction re-prices only beyond 1 km", () => {
    expect(pinCorrectionExtra(4000, 900, 6000)).toBe(0);
    expect(pinCorrectionExtra(4000, 1500, 6000)).toBe(2000);
    expect(pinCorrectionExtra(4000, 1500, 3000)).toBe(0);
  });
  it("cedis ↔ pesewas", () => {
    expect(cedisToPesewas("25")).toBe(2500);
    expect(cedisToPesewas("GHS 1,250.5")).toBe(125050);
    expect(() => cedisToPesewas("abc")).toThrow();
    expect(formatCedis(125050)).toBe("GHS 1,250.50");
  });
});
