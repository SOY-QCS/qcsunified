/**
 * QCS Business API (v1) — request shapes, shared by the API server, the OpenAPI document and the integrations.
 * Money is always in pesewas (GHS 1.00 = 100); weights in grams; times ISO 8601 (UTC).
 */
import { z } from "zod";
import { GhanaPostGps, normalizeGhanaPhone } from "./common";

const phone = z.string().describe("Ghana phone number, e.g. 0241234567 or +233241234567").transform((v, ctx) => {
  const p = normalizeGhanaPhone(v);
  if (!p) { ctx.addIssue({ code: "custom", message: "Enter a Ghana phone number, e.g. 024 123 4567" }); return z.NEVER; }
  return p;
});
const text = (max: number, about: string) => z.string().trim().max(max).nullish().transform((v) => v || null).describe(about);

const addressFields = {
  address: z.string().trim().min(3, "Enter the address").max(300).describe("Street address or description as the customer wrote it"),
  city: text(80, "Town or city — helps us find the address on the map"),
  region: text(80, "Region, e.g. Greater Accra"),
  lat: z.number().min(4.5).max(11.3).nullish().describe("Latitude, if you have the map pin (better than text)"),
  lng: z.number().min(-3.4).max(1.3).nullish().describe("Longitude, if you have the map pin"),
  ghana_post_gps: z.union([GhanaPostGps, z.literal(""), z.null()]).optional().transform((v) => v || null).describe("Ghana Post digital address, e.g. GA-123-4567"),
  landmark: text(200, "Nearby landmark, e.g. 'opposite Shell, Spintex'"),
  instructions: text(500, "Notes for the rider"),
};
const coords = (a: { lat?: number | null; lng?: number | null }) => (a.lat == null) === (a.lng == null);

export const ApiAddress = z.object({
  ...addressFields,
  contact_name: z.string().trim().min(2, "Enter the contact name").max(120),
  contact_phone: phone,
}).refine(coords, { message: "Send both lat and lng, or neither", path: ["lat"] });
export type ApiAddress = z.infer<typeof ApiAddress>;

/** For price checks a name/phone isn't known yet. */
export const ApiRateAddress = z.object({
  ...addressFields,
  contact_name: z.string().trim().max(120).nullish(),
  contact_phone: z.string().nullish(),
}).refine(coords, { message: "Send both lat and lng, or neither", path: ["lat"] });

export const ApiParcel = z.object({
  weight_g: z.number().int().positive().max(30_000, "Over 30 kg — contact QCS for heavy items").default(1000).describe("Weight in grams"),
  size: z.enum(["small", "medium", "large", "xl"]).default("small"),
  fragile: z.boolean().default(false),
  description: text(200, "What's inside, e.g. '2 dresses'"),
  value: z.number().int().min(0).default(0).describe("Item value in pesewas (for insurance)"),
  insured: z.boolean().default(false).describe("Insure the parcel (items worth GHS 1,000+; premium 5% of value)"),
  cod_amount: z.number().int().min(0).default(0).describe("Cash on Delivery: amount the rider collects, in pesewas (0 = none)"),
});
export type ApiParcel = z.infer<typeof ApiParcel>;

export const API_SERVICES = ["ecommerce", "express", "intercity"] as const;

export const ApiDeliveryRequest = z.object({
  service: z.enum(API_SERVICES).default("ecommerce").describe("ecommerce = same-city delivery priced by zone; express = a rider now; intercity = another city by bus"),
  intercity_option: z.enum(["hub_collection", "doorstep"]).nullish().describe("Inter-city only: recipient collects at the QCS hub, or we deliver to the door"),
  pickup: ApiAddress.nullish().describe("Where the rider collects. Leave out to use your default pickup address (set in the portal)"),
  dropoff: ApiAddress,
  parcel: ApiParcel.default({ weight_g: 1000, size: "small", fragile: false, description: null, value: 0, insured: false, cod_amount: 0 }),
  reference: z.string().trim().min(1).max(80).nullish().describe("Your order number. Must be unique; you can fetch the delivery by it"),
  scheduled_at: z.iso.datetime().nullish().describe("Pickup time for a scheduled delivery (leave out for the next available slot)"),
  payer: z.enum(["business", "recipient"]).default("business").describe("business = your wallet (or monthly invoice for corporate accounts); recipient = the recipient pays the rider cash"),
  promo_code: z.string().trim().toUpperCase().max(40).nullish().transform((v) => v || null),
});
export type ApiDeliveryRequest = z.infer<typeof ApiDeliveryRequest>;

export const ApiCreateRequest = z.union([
  z.object({ quote_id: z.uuid().describe("Book a quote you got from POST /quotes (valid 15 minutes)"), reference: z.string().trim().max(80).nullish() }).strict(),
  ApiDeliveryRequest,
]);

export const ApiRateRequest = z.object({
  service: z.enum(API_SERVICES).nullish().describe("Leave out to get every service that can deliver there"),
  pickup: ApiRateAddress.nullish(),
  dropoff: ApiRateAddress,
  parcel: ApiParcel.default({ weight_g: 1000, size: "small", fragile: false, description: null, value: 0, insured: false, cod_amount: 0 }),
});
export type ApiRateRequest = z.infer<typeof ApiRateRequest>;

export const ApiBulkRequest = z.object({
  deliveries: z.array(z.unknown()).min(1).max(100, "At most 100 deliveries per call").describe("Up to 100 delivery requests (same shape as POST /deliveries)"),
});

export const ApiCancelRequest = z.object({ reason: z.string().trim().max(200).nullish() });
export const ApiSimulateRequest = z.object({
  status: z.string().describe("Test mode only: the status to move to, e.g. PICKED_UP, DELIVERED, FAILED_ATTEMPT"),
  reason: z.string().trim().max(100).nullish().describe("Needed for FAILED_ATTEMPT, e.g. recipient_unreachable"),
});

/** Turn Zod problems into short sentences with where they are, e.g. "dropoff.contact_phone: Enter a Ghana phone number". */
export function apiProblems(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`);
}

export const WEBHOOK_EVENTS = ["delivery.created", "delivery.status_changed"] as const;

/**
 * Webhook signature (same idea as Stripe): header `QCS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Verify by recomputing it, comparing in constant time, and rejecting timestamps older than 5 minutes.
 */
export const SIGNATURE_HEADER = "QCS-Signature";
export function signaturePayload(timestamp: number, rawBody: string): string { return `${timestamp}.${rawBody}`; }
export function parseSignature(header: string | null): { t: number; v1: string } | null {
  if (!header) return null;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  return Number.isInteger(t) && /^[0-9a-f]{64}$/.test(parts.v1 ?? "") ? { t, v1: parts.v1! } : null;
}
