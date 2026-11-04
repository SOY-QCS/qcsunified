import { describe, expect, it } from "vitest";
import type { PricingRuleRow } from "@qcs/pricing";
import { buildQuote, type QuoteDeps } from "./quote";
import { ApiError } from "./supabase";

const ACC = "acc", KSI = "ksi", V = "11111111-1111-4111-8111-111111111111";
const rules: PricingRuleRow[] = [
  { id: "1", rule_kind: "express", city_id: ACC, zone_id: null, origin_hub_id: null, dest_hub_id: null, valid_from: null, valid_to: null, is_active: true,
    config: { baseFee: 1000, perKm: 300, perMinute: 20, weightSurcharges: [{ maxG: 15000, feePesewas: 0 }], fragileSurcharge: 300, nightSurcharge: 500 } },
  { id: "2", rule_kind: "ecommerce_zone", city_id: ACC, zone_id: "osu", origin_hub_id: null, dest_hub_id: null, valid_from: null, valid_to: null, is_active: true,
    config: { bands: [{ maxG: 5000, feePesewas: 2500 }] } },
  { id: "3", rule_kind: "intercity_lane", city_id: ACC, zone_id: null, origin_hub_id: "acc-hub", dest_hub_id: "ksi-hub", valid_from: null, valid_to: null, is_active: true,
    config: { bands: [{ maxG: 5000, feePesewas: 5000 }], doorstepFee: 1500 } },
];
let saved: unknown = null;
const deps = (o: Partial<QuoteDeps> = {}): QuoteDeps => ({
  userId: "u1", vendorIds: [V],
  zoneFor: async (p) => (p.lat > 6 ? { zone_id: "ksi-z", city_id: KSI, city_code: "KSI" } : p.lat < 5 ? null : { zone_id: "osu", city_id: ACC, city_code: "ACC" }),
  rulesFor: async () => rules, cityCutoff: async () => "09:00", setting: async () => undefined,
  promo: async () => ({ id: "p1", kind: "fixed", value: 500 }),
  route: async () => ({ distanceM: 10_000, durationS: 1800, estimated: false }),
  saveQuote: async (q) => { saved = q; return { id: "q1", expires_at: "later" }; },
  hubNear: async (city) => ({ id: city === KSI ? "ksi-hub" : "acc-hub" }),
  hub: async (id) => (id === "acc-hub" ? { id, city_id: ACC, lat: 5.6, lng: -0.19, name: "Accra Hub", address: "Kaneshie", phone: "0302000000" } : null),
  stock: async () => ({ "22222222-2222-4222-8222-222222222222": 3 }),
  now: new Date("2026-11-04T08:00:00Z"), ...o,
});
const place = { formatted_address: "Oxford St", lat: 5.556, lng: -0.178, contact_name: "Ama", contact_phone: "0241234567" };
const drop = { ...place, contact_name: "Kofi", weight_g: 1000 };
const express = { service: "express", pickup: place, dropoffs: [drop], payer: "sender", payment_method: "momo" };

const fails = async (body: object, d = deps()) => {
  try { await buildQuote(body, d); return null; } catch (e) { return e as ApiError; }
};

describe("quote", () => {
  it("prices Express with the road route and saves the quote", async () => {
    const q = await buildQuote(express, deps());
    expect(q.totalPesewas).toBe(1000 + 3000 + 600);
    expect(q.quote_id).toBe("q1");
    expect((saved as { zones: string[] }).zones).toEqual(["osu"]);
  });
  it("e-commerce for a vendor, with promo code", async () => {
    const q = await buildQuote({ ...express, service: "ecommerce", vendor_id: V, dropoffs: [drop, drop], payer: "vendor_wallet", payment_method: "wallet", promo_code: "save5" }, deps());
    expect(q.subtotalPesewas).toBe(5000);
    expect(q.totalPesewas).toBe(4500);
  });
  it("can't book for someone else's business", async () => {
    expect((await fails({ ...express, service: "ecommerce", vendor_id: "22222222-2222-4222-8222-222222222222", payer: "vendor_wallet", payment_method: "wallet" }))?.status).toBe(403);
  });
  it("pickup outside our areas", async () => {
    expect((await fails({ ...express, pickup: { ...place, lat: 4.8 } }))?.message).toMatch(/pick up/);
  });
  it("drop-off in another city points to inter-city", async () => {
    expect((await fails({ ...express, dropoffs: [{ ...drop, lat: 6.69, lng: -1.62 }] }))?.details?.[0]).toMatch(/another city/);
  });
  it("bad promo code explained", async () => {
    const e = await fails({ ...express, promo_code: "x" }, deps({ promo: async () => { throw new Error("That promo code has expired"); } }));
    expect(e?.message).toBe("That promo code has expired");
  });
  it("invalid booking returns every problem", async () => {
    const e = await fails({ ...express, pickup: { ...place, contact_name: "" }, dropoffs: [{ ...drop, contact_phone: "1" }] });
    expect(e?.status).toBe(400);
    expect(e?.details).toEqual(expect.arrayContaining([expect.stringMatching(/^Pickup:/), expect.stringMatching(/^Drop-off 1:/)]));
  });
  it("insurance uses the admin settings", async () => {
    const d = deps({ setting: async (k) => (k === "insurance_rate" ? 0.04 : k === "high_value_threshold" ? 100_000 : undefined) });
    const q = await buildQuote({ ...express, dropoffs: [{ ...drop, item_value: 150_000, insured: true }] }, d);
    expect(q.insurancePesewas).toBe(6000);
    expect(q.totalPesewas).toBe(1000 + 3000 + 600 + 6000);
  });
  it("estimated distance is disclosed", async () => {
    const q = await buildQuote(express, deps({ route: async () => ({ distanceM: 5000, durationS: 900, estimated: true }) }));
    expect(q.notes.join()).toMatch(/estimated/);
  });
});

describe("inter-city and shipping from stock", () => {
  const ksiDrop = { ...drop, lat: 6.69, lng: -1.62 };
  it("Accra → Kumasi doorstep: lane price + doorstep fee, hubs remembered", async () => {
    const q = await buildQuote({ service: "intercity", intercity_option: "doorstep", pickup: place, dropoffs: [ksiDrop], payer: "sender", payment_method: "momo" }, deps());
    expect(q.totalPesewas).toBe(6500);
    expect((q.stops[0] as unknown as { originHubId: string; destHubId: string })).toMatchObject({ originHubId: "acc-hub", destHubId: "ksi-hub" });
  });
  it("inter-city must go to another city", async () => {
    expect((await fails({ service: "intercity", intercity_option: "doorstep", pickup: place, dropoffs: [drop], payer: "sender", payment_method: "momo" }))?.details?.[0]).toMatch(/same city/);
  });
  it("from stock: hub becomes the pickup", async () => {
    const SKU = "22222222-2222-4222-8222-222222222222";
    await buildQuote({ service: "ecommerce", vendor_id: V, fulfilment_hub_id: "33333333-3333-4333-8333-333333333333", pickup: place,
      dropoffs: [{ ...drop, items: [{ sku_id: SKU, qty: 2 }] }], payer: "vendor_wallet", payment_method: "wallet" },
      deps({ hub: async (id) => ({ id, city_id: ACC, lat: 5.6, lng: -0.19, name: "Accra Hub", address: "Kaneshie", phone: "0302000000" }) }));
    expect((saved as { request: { pickup: { formatted_address: string } } }).request.pickup.formatted_address).toBe("Accra Hub, Kaneshie");
  });
  it("from stock: not enough units", async () => {
    const SKU = "22222222-2222-4222-8222-222222222222";
    const e = await fails({ service: "ecommerce", vendor_id: V, fulfilment_hub_id: "33333333-3333-4333-8333-333333333333", pickup: place,
      dropoffs: [{ ...drop, items: [{ sku_id: SKU, qty: 5 }] }], payer: "vendor_wallet", payment_method: "wallet" },
      deps({ hub: async (id) => ({ id, city_id: ACC, lat: 5.6, lng: -0.19, name: "Accra Hub", address: "Kaneshie", phone: null }) }));
    expect(e?.message).toMatch(/Not enough stock/);
  });
});
