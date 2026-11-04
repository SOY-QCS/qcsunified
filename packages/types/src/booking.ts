/**
 * What a booking looks like when an app sends it to the server (shared by app, portal and API).
 * Money in pesewas, weight in grams. The server prices it; apps never send a price.
 */
import { z } from "zod";
import { GhanaPostGps, normalizeGhanaPhone } from "./common";

export const PACKAGE_SIZES = [
  { value: "small", label: "Small", hint: "Fits in a handbag — documents, phone, cosmetics" },
  { value: "medium", label: "Medium", hint: "Shoebox — clothes, shoes, small electronics" },
  { value: "large", label: "Large", hint: "Backpack size — fits on a bike carrier" },
  { value: "xl", label: "Extra large", hint: "Up to 15 kg for Express; heavier only on e-commerce trips" },
] as const;
export const PackageSize = z.enum(["small", "medium", "large", "xl"]);

const phone = z.string().transform((v, ctx) => {
  const p = normalizeGhanaPhone(v);
  if (!p) { ctx.addIssue({ code: "custom", message: "Enter a Ghana phone number, e.g. 024 123 4567" }); return z.NEVER; }
  return p;
});
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => v || null);

export const Place = z.object({
  address_id: z.uuid().optional().nullable(),
  formatted_address: z.string().trim().min(3, "Enter the address").max(300),
  lat: z.number().min(4.5).max(11.3, "That pin isn't in Ghana"),
  lng: z.number().min(-3.4).max(1.3, "That pin isn't in Ghana"),
  ghana_post_gps: z.union([GhanaPostGps, z.literal(""), z.null()]).optional().transform((v) => v || null),
  google_place_id: optionalText(300),
  landmark: optionalText(200),
  contact_name: z.string().trim().min(2, "Enter the contact name").max(120),
  contact_phone: phone,
  instructions: optionalText(500),
});
export type Place = z.infer<typeof Place>;

export const Dropoff = Place.extend({
  weight_g: z.number().int().positive("Enter the weight").max(30_000, "Over 30 kg — contact QCS for heavy items"),
  size: PackageSize.default("small"),
  fragile: z.boolean().default(false),
  item_description: optionalText(200),
  item_value: z.number().int().min(0).default(0),
  insured: z.boolean().default(false),
  cod_amount: z.number().int().min(0).default(0),
  external_ref: optionalText(80),
  /** fulfilment: products sent from the vendor's stock at a QCS hub */
  items: z.array(z.object({ sku_id: z.uuid(), qty: z.number().int().positive().max(1000) })).max(50).optional().nullable(),
});
export type Dropoff = z.infer<typeof Dropoff>;

export const PayerOption = z.enum(["sender", "recipient", "vendor_wallet", "corporate_invoice"]);
export const PaymentMethodOption = z.enum(["card", "momo", "wallet", "cash", "invoice"]);

export const BookingRequest = z.object({
  service: z.enum(["express", "ecommerce", "intercity"]),
  /** inter-city: recipient collects at the destination hub, or QCS delivers to the door */
  intercity_option: z.enum(["hub_collection", "doorstep"]).optional().nullable(),
  /** fulfilment: ship from the vendor's stock at this hub (the hub becomes the pickup) */
  fulfilment_hub_id: z.uuid().optional().nullable(),
  vendor_id: z.uuid().optional().nullable(),
  scheduled_at: z.iso.datetime().optional().nullable(),
  pickup: Place,
  dropoffs: z.array(Dropoff).min(1, "Add a drop-off").max(25, "A trip can have at most 25 drop-offs"),
  payer: PayerOption,
  payment_method: PaymentMethodOption,
  promo_code: z.string().trim().toUpperCase().max(40).optional().nullable().transform((v) => v || null),
}).superRefine((b, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (b.service === "express" && b.dropoffs.length !== 1) issue(["dropoffs"], "Express takes one drop-off. Use an e-commerce trip for several.");
  if (b.service === "express") b.dropoffs.forEach((d, i) => { if (d.weight_g > 15_000) issue(["dropoffs", i, "weight_g"], "Express is bike-only: 15 kg maximum"); });
  if (b.service === "ecommerce" && !b.vendor_id) issue(["service"], "E-commerce trips are for business accounts");
  if (b.service === "intercity" && !b.intercity_option) issue(["intercity_option"], "Choose hub collection or doorstep delivery");
  if (b.fulfilment_hub_id) {
    if (!b.vendor_id) issue(["fulfilment_hub_id"], "Shipping from stock is for business accounts");
    if (b.service === "express") issue(["service"], "Stock shipments go as e-commerce or inter-city");
    b.dropoffs.forEach((d, i) => { if (!d.items?.length) issue(["dropoffs", i, "items"], "Choose the products to send"); });
  } else b.dropoffs.forEach((d, i) => { if (d.items?.length) issue(["dropoffs", i, "items"], "Products can only be sent from stock at a hub"); });
  if (!b.vendor_id) b.dropoffs.forEach((d, i) => { if (d.cod_amount > 0) issue(["dropoffs", i, "cod_amount"], "Cash on Delivery is for business accounts"); });
  b.dropoffs.forEach((d, i) => { if (d.cod_amount > 0 && b.payer === "recipient") issue(["payer"], "With Cash on Delivery the delivery fee is billed to the business, not the recipient"); void i; });
  const ok: Record<string, string[]> = {
    sender: ["card", "momo", "wallet", "cash"],
    recipient: ["cash"],
    vendor_wallet: ["wallet"],
    corporate_invoice: ["invoice"],
  };
  if (!ok[b.payer]!.includes(b.payment_method)) issue(["payment_method"], "That payment method doesn't go with who pays");
  if ((b.payer === "vendor_wallet" || b.payer === "corporate_invoice") && !b.vendor_id) issue(["payer"], "Only business accounts can pay by wallet or invoice");
  if (b.payer === "recipient" && b.dropoffs.length > 1) issue(["payer"], "On a bulk trip the business pays (wallet or invoice)");
});
export type BookingRequest = z.infer<typeof BookingRequest>;

/** Turn Zod problems into short sentences for the person filling in the form. */
export function bookingProblems(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const p = i.path;
    const where = p[0] === "dropoffs" && typeof p[1] === "number" ? `Drop-off ${p[1] + 1}: ` : p[0] === "pickup" ? "Pickup: " : "";
    return `${where}${i.message}`;
  });
}
