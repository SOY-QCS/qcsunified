import { describe, expect, it } from "vitest";
import type { BookingRequest } from "@qcs/types";
import { ApiError } from "../supabase";
import { bulk, create, quote, rates, resolvePlace, type Ctx, type Deps, type QuoteResult } from "./core";
import { openApi } from "./openapi";

const ctx: Ctx = { vendorId: "6b8f0b9e-6a2c-4f3e-9a3b-1f2e3d4c5b6a", mode: "live", ownerId: "u1", accountType: "vendor", defaultPickupId: "addr1", businessName: "Kente Online", source: "woocommerce" };
const ACCRA = { lat: 5.6037, lng: -0.187 }, LEGON = { lat: 5.6355, lng: -0.161 }, KUMASI = { lat: 6.6885, lng: -1.6244 };

function fakeDeps(over: Partial<Deps> = {}) {
  const booked: BookingRequest[] = [];
  const priced: BookingRequest[] = [];
  const test: Record<string, unknown>[] = [];
  let n = 0;
  const deps: Deps = {
    geocode: async (q) => (/legon/i.test(q) ? LEGON : /kumasi/i.test(q) ? KUMASI : /^accra, ghana$/i.test(q) ? ACCRA : null),
    savedAddress: async () => ({ formatted_address: "Shop, Osu", ...ACCRA, ghana_post_gps: null, landmark: null, contact_name: "Kente Online", contact_phone: "+233241111111", instructions: null }),
    quote: async (req, save) => {
      priced.push(req);
      // the "zone check": Kumasi drop-offs only work as inter-city, Accra ones only as e-commerce/express
      req.dropoffs.forEach((d, i) => {
        const far = d.lat > 6;
        if (far && req.service !== "intercity") throw new ApiError(400, "Some drop-offs can't be delivered", [`Drop-off ${i + 1}: in another city — choose inter-city`]);
        if (!far && req.service === "intercity") throw new ApiError(400, "Some drop-offs can't be delivered", [`Drop-off ${i + 1}: same city as the pickup`]);
      });
      const each = req.service === "intercity" ? (req.intercity_option === "doorstep" ? 4500 : 3500) : 2500;
      return { quote_id: save ? `q${++n}` : "", expires_at: new Date(Date.now() + 900_000).toISOString(), city: "ACC", totalPesewas: each * req.dropoffs.length,
               subtotalPesewas: each * req.dropoffs.length, notes: [],
               stops: req.dropoffs.map(() => ({ netPesewas: each, insurancePesewas: 0, totalPesewas: each, lines: [{ label: "Delivery", pesewas: each }] })) } as QuoteResult;
    },
    loadQuote: async () => null,
    book: async () => { booked.push(priced[priced.length - 1]!); return priced[priced.length - 1]!.dropoffs.map((_, i) => `ACC-20261105130${i}-ACC`); },
    getDelivery: async (tn) => ({ tracking_number: tn, livemode: true }),
    testCreate: async (d) => { test.push(d); return { ...d, tracking_number: `TEST-${test.length}`, livemode: false }; },
    ...over,
  };
  return { deps, booked, priced, test };
}

const order = (ref: string, address = "12 Lagos Avenue, East Legon", city = "Accra") => ({ reference: ref, dropoff: { address, city, contact_name: "Esi Mensah", contact_phone: "0243334444" }, parcel: { weight_g: 1500 } });

describe("addresses", () => {
  it("uses the map pin when sent, else finds the text address, else the town (approximate)", async () => {
    const { deps } = fakeDeps();
    expect(await resolvePlace({ address: "Anywhere", lat: 5.7, lng: -0.2, contact_name: "A", contact_phone: "0241234567" } as never, deps.geocode, "dropoff")).toMatchObject({ lat: 5.7, lng: -0.2 });
    expect(await resolvePlace({ address: "Lagos Ave, East Legon", contact_name: "A", contact_phone: "0241234567" } as never, deps.geocode, "dropoff")).toMatchObject(LEGON);
    expect(await resolvePlace({ address: "House 4, behind the blue kiosk", city: "Accra", contact_name: "A", contact_phone: "0241234567" } as never, deps.geocode, "dropoff"))
      .toMatchObject({ ...ACCRA, approximate: true });
    await expect(resolvePlace({ address: "behind the blue kiosk", contact_name: "A", contact_phone: "0241234567" } as never, deps.geocode, "dropoff"))
      .rejects.toMatchObject({ status: 422, code: "address_not_found" });
  });
});

describe("rates for checkout pages", () => {
  it("same city: e-commerce only; inter-city options fail quietly", async () => {
    const { deps, priced } = fakeDeps();
    const r = await rates(ctx, { dropoff: { address: "East Legon", city: "Accra" }, parcel: { weight_g: 2000 } }, deps);
    expect(r.rates).toEqual([expect.objectContaining({ service: "ecommerce", amount: 2500, display: "GHS 25.00", name: "QCS same-day delivery" })]);
    expect(priced.every((p) => p.pickup.formatted_address === "Shop, Osu")).toBe(true);    // default pickup
  });
  it("another city: both inter-city options", async () => {
    const { deps } = fakeDeps();
    const r = await rates(ctx, { dropoff: { address: "Adum", city: "Kumasi" } }, deps);
    expect(r.rates.map((x) => [x.intercity_option, x.amount])).toEqual([["doorstep", 4500], ["hub_collection", 3500]]);
  });
  it("nowhere to deliver: 422 with the reasons", async () => {
    const { deps } = fakeDeps({ quote: async () => { throw new ApiError(400, "Some drop-offs can't be delivered", ["Drop-off 1: outside our delivery areas"]); } });
    await expect(rates(ctx, { dropoff: { address: "Legon" } }, deps)).rejects.toMatchObject({ status: 422, details: ["Drop-off 1: outside our delivery areas"] });
  });
});

describe("create", () => {
  it("live: books with the business wallet, the vendor's order number and the default pickup", async () => {
    const { deps, booked } = fakeDeps();
    const d = await create(ctx, order("WOO-1"), deps);
    expect(d.tracking_number).toMatch(/^ACC-/);
    expect(booked[0]).toMatchObject({ service: "ecommerce", vendor_id: ctx.vendorId, payer: "vendor_wallet", payment_method: "wallet",
      dropoffs: [expect.objectContaining({ external_ref: "WOO-1", contact_phone: "+233243334444", weight_g: 1500 })] });
  });
  it("corporate accounts are invoiced; recipient-pays is cash", async () => {
    const { deps, booked } = fakeDeps();
    await create({ ...ctx, accountType: "corporate" }, order("C-1"), deps);
    await create(ctx, { ...order("R-1"), payer: "recipient" }, deps);
    expect(booked.map((b) => [b.payer, b.payment_method])).toEqual([["corporate_invoice", "invoice"], ["recipient", "cash"]]);
  });
  it("test mode: real price, practice delivery, nothing booked", async () => {
    const { deps, booked, test } = fakeDeps();
    const d = await create({ ...ctx, mode: "test" }, order("T-1"), deps);
    expect(d).toMatchObject({ tracking_number: "TEST-1", livemode: false });
    expect(test[0]).toMatchObject({ reference: "T-1", fee: { amount: 2500, currency: "GHS" }, source: "woocommerce" });
    expect(booked).toHaveLength(0);
  });
  it("explains bad requests field by field", async () => {
    const { deps } = fakeDeps();
    const e = await create(ctx, { dropoff: { address: "Legon", contact_name: "E", contact_phone: "123" }, parcel: { weight_g: 50_000 } }, deps).catch((x) => x);
    expect(e).toMatchObject({ status: 400, code: "invalid_request" });
    expect(e.details.join(" | ")).toMatch(/dropoff.contact_name.*dropoff.contact_phone.*parcel.weight_g/);
  });
  it("Express over 15 kg is refused by the same rules as the app", async () => {
    const { deps } = fakeDeps();
    await expect(create(ctx, { ...order("X"), service: "express", parcel: { weight_g: 16_000 } }, deps)).rejects.toMatchObject({ status: 400, details: [expect.stringMatching(/15 kg/)] });
  });
  it("books a saved quote only for its own business and only once", async () => {
    const q = { request: { service: "ecommerce", dropoffs: [{}] } as BookingRequest, price: {} as QuoteResult, used_at: null, expires_at: new Date(Date.now() + 60_000).toISOString(), vendor_id: "v2" };
    const { deps } = fakeDeps({ loadQuote: async () => q });
    await expect(create(ctx, { quote_id: "6b8f0b9e-6a2c-4f3e-9a3b-1f2e3d4c5b6a" }, deps)).rejects.toMatchObject({ status: 404 });
    const { deps: d2 } = fakeDeps({ loadQuote: async () => ({ ...q, vendor_id: ctx.vendorId, used_at: "2026-11-05" }) });
    await expect(create(ctx, { quote_id: "6b8f0b9e-6a2c-4f3e-9a3b-1f2e3d4c5b6a" }, d2)).rejects.toMatchObject({ status: 409 });
  });
});

describe("quote", () => {
  it("returns a bookable quote with the breakdown", async () => {
    const { deps } = fakeDeps();
    expect(await quote(ctx, order("Q-1"), deps)).toMatchObject({ quote_id: "q1", amount: 2500, currency: "GHS", breakdown: [{ label: "Delivery", amount: 2500 }] });
  });
});

describe("bulk", () => {
  it("groups same-city drop-offs into one trip, reports bad items individually", async () => {
    const { deps, booked } = fakeDeps();
    const r = await bulk(ctx, [order("B-1"), { reference: "B-2" }, order("B-3"), order("B-1"), order("B-4", "Nowhere street", "Atlantis")], deps);
    expect(r.created).toBe(2);
    expect(booked).toHaveLength(1);                                    // B-1 and B-3 on one trip
    expect(booked[0]!.dropoffs.map((d) => d.external_ref)).toEqual(["B-1", "B-3"]);
    expect(r.results.map((x) => [x.index, x.ok])).toEqual([[0, true], [1, false], [2, true], [3, false], [4, false]]);
    expect(r.results[3]).toMatchObject({ error: { code: "conflict" } });               // same reference twice
    expect(r.results[4]).toMatchObject({ error: { code: "address_not_found" } });
  });
  it("one bad drop-off doesn't sink the others in its trip", async () => {
    const { deps } = fakeDeps();
    const r = await bulk(ctx, [order("K-1"), order("K-2", "Adum, Kumasi"), order("K-3")], deps);   // K-2 is in Kumasi but sent as e-commerce
    expect(r.results.map((x) => x.ok)).toEqual([true, false, true]);
  });
  it("splits more than 25 drop-offs into several trips", async () => {
    const { deps, booked } = fakeDeps();
    await bulk(ctx, Array.from({ length: 30 }, (_, i) => order(`M-${i}`)), deps);
    expect(booked.map((b) => b.dropoffs.length)).toEqual([25, 5]);
  });
});

describe("OpenAPI document", () => {
  it("is generated from the validation schemas and lists every endpoint", () => {
    const doc = openApi("https://portal.qcsghana.com");
    expect(doc.servers[0]!.url).toBe("https://portal.qcsghana.com/api/business/v1");
    expect(Object.keys(doc.paths)).toEqual(["/rates", "/quotes", "/deliveries", "/deliveries/bulk", "/deliveries/{id}", "/deliveries/{id}/cancel", "/deliveries/{id}/simulate", "/me"]);
    const req = doc.components.schemas.DeliveryRequest as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(req.properties)).toEqual(expect.arrayContaining(["service", "pickup", "dropoff", "parcel", "reference", "payer"]));
    expect(req.required).toEqual(["dropoff"]);
    expect(JSON.stringify(doc)).not.toMatch(/"undefined"/);
  });
});
