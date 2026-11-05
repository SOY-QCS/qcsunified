/**
 * Shopify app helpers (pure, tested). The app lives inside the portal's API routes:
 *   /api/integrations/shopify/install   → OAuth start (from the portal's Developers page)
 *   /api/integrations/shopify/callback  → OAuth finish: save token, register carrier service + webhooks
 *   /api/integrations/shopify/rates/<token> → live rates at checkout (Shopify CarrierService)
 *   /api/integrations/shopify/webhooks  → orders/create, orders/paid, app/uninstalled, GDPR topics
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
export const SHOPIFY_SCOPES = "read_orders,write_orders,read_shipping,write_shipping";
export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** OAuth redirects: hex HMAC-SHA256 over the other query parameters, sorted, as "k=v&k2=v2". */
export function verifyOAuthQuery(params: URLSearchParams, secret: string): boolean {
  const hmac = params.get("hmac");
  if (!hmac || !secret) return false;
  const msg = [...params.entries()].filter(([k]) => k !== "hmac" && k !== "signature").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  return safeEq(createHmac("sha256", secret).update(msg).digest("hex"), hmac);
}

/** Webhooks: base64 HMAC-SHA256 of the raw body in X-Shopify-Hmac-Sha256. */
export function verifyWebhook(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  return safeEq(createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"), header);
}

/** What the CarrierService sends us (only the parts we use). */
export interface ShopifyRateRequest {
  rate: {
    destination: { country: string; province?: string | null; city?: string | null; name?: string | null; address1?: string | null; address2?: string | null; phone?: string | null; latitude?: number | null; longitude?: number | null };
    items: { grams: number; quantity: number; requires_shipping?: boolean }[];
    currency: string;
  };
}

export function rateRequestToApi(r: ShopifyRateRequest, service: "ecommerce" | "express") {
  const d = r.rate.destination;
  const grams = r.rate.items.filter((i) => i.requires_shipping !== false).reduce((s, i) => s + (i.grams || 0) * (i.quantity || 1), 0);
  return {
    service: service === "express" ? "express" : null,
    dropoff: { address: [d.address1, d.address2].filter(Boolean).join(", ") || d.city || "Ghana", city: d.city ?? null, region: d.province ?? null,
               ...(d.latitude && d.longitude ? { lat: d.latitude, lng: d.longitude } : {}) },
    parcel: { weight_g: Math.min(30_000, Math.max(100, Math.round(grams) || 1000)) },
  };
}

/** Our rates → Shopify's format. Prices are in the currency's minor unit as strings (pesewas for GHS). */
export function ratesToShopify(rates: { service: string; intercity_option: string | null; name: string; amount: number; notes?: string[] }[]) {
  return {
    rates: rates.map((r) => ({
      service_name: r.name, service_code: r.intercity_option ? `${r.service}:${r.intercity_option}` : r.service,
      total_price: String(r.amount), currency: "GHS", description: r.service === "intercity" ? "By bus between QCS hubs" : "Delivered by a QCS rider",
    })),
  };
}

export interface ShopifyOrder {
  id: number; name: string; email?: string | null; phone?: string | null; currency: string; total_price: string; subtotal_price?: string; total_weight?: number;
  financial_status?: string; payment_gateway_names?: string[]; cancelled_at?: string | null; tags?: string;
  shipping_address?: { name?: string | null; first_name?: string | null; last_name?: string | null; address1?: string | null; address2?: string | null; city?: string | null;
                       province?: string | null; country_code?: string | null; phone?: string | null; latitude?: number | null; longitude?: number | null } | null;
  billing_address?: { phone?: string | null } | null;
  customer?: { phone?: string | null } | null;
  shipping_lines?: { code?: string | null; source?: string | null; title?: string | null }[];
  line_items?: { title: string; quantity: number; requires_shipping?: boolean }[];
  note?: string | null;
}

export const isCod = (o: ShopifyOrder) => (o.payment_gateway_names ?? []).some((g) => /cash on delivery|\bcod\b|cash_on_delivery/i.test(g));
const pesewas = (s?: string) => Math.round(parseFloat(s ?? "0") * 100) || 0;

/**
 * Should this order become a QCS delivery, and with which service?
 *  - only Ghana addresses, not cancelled, something to ship;
 *  - if QCS is a checkout option (carrier service on), only orders where the customer chose QCS;
 *  - COD orders are booked when created (they never become "paid"); others when paid.
 */
export function orderDecision(o: ShopifyOrder, topic: string, shop: { service: string; auto_create: boolean; carrier_service_id: number | null }):
  { book: false; why: string } | { book: true; service: "ecommerce" | "express" | "intercity"; intercity_option: "doorstep" | "hub_collection" | null } {
  if (!shop.auto_create) return { book: false, why: "automatic booking is off" };
  if (o.cancelled_at) return { book: false, why: "order cancelled" };
  if (!o.shipping_address || (o.shipping_address.country_code && o.shipping_address.country_code !== "GH")) return { book: false, why: "no Ghana shipping address" };
  if (!(o.line_items ?? []).some((i) => i.requires_shipping !== false)) return { book: false, why: "nothing to ship" };
  const cod = isCod(o);
  if (topic === "orders/create" && !cod) return { book: false, why: "waiting for payment" };
  if (topic === "orders/paid" && cod) return { book: false, why: "COD order already handled at creation" };
  const qcsLine = (o.shipping_lines ?? []).find((l) => /qcs/i.test(`${l.source ?? ""} ${l.title ?? ""}`) || /^(ecommerce|express|intercity)(:|$)/.test(l.code ?? ""));
  if (shop.carrier_service_id && !qcsLine) return { book: false, why: "customer chose another shipping method" };
  const [svc, opt] = (qcsLine?.code ?? shop.service).split(":");
  const service = svc === "express" || svc === "intercity" ? svc : "ecommerce";
  return { book: true, service, intercity_option: service === "intercity" ? (opt === "hub_collection" ? "hub_collection" : "doorstep") : null };
}

/** Shopify order → Business API delivery request (the same one WooCommerce and developers send). */
export function orderToDelivery(o: ShopifyOrder, d: { service: "ecommerce" | "express" | "intercity"; intercity_option: "doorstep" | "hub_collection" | null }) {
  const a = o.shipping_address!;
  const name = a.name || [a.first_name, a.last_name].filter(Boolean).join(" ") || "Customer";
  const items = (o.line_items ?? []).filter((i) => i.requires_shipping !== false);
  return {
    service: d.service, intercity_option: d.intercity_option, reference: o.name.slice(0, 80),
    dropoff: {
      address: [a.address1, a.address2].filter(Boolean).join(", ") || a.city || "Ghana", city: a.city ?? null, region: a.province ?? null,
      ...(a.latitude && a.longitude ? { lat: a.latitude, lng: a.longitude } : {}),
      contact_name: name.slice(0, 120), contact_phone: a.phone || o.phone || o.customer?.phone || o.billing_address?.phone || "",
      instructions: o.note ? o.note.slice(0, 500) : null,
    },
    parcel: {
      weight_g: Math.min(30_000, Math.max(100, Math.round(o.total_weight ?? 0) || 1000)),
      description: items.map((i) => `${i.quantity}× ${i.title}`).join(", ").slice(0, 200) || null,
      value: o.currency === "GHS" ? pesewas(o.subtotal_price ?? o.total_price) : 0,
      cod_amount: isCod(o) && o.currency === "GHS" ? pesewas(o.total_price) : 0,
    },
  };
}
