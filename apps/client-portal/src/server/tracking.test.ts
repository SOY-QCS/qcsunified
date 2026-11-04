import { describe, expect, it } from "vitest";
import type { PricingRuleRow } from "@qcs/pricing";
import { movePin, type PinMoveDeps } from "./tracking";

const rule = { id: "r", rule_kind: "express", city_id: "acc", zone_id: null, origin_hub_id: null, dest_hub_id: null, valid_from: null, valid_to: null, is_active: true,
  config: { baseFee: 1000, perKm: 200, perMinute: 10, weightSurcharges: [{ maxG: 15000, feePesewas: 0 }], fragileSurcharge: 0, nightSurcharge: 0 } } as unknown as PricingRuleRow;

function deps(service = "express", over: Partial<PinMoveDeps> = {}) {
  const saved: unknown[] = [];
  const d: PinMoveDeps = {
    link: async () => ({ service_type: service, lat: 5.6355, lng: -0.161, can_change: true }),
    order: async () => ({ city_id: "acc", created_at: "2026-11-04T10:00:00Z", weight_g: 1000, is_fragile: false,
      quote: { request: { pickup: { lat: 5.556, lng: -0.178 } }, price: { stops: [{ feePesewas: 3000 }] } } }),
    zoneFor: async () => ({ zone_id: "z", city_id: "acc" }),
    rules: async () => [rule], setting: async () => undefined, cutoff: async () => "09:00",
    route: async () => ({ distanceM: 15000, durationS: 1800, estimated: false }),
    correct: async (a) => { saved.push(a); return { moved_m: 0, extra: a.p_extra }; },
    ...over,
  };
  return { d, saved };
}

describe("recipient moves the pin", () => {
  it("Express, moved > 1 km: charges only the difference from the new price", async () => {
    const t = deps();
    const r = await movePin("tok", { lat: 5.6440, lng: -0.1555 }, t.d);
    // new price = 1000 + 15 km × 200 + 30 min × 10 = 4300; was 3000 → extra 1300
    expect(r.extra).toBe(1300);
  });
  it("Express, moved 1 km or less: no extra", async () => {
    const t = deps();
    expect((await movePin("tok", { lat: 5.6380, lng: -0.161 }, t.d)).extra).toBe(0);
  });
  it("cheaper new route never reduces the locked price", async () => {
    const t = deps("express", { route: async () => ({ distanceM: 2000, durationS: 300, estimated: false }) });
    expect((await movePin("tok", { lat: 5.6440, lng: -0.1555 }, t.d)).extra).toBe(0);
  });
  it("e-commerce: never re-priced", async () => {
    const t = deps("ecommerce");
    expect((await movePin("tok", { lat: 5.70, lng: -0.10 }, t.d)).extra).toBe(0);
  });
  it("locked once the rider is at the door", async () => {
    const t = deps("express", { link: async () => ({ service_type: "express", lat: 5.6, lng: -0.1, can_change: false }) });
    await expect(movePin("tok", { lat: 5.7, lng: -0.1 }, t.d)).rejects.toThrow(/no longer be changed/);
  });
});
