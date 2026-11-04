import { describe, expect, it } from "vitest";
import {
  quoteExpress, quoteEcommerceStop, quoteIntercity, failedOrReturnFee, pinCorrectionExtra,
  PricingError, type ExpressRule,
} from "./index";

const rule: ExpressRule = {
  baseFee: 1000, perKm: 300, perMinute: 20,
  weightSurcharges: [{ maxG: 5000, feePesewas: 0 }, { maxG: 15000, feePesewas: 500 }],
  fragileSurcharge: 300, nightSurcharge: 500, minimumFee: 1500,
};

describe("express", () => {
  it("adds base + distance + time", () => {
    const q = quoteExpress(rule, { distanceM: 10_000, durationS: 1800, weightG: 2000 });
    expect(q.totalPesewas).toBe(1000 + 3000 + 600);
  });
  it("adds weight, fragile and night surcharges", () => {
    const q = quoteExpress(rule, { distanceM: 10_000, durationS: 1800, weightG: 8000, fragile: true, night: true });
    expect(q.totalPesewas).toBe(4600 + 500 + 300 + 500);
  });
  it("refuses parcels over 15 kg", () => {
    expect(() => quoteExpress(rule, { distanceM: 1000, durationS: 60, weightG: 15_001 })).toThrow(PricingError);
  });
  it("applies minimum fare", () => {
    expect(quoteExpress(rule, { distanceM: 500, durationS: 60, weightG: 100 }).totalPesewas).toBe(1500);
  });
});

describe("ecommerce & intercity", () => {
  const bands = [{ maxG: 2000, feePesewas: 2500 }, { maxG: 10000, feePesewas: 3500 }];
  it("bills a fixed fee per stop by weight band", () => {
    expect(quoteEcommerceStop(bands, 1500).totalPesewas).toBe(2500);
    expect(quoteEcommerceStop(bands, 2001).totalPesewas).toBe(3500);
  });
  it("adds doorstep fee for inter-city", () => {
    expect(quoteIntercity(bands, 3000, 1500).totalPesewas).toBe(5000);
  });
});

describe("rules", () => {
  it("charges 50% for failed/returned", () => expect(failedOrReturnFee(3500)).toBe(1750));
  it("reprices pin corrections only over 1 km", () => {
    expect(pinCorrectionExtra(4000, 900, 6000)).toBe(0);
    expect(pinCorrectionExtra(4000, 1500, 6000)).toBe(2000);
    expect(pinCorrectionExtra(4000, 1500, 3000)).toBe(0);
  });
});
