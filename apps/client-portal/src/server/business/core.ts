/**
 * QCS Business API — the logic, with the outside world passed in (so it can be tested without a database or Google).
 * Turns API requests (plain-text addresses, simple parcels) into the platform's own BookingRequest, prices them with
 * the one pricing engine, and books them (live) or stores practice deliveries (test).
 */
import {
  ApiAddress, ApiCreateRequest, ApiDeliveryRequest, ApiRateRequest, BookingRequest, apiProblems, bookingProblems,
  normalizeGhanaPhone, type ApiParcel,
} from "@qcs/types";
import { ApiError } from "../supabase";

/** Price checks have no recipient yet: a valid-looking number keeps the shared booking rules happy. Never stored. */
export const PRICE_CHECK_PHONE = "+233240000000";

export interface Ctx {
  vendorId: string;
  mode: "live" | "test";
  ownerId: string;
  accountType: string;            // vendor | corporate
  defaultPickupId: string | null;
  businessName: string;
  source: "api" | "woocommerce" | "shopify";
}

export interface Place {
  formatted_address: string; lat: number; lng: number; ghana_post_gps: string | null; landmark: string | null;
  contact_name: string; contact_phone: string; instructions: string | null; approximate?: boolean;
}

export interface QuoteResult {
  quote_id: string; expires_at: string; city: string; totalPesewas: number; subtotalPesewas: number; discountPesewas?: number;
  stops: { netPesewas: number; insurancePesewas: number; totalPesewas: number; lines: { label: string; pesewas: number }[] }[];
  notes: string[];
}

export interface Deps {
  geocode: (q: string) => Promise<{ lat: number; lng: number } | null>;
  savedAddress: (id: string) => Promise<Place | null>;
  /** price (and when `save`, keep a 15-minute quote that can be booked) */
  quote: (req: BookingRequest, save: boolean) => Promise<QuoteResult>;
  loadQuote: (id: string) => Promise<{ request: BookingRequest; price: QuoteResult; used_at: string | null; expires_at: string; vendor_id: string | null } | null>;
  /** live: create_booking + mark source → tracking numbers */
  book: (quoteId: string) => Promise<string[]>;
  getDelivery: (tracking: string) => Promise<Record<string, unknown> | null>;
  testCreate: (data: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

// ---------- addresses ----------

/** A text address becomes a map point: exact pin if given, else Google, else the town (marked approximate). */
export async function resolvePlace(a: ApiAddress | Omit<ApiAddress, "contact_name" | "contact_phone"> & { contact_name?: string | null; contact_phone?: string | null },
                                   geocode: Deps["geocode"], which: string): Promise<Place> {
  const base = {
    formatted_address: [a.address, a.city, a.region].filter(Boolean).join(", "),
    ghana_post_gps: a.ghana_post_gps ?? null, landmark: a.landmark ?? null, instructions: a.instructions ?? null,
    contact_name: a.contact_name || "Customer", contact_phone: (a.contact_phone && normalizeGhanaPhone(a.contact_phone)) || PRICE_CHECK_PHONE,
  };
  if (a.lat != null && a.lng != null) return { ...base, lat: a.lat, lng: a.lng };
  const full = await geocode([a.address, a.landmark, a.city, a.region, "Ghana"].filter(Boolean).join(", "));
  if (full) return { ...base, ...full };
  const town = a.city || a.region;
  const rough = town ? await geocode(`${town}, Ghana`) : null;
  if (rough) return { ...base, ...rough, approximate: true };
  throw new ApiError(422, `We couldn't find the ${which} address on the map`,
    [`${which}: add the town in "city", a Ghana Post GPS code, or the map pin (lat/lng)`], "address_not_found");
}

function payerFor(ctx: Ctx, payer: "business" | "recipient") {
  if (payer === "recipient") return { payer: "recipient" as const, payment_method: "cash" as const };
  return ctx.accountType === "corporate" ? { payer: "corporate_invoice" as const, payment_method: "invoice" as const }
    : { payer: "vendor_wallet" as const, payment_method: "wallet" as const };
}

function dropoffFrom(p: Place, parcel: ApiParcel, reference: string | null) {
  return {
    formatted_address: p.formatted_address, lat: p.lat, lng: p.lng, ghana_post_gps: p.ghana_post_gps, landmark: p.landmark,
    contact_name: p.contact_name, contact_phone: p.contact_phone, instructions: p.instructions,
    weight_g: parcel.weight_g, size: parcel.size, fragile: parcel.fragile, item_description: parcel.description,
    item_value: parcel.value, insured: parcel.insured, cod_amount: parcel.cod_amount, external_ref: reference,
  };
}

async function pickupFor(ctx: Ctx, given: ApiAddress | null | undefined, deps: Deps): Promise<Place> {
  if (given) return resolvePlace(given, deps.geocode, "pickup");
  const saved = ctx.defaultPickupId ? await deps.savedAddress(ctx.defaultPickupId) : null;
  if (!saved) throw new ApiError(400, "No pickup address", ["pickup: send a pickup address, or set a default pickup address in the QCS business portal"], "invalid_request");
  return saved;
}

/** One API delivery → the platform's BookingRequest (validated by the same rules as the app and portal). */
export function toBooking(ctx: Ctx, r: ApiDeliveryRequest, pickup: Place, dropoffs: { place: Place; parcel: ApiParcel; reference: string | null }[]): BookingRequest {
  const parsed = BookingRequest.safeParse({
    service: r.service, intercity_option: r.service === "intercity" ? (r.intercity_option ?? "doorstep") : null,
    vendor_id: ctx.vendorId, scheduled_at: r.scheduled_at ?? null, promo_code: r.promo_code ?? null, ...payerFor(ctx, r.payer),
    pickup: { formatted_address: pickup.formatted_address, lat: pickup.lat, lng: pickup.lng, ghana_post_gps: pickup.ghana_post_gps, landmark: pickup.landmark,
              contact_name: pickup.contact_name, contact_phone: pickup.contact_phone, instructions: pickup.instructions },
    dropoffs: dropoffs.map((d) => dropoffFrom(d.place, d.parcel, d.reference)),
  });
  if (!parsed.success) throw new ApiError(400, "Please check the delivery details", bookingProblems(parsed.error), "invalid_request");
  return parsed.data;
}

// ---------- rates ----------

const LABEL: Record<string, string> = {
  ecommerce: "QCS same-day delivery", express: "QCS Express (rider now)",
  "intercity:doorstep": "QCS inter-city (to the door)", "intercity:hub_collection": "QCS inter-city (collect at QCS hub)",
};

/** Prices for a checkout page. Nothing is saved. Without `service`: every service that can deliver there (Express only on request — it uses a paid route lookup). */
export async function rates(ctx: Ctx, body: unknown, deps: Deps) {
  const p = ApiRateRequest.safeParse(body);
  if (!p.success) throw new ApiError(400, "Please check the request", apiProblems(p.error), "invalid_request");
  const r = p.data;
  const pickup = await pickupFor(ctx, r.pickup ? { ...r.pickup, contact_name: r.pickup.contact_name || ctx.businessName, contact_phone: r.pickup.contact_phone || PRICE_CHECK_PHONE } as ApiAddress : null, deps);
  const drop = await resolvePlace(r.dropoff, deps.geocode, "dropoff");
  const options: { service: "ecommerce" | "express" | "intercity"; option: "doorstep" | "hub_collection" | null }[] = r.service
    ? (r.service === "intercity" ? [{ service: "intercity", option: "doorstep" }, { service: "intercity", option: "hub_collection" }] : [{ service: r.service, option: null }])
    : [{ service: "ecommerce", option: null }, { service: "intercity", option: "doorstep" }, { service: "intercity", option: "hub_collection" }];
  const out: Record<string, unknown>[] = [];
  const problems: string[] = [];
  for (const o of options) {
    try {
      const req = toBooking(ctx, { service: o.service, intercity_option: o.option, dropoff: undefined as never, parcel: r.parcel, payer: "business", reference: null, pickup: null, promo_code: null, scheduled_at: null },
        pickup, [{ place: drop, parcel: r.parcel, reference: null }]);
      const q = await deps.quote(req, false);
      out.push({ service: o.service, intercity_option: o.option, name: LABEL[o.option ? `${o.service}:${o.option}` : o.service],
                 amount: q.totalPesewas, currency: "GHS", display: `GHS ${(q.totalPesewas / 100).toFixed(2)}`, notes: q.notes });
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) problems.push(...(e.details?.length ? e.details : [e.message])); else throw e;
    }
  }
  if (!out.length) throw new ApiError(422, "We can't deliver there with these details", [...new Set(problems)], "cannot_deliver");
  return { rates: out, address_approximate: !!drop.approximate };
}

// ---------- quote ----------

export async function quote(ctx: Ctx, body: unknown, deps: Deps) {
  const p = ApiDeliveryRequest.safeParse(body);
  if (!p.success) throw new ApiError(400, "Please check the delivery details", apiProblems(p.error), "invalid_request");
  const r = p.data;
  const [pickup, drop] = await Promise.all([pickupFor(ctx, r.pickup, deps), resolvePlace(r.dropoff, deps.geocode, "dropoff")]);
  const q = await deps.quote(toBooking(ctx, r, pickup, [{ place: drop, parcel: r.parcel, reference: r.reference ?? null }]), true);
  return {
    quote_id: q.quote_id, expires_at: q.expires_at, service: r.service,
    amount: q.totalPesewas, currency: "GHS", display: `GHS ${(q.totalPesewas / 100).toFixed(2)}`,
    breakdown: q.stops[0]?.lines.map((l) => ({ label: l.label, amount: l.pesewas })) ?? [],
    insurance_premium: q.stops[0]?.insurancePesewas ?? 0, notes: q.notes, address_approximate: !!drop.approximate,
  };
}

// ---------- create ----------

/** A practice delivery: same object as live, built from the real price, but nothing real happens. */
function testObject(ctx: Ctx, req: BookingRequest, price: QuoteResult, i: number): Record<string, unknown> {
  const d = req.dropoffs[i]!;
  const s = price.stops[i]!;
  return {
    reference: d.external_ref ?? null, service: req.service, intercity_option: req.intercity_option ?? null,
    fee: { amount: s.totalPesewas, currency: "GHS" }, cod_amount: d.cod_amount, payer: req.payer,
    pickup: { address: req.pickup.formatted_address, contact_name: req.pickup.contact_name, contact_phone: req.pickup.contact_phone },
    dropoff: { address: d.formatted_address, landmark: d.landmark ?? null, ghana_post_gps: d.ghana_post_gps ?? null, contact_name: d.contact_name,
               contact_phone: d.contact_phone, lat: d.lat, lng: d.lng },
    weight_g: d.weight_g, source: ctx.source,
  };
}

async function bookPriced(ctx: Ctx, req: BookingRequest, deps: Deps, existingQuote?: { id: string; price: QuoteResult }): Promise<Record<string, unknown>[]> {
  if (ctx.mode === "test") {
    const price = existingQuote?.price ?? await deps.quote(req, false);
    const out = [];
    for (let i = 0; i < req.dropoffs.length; i++) out.push(await deps.testCreate(testObject(ctx, req, price, i)));
    return out;
  }
  const quoteId = existingQuote?.id ?? (await deps.quote(req, true)).quote_id;
  const tracking = await deps.book(quoteId);
  const out = [];
  for (const tn of tracking) out.push((await deps.getDelivery(tn)) ?? { tracking_number: tn });
  return out;
}

/** POST /deliveries: either { quote_id } or a full delivery request. */
export async function create(ctx: Ctx, body: unknown, deps: Deps) {
  const p = ApiCreateRequest.safeParse(body);
  if (!p.success) {
    const full = ApiDeliveryRequest.safeParse(body);   // report the problems of the full form (more useful)
    throw new ApiError(400, "Please check the delivery details", apiProblems(full.success ? p.error : full.error), "invalid_request");
  }
  if ("quote_id" in p.data) {
    const q = await deps.loadQuote(p.data.quote_id);
    if (!q || q.vendor_id !== ctx.vendorId) throw new ApiError(404, "Quote not found", undefined, "not_found");
    if (q.used_at) throw new ApiError(409, "This quote has already been booked", undefined, "conflict");
    if (Date.parse(q.expires_at) < Date.now()) throw new ApiError(410, "This quote has expired. Get a new one.", undefined, "quote_expired");
    return (await bookPriced(ctx, q.request, deps, { id: p.data.quote_id, price: q.price }))[0]!;
  }
  const r = p.data;
  const [pickup, drop] = await Promise.all([pickupFor(ctx, r.pickup, deps), resolvePlace(r.dropoff, deps.geocode, "dropoff")]);
  return (await bookPriced(ctx, toBooking(ctx, r, pickup, [{ place: drop, parcel: r.parcel, reference: r.reference ?? null }]), deps))[0]!;
}

// ---------- bulk ----------

type BulkResult = { index: number; ok: true; delivery: Record<string, unknown> } | { index: number; ok: false; error: { code: string; message: string; details?: string[] } };
const errOf = (e: unknown) => (e instanceof ApiError ? { code: e.code ?? codeFor(e.status), message: e.message, details: e.details } : { code: "server_error", message: "Something went wrong" });

/**
 * Up to 100 deliveries. Each is checked on its own (one bad address doesn't stop the rest).
 * Same-city e-commerce drop-offs from the same pickup are booked together, 25 per trip, like a portal bulk upload.
 */
export async function bulk(ctx: Ctx, items: unknown[], deps: Deps): Promise<{ results: BulkResult[]; created: number; failed: number }> {
  const results: BulkResult[] = [];
  const ready: { index: number; r: ApiDeliveryRequest; pickup: Place; drop: Place }[] = [];
  await Promise.all(items.map(async (item, index) => {
    try {
      const p = ApiDeliveryRequest.safeParse(item);
      if (!p.success) throw new ApiError(400, "Please check the delivery details", apiProblems(p.error), "invalid_request");
      const [pickup, drop] = await Promise.all([pickupFor(ctx, p.data.pickup, deps), resolvePlace(p.data.dropoff, deps.geocode, "dropoff")]);
      ready.push({ index, r: p.data, pickup, drop });
    } catch (e) { results.push({ index, ok: false, error: errOf(e) }); }
  }));
  const refs = new Map<string, number>();
  for (const x of ready.sort((a, b) => a.index - b.index)) {
    const ref = x.r.reference;
    if (ref && refs.has(ref)) results.push({ index: x.index, ok: false, error: { code: "conflict", message: `reference ${ref} appears twice in this request` } });
    else if (ref) refs.set(ref, x.index);
  }
  const todo = ready.filter((x) => !results.some((r) => r.index === x.index));
  // group e-commerce drop-offs that share pickup, payer and time
  const groups = new Map<string, typeof todo>();
  for (const x of todo) {
    const key = x.r.service === "ecommerce" && x.r.payer === "business" && !x.r.promo_code
      ? `ecom|${x.pickup.lat},${x.pickup.lng}|${x.r.scheduled_at ?? ""}` : `single|${x.index}`;
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 25) {
      const chunk = group.slice(i, i + 25);
      try {
        const req = toBooking(ctx, chunk[0]!.r, chunk[0]!.pickup, chunk.map((x) => ({ place: x.drop, parcel: x.r.parcel, reference: x.r.reference ?? null })));
        const made = await bookPriced(ctx, req, deps);
        chunk.forEach((x, j) => results.push({ index: x.index, ok: true, delivery: made[j]! }));
      } catch (e) {
        if (chunk.length === 1) { results.push({ index: chunk[0]!.index, ok: false, error: errOf(e) }); continue; }
        // one bad drop-off spoils a shared trip: book each on its own to find which
        for (const x of chunk) {
          try {
            const made = await bookPriced(ctx, toBooking(ctx, x.r, x.pickup, [{ place: x.drop, parcel: x.r.parcel, reference: x.r.reference ?? null }]), deps);
            results.push({ index: x.index, ok: true, delivery: made[0]! });
          } catch (e2) { results.push({ index: x.index, ok: false, error: errOf(e2) }); }
        }
      }
    }
  }
  results.sort((a, b) => a.index - b.index);
  return { results, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

export function codeFor(status: number): string {
  return ({ 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 410: "quote_expired",
            422: "cannot_deliver", 429: "rate_limited" } as Record<number, string>)[status] ?? (status >= 500 ? "server_error" : "error");
}

/** Database messages we show as 409 (a repeated order number). */
export function dbError(message: string): ApiError {
  if (/already booked/i.test(message)) return new ApiError(409, message, undefined, "conflict");
  if (/on hold/i.test(message)) return new ApiError(403, message, undefined, "account_on_hold");
  return new ApiError(400, message, undefined, "invalid_request");
}
