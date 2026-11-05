import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiDeliveryRequest } from "@qcs/types";
import { orderDecision, orderToDelivery, rateRequestToApi, ratesToShopify, verifyOAuthQuery, verifyWebhook, type ShopifyOrder } from "./shopify";

const SECRET = "shpss_test_secret";

describe("Shopify signatures", () => {
  it("OAuth redirect: hex HMAC over the sorted other parameters", () => {
    const q = new URLSearchParams({ code: "abc", shop: "kente.myshopify.com", state: "s1", timestamp: "1700000000" });
    const msg = "code=abc&shop=kente.myshopify.com&state=s1&timestamp=1700000000";
    q.set("hmac", createHmac("sha256", SECRET).update(msg).digest("hex"));
    expect(verifyOAuthQuery(q, SECRET)).toBe(true);
    q.set("shop", "evil.myshopify.com");
    expect(verifyOAuthQuery(q, SECRET)).toBe(false);
    expect(verifyOAuthQuery(new URLSearchParams({ shop: "x" }), SECRET)).toBe(false);
  });
  it("webhooks: base64 HMAC of the raw body", () => {
    const body = '{"id":1}';
    const h = createHmac("sha256", SECRET).update(body).digest("base64");
    expect(verifyWebhook(body, h, SECRET)).toBe(true);
    expect(verifyWebhook(body + " ", h, SECRET)).toBe(false);
    expect(verifyWebhook(body, h, "")).toBe(false);
    expect(verifyWebhook(body, null, SECRET)).toBe(false);
  });
});

describe("checkout rates", () => {
  it("Shopify destination → our rate request (weight from items, pin when given)", () => {
    const r = rateRequestToApi({ rate: { currency: "GHS", destination: { country: "GH", city: "Kumasi", province: "Ashanti", address1: "Adum", latitude: 6.69, longitude: -1.62 },
      items: [{ grams: 500, quantity: 3 }, { grams: 2000, quantity: 1, requires_shipping: false }] } }, "ecommerce");
    expect(r).toEqual({ service: null, dropoff: { address: "Adum", city: "Kumasi", region: "Ashanti", lat: 6.69, lng: -1.62 }, parcel: { weight_g: 1500 } });
  });
  it("our rates → Shopify (price in pesewas as a string)", () => {
    expect(ratesToShopify([{ service: "intercity", intercity_option: "doorstep", name: "QCS inter-city (to the door)", amount: 4500 }]).rates[0])
      .toEqual({ service_name: "QCS inter-city (to the door)", service_code: "intercity:doorstep", total_price: "4500", currency: "GHS", description: "By bus between QCS hubs" });
  });
});

const order = (o: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 4501, name: "#1042", currency: "GHS", total_price: "275.00", subtotal_price: "250.00", total_weight: 1800, financial_status: "paid",
  payment_gateway_names: ["hubtel"], tags: "vip",
  shipping_address: { first_name: "Esi", last_name: "Mensah", address1: "12 Lagos Ave", address2: "East Legon", city: "Accra", province: "Greater Accra", country_code: "GH", phone: "024 333 4444" },
  shipping_lines: [{ code: "ecommerce", source: "QCS Ghana", title: "QCS same-day delivery" }],
  line_items: [{ title: "Kente dress", quantity: 2 }, { title: "Gift card", quantity: 1, requires_shipping: false }],
  ...o,
});
const shop = { service: "ecommerce", auto_create: true, carrier_service_id: 77 };

describe("which Shopify orders become deliveries", () => {
  it("paid order with QCS chosen at checkout → book, with the chosen service", () => {
    expect(orderDecision(order(), "orders/paid", shop)).toEqual({ book: true, service: "ecommerce", intercity_option: null });
    expect(orderDecision(order({ shipping_lines: [{ code: "intercity:hub_collection", source: "QCS Ghana" }] }), "orders/paid", shop))
      .toEqual({ book: true, service: "intercity", intercity_option: "hub_collection" });
  });
  it("not paid yet / other shipping / other country / cancelled / switched off → skip", () => {
    expect(orderDecision(order(), "orders/create", shop)).toMatchObject({ book: false, why: "waiting for payment" });
    expect(orderDecision(order({ shipping_lines: [{ code: "pickup", title: "Pick up in store" }] }), "orders/paid", shop)).toMatchObject({ book: false });
    expect(orderDecision(order({ shipping_address: { ...order().shipping_address!, country_code: "NG" } }), "orders/paid", shop)).toMatchObject({ book: false });
    expect(orderDecision(order({ cancelled_at: "2026-11-05" }), "orders/paid", shop)).toMatchObject({ book: false });
    expect(orderDecision(order(), "orders/paid", { ...shop, auto_create: false })).toMatchObject({ book: false });
  });
  it("COD orders are booked when created (they never become 'paid'), once", () => {
    const cod = order({ payment_gateway_names: ["Cash on Delivery (COD)"], financial_status: "pending" });
    expect(orderDecision(cod, "orders/create", shop)).toMatchObject({ book: true });
    expect(orderDecision(cod, "orders/paid", shop)).toMatchObject({ book: false });
  });
  it("without live rates (no carrier service on the plan) every shippable order is booked with the shop's default", () => {
    expect(orderDecision(order({ shipping_lines: [{ code: "Standard", title: "Standard" }] }), "orders/paid", { ...shop, carrier_service_id: null }))
      .toEqual({ book: true, service: "ecommerce", intercity_option: null });
  });
});

describe("Shopify order → QCS delivery", () => {
  it("maps address, phone, weight, contents, value and COD — and passes the API's own validation", () => {
    const d = orderToDelivery(order({ payment_gateway_names: ["Cash on Delivery (COD)"] }), { service: "ecommerce", intercity_option: null });
    expect(d).toMatchObject({ reference: "#1042", dropoff: { address: "12 Lagos Ave, East Legon", city: "Accra", contact_name: "Esi Mensah", contact_phone: "024 333 4444" },
      parcel: { weight_g: 1800, description: "2× Kente dress", value: 25000, cod_amount: 27500 } });
    const v = ApiDeliveryRequest.safeParse(d);
    expect(v.success).toBe(true);
    expect(v.data?.dropoff.contact_phone).toBe("+233243334444");
  });
  it("no COD and no value for stores in another currency", () => {
    expect(orderToDelivery(order({ currency: "USD", payment_gateway_names: ["Cash on Delivery (COD)"] }), { service: "ecommerce", intercity_option: null }).parcel)
      .toMatchObject({ value: 0, cod_amount: 0 });
  });
});
