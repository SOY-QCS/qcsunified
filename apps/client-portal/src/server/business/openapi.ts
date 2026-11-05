/**
 * The OpenAPI 3.1 description of the Business API, built from the same Zod schemas the server validates with,
 * so the docs can't drift from the code. Served at /api/business/v1/openapi.json and shown on /docs/api.
 */
import { z } from "zod";
import { ApiBulkRequest, ApiCancelRequest, ApiCreateRequest, ApiDeliveryRequest, ApiRateRequest, ApiSimulateRequest } from "@qcs/types";

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>;

const money = { type: "object", properties: { amount: { type: "integer", description: "pesewas" }, currency: { type: "string", const: "GHS" } } };
const Delivery = {
  type: "object",
  description: "A delivery. Test-mode deliveries look the same, with livemode=false and a TEST- tracking number.",
  properties: {
    tracking_number: { type: "string", example: "ACC-202611051301-ACC" },
    reference: { type: ["string", "null"], description: "Your order number" },
    livemode: { type: "boolean" },
    service: { type: "string", enum: ["ecommerce", "express", "intercity"] },
    intercity_option: { type: ["string", "null"], enum: ["hub_collection", "doorstep", null] },
    status: { type: "string", example: "PICKED_UP", description: "See the status list in the guide" },
    status_text: { type: "string", example: "Picked up" },
    fee: money,
    cod_amount: { type: "integer", description: "pesewas" },
    payer: { type: "string" },
    pickup: { type: "object", properties: { address: { type: "string" }, contact_name: { type: "string" }, contact_phone: { type: "string" } } },
    dropoff: { type: "object", properties: { address: { type: "string" }, landmark: { type: ["string", "null"] }, ghana_post_gps: { type: ["string", "null"] },
      contact_name: { type: "string" }, contact_phone: { type: "string" }, lat: { type: "number" }, lng: { type: "number" } } },
    weight_g: { type: "integer" },
    address_confirmed: { type: "boolean", description: "The recipient confirmed the map pin from the link we sent them" },
    rider: { type: ["object", "null"], properties: { first_name: { type: "string" }, phone: { type: "string" } } },
    tracking_url: { type: "string", format: "uri" },
    source: { type: ["string", "null"], enum: ["api", "woocommerce", "shopify", null] },
    created_at: { type: "string", format: "date-time" },
    delivered_at: { type: ["string", "null"], format: "date-time" },
    events: { type: "array", description: "History (single delivery only)", items: { type: "object", properties: {
      status: { type: "string" }, status_text: { type: "string" }, at: { type: "string", format: "date-time" }, reason: { type: ["string", "null"] } } } },
  },
};
const Error = {
  type: "object",
  properties: { error: { type: "object", required: ["code", "message"], properties: {
    code: { type: "string", enum: ["invalid_request", "invalid_json", "unauthorized", "forbidden", "not_found", "conflict", "idempotency_conflict", "in_progress",
      "quote_expired", "cannot_deliver", "address_not_found", "cannot_cancel", "account_on_hold", "rate_limited", "live_only", "test_only", "too_large", "server_error"] },
    message: { type: "string" }, details: { type: "array", items: { type: "string" } } } } },
};
const err = (desc: string) => ({ description: desc, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
const ok = (desc: string, s: unknown) => ({ description: desc, content: { "application/json": { schema: s } } });
const body = (s: unknown, example?: unknown) => ({ required: true, content: { "application/json": { schema: s, ...(example ? { example } : {}) } } });
const idParam = { name: "id", in: "path", required: true, description: "Tracking number, or your own order number (reference)", schema: { type: "string" } };
const idemHeader = { name: "Idempotency-Key", in: "header", required: false, description: "Any unique string (e.g. 'woo-1042'). Retrying with the same key returns the first answer instead of booking twice (24 h).", schema: { type: "string", maxLength: 200 } };
const common = { 401: err("Missing, invalid or revoked API key"), 429: err("Over 120 requests per minute for this key — wait and retry (see Retry-After)") };

const example = {
  reference: "WOO-1042",
  dropoff: { address: "12 Lagos Avenue, East Legon", city: "Accra", landmark: "behind the Shell station", contact_name: "Esi Mensah", contact_phone: "0243334444" },
  parcel: { weight_g: 1500, description: "2 dresses", cod_amount: 25000 },
};

export function openApi(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "QCS Ghana Business API",
      version: "1.0.0",
      description: [
        "Book and track QCS deliveries from your own systems.",
        "",
        "**Keys.** Create keys in the QCS business portal → Developers. `qcs_test_…` keys create practice deliveries (nothing is picked up, nobody is charged) and can simulate status changes; `qcs_live_…` keys book real deliveries. Send the key as `Authorization: Bearer <key>`. Keep keys on your server — never in a website or app.",
        "",
        "**Money** is in pesewas (GHS 1.00 = 100). **Addresses** can be text (we find them on the map) or a map pin (lat/lng, more accurate). The recipient always gets a link to confirm their location.",
        "",
        "**Webhooks.** Add an https endpoint in the portal. Each POST carries `QCS-Signature: t=<unix time>,v1=<hex>` where v1 = HMAC-SHA256(your endpoint secret, `<t>.<raw body>`). Check it, reject old timestamps (5 min), answer 2xx quickly. Failures are retried for about 2 days (1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, 24 h). Events: `delivery.created`, `delivery.status_changed`, `ping`.",
        "",
        "**Errors** look like `{\"error\": {\"code\": \"invalid_request\", \"message\": \"…\", \"details\": [\"dropoff.contact_phone: …\"]}}`. Every answer has a `QCS-Request-Id` header (find it in your API logs).",
      ].join("\n"),
    },
    servers: [{ url: `${serverUrl.replace(/\/$/, "")}/api/business/v1` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "qcs_live_… or qcs_test_…" } },
      schemas: {
        Delivery, Error,
        DeliveryRequest: schema(ApiDeliveryRequest),
        CreateRequest: schema(ApiCreateRequest),
        RateRequest: schema(ApiRateRequest),
        BulkRequest: schema(ApiBulkRequest),
        CancelRequest: schema(ApiCancelRequest),
        SimulateRequest: schema(ApiSimulateRequest),
        WebhookEvent: { type: "object", properties: {
          id: { type: "string", example: "evt_3f2c…" }, type: { type: "string", enum: ["delivery.created", "delivery.status_changed", "ping"] },
          created_at: { type: "string", format: "date-time" }, livemode: { type: "boolean" },
          data: { allOf: [{ $ref: "#/components/schemas/Delivery" }], description: "The delivery; status_changed adds previous_status, reason and changed_at" } } },
      },
    },
    paths: {
      "/rates": { post: {
        operationId: "getRates", summary: "Price check (checkout pages)", tags: ["Prices"],
        description: "Prices for every service that can deliver to this address. Nothing is saved. Express is only priced when you ask for it.",
        requestBody: body({ $ref: "#/components/schemas/RateRequest" }, { dropoff: { address: "Adum", city: "Kumasi" }, parcel: { weight_g: 2000 } }),
        responses: { 200: ok("Prices", { type: "object", properties: { rates: { type: "array", items: { type: "object", properties: {
          service: { type: "string" }, intercity_option: { type: ["string", "null"] }, name: { type: "string" }, amount: { type: "integer" }, currency: { type: "string" }, display: { type: "string" } } } },
          address_approximate: { type: "boolean", description: "We only found the town, not the street" } } }),
          400: err("Invalid request"), 422: err("We can't deliver there"), ...common } } },
      "/quotes": { post: {
        operationId: "createQuote", summary: "Get a quote", tags: ["Prices"],
        description: "The exact price for one delivery, held for 15 minutes. Book it with `POST /deliveries {\"quote_id\": …}`.",
        requestBody: body({ $ref: "#/components/schemas/DeliveryRequest" }, example),
        responses: { 201: ok("Quote", { type: "object", properties: { quote_id: { type: "string" }, expires_at: { type: "string", format: "date-time" }, amount: { type: "integer" },
          currency: { type: "string" }, display: { type: "string" }, breakdown: { type: "array", items: { type: "object" } }, insurance_premium: { type: "integer" } } }),
          400: err("Invalid request"), 422: err("We can't deliver there"), ...common } } },
      "/deliveries": {
        post: {
          operationId: "createDelivery", summary: "Create a delivery", tags: ["Deliveries"], parameters: [idemHeader],
          description: "Book a delivery, either from a quote (`{\"quote_id\": …}`) or directly with the full details. Leave out `pickup` to use your default pickup address.",
          requestBody: body({ $ref: "#/components/schemas/CreateRequest" }, example),
          responses: { 201: ok("Booked", { $ref: "#/components/schemas/Delivery" }), 400: err("Invalid request"), 403: err("Bookings on hold for this account (unpaid invoices)"),
            409: err("Order number already booked, or Idempotency-Key reused with a different body"), 410: err("Quote expired"), 422: err("We can't deliver there"), ...common } },
        get: {
          operationId: "listDeliveries", summary: "List deliveries", tags: ["Deliveries"],
          parameters: [
            { name: "status", in: "query", schema: { type: "string" }, description: "One or more statuses, comma separated, e.g. DELIVERED,FAILED_ATTEMPT" },
            { name: "from", in: "query", schema: { type: "string", format: "date-time" } }, { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "reference", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
            { name: "before", in: "query", schema: { type: "string", format: "date-time" }, description: "Next page: pass next_before from the previous answer" },
          ],
          responses: { 200: ok("Newest first", { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Delivery" } },
            has_more: { type: "boolean" }, next_before: { type: ["string", "null"] } } }), ...common } },
      },
      "/deliveries/bulk": { post: {
        operationId: "createDeliveries", summary: "Create many deliveries", tags: ["Deliveries"], parameters: [idemHeader],
        description: "Up to 100 deliveries. Each one succeeds or fails on its own. Same-city e-commerce drop-offs from the same pickup are grouped into trips of up to 25 stops. Answers 201 (all created), 207 (some failed) or 400 (none created).",
        requestBody: body({ $ref: "#/components/schemas/BulkRequest" }, { deliveries: [example, { ...example, reference: "WOO-1043" }] }),
        responses: { 201: ok("All created", { type: "object", properties: { created: { type: "integer" }, failed: { type: "integer" }, results: { type: "array", items: { type: "object", properties: {
          index: { type: "integer" }, ok: { type: "boolean" }, delivery: { $ref: "#/components/schemas/Delivery" }, error: { $ref: "#/components/schemas/Error/properties/error" } } } } } }),
          207: { description: "Some failed (same body)" }, 400: err("None created"), ...common } } },
      "/deliveries/{id}": { get: {
        operationId: "getDelivery", summary: "Get a delivery", tags: ["Deliveries"], parameters: [idParam],
        responses: { 200: ok("Status and history", { $ref: "#/components/schemas/Delivery" }), 404: err("Not found"), ...common } } },
      "/deliveries/{id}/cancel": { post: {
        operationId: "cancelDelivery", summary: "Cancel a delivery", tags: ["Deliveries"], parameters: [idParam],
        description: "Only before the rider has picked the parcel up. Wallet charges are refunded automatically.",
        requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/CancelRequest" } } } },
        responses: { 200: ok("Cancelled", { $ref: "#/components/schemas/Delivery" }), 404: err("Not found"), 409: err("Too late to cancel"), ...common } } },
      "/deliveries/{id}/simulate": { post: {
        operationId: "simulateDelivery", summary: "Simulate a status change (test mode)", tags: ["Testing"], parameters: [idParam],
        description: "Test keys only. Moves a practice delivery to any status and sends the webhook, so you can test your integration end to end.",
        requestBody: body({ $ref: "#/components/schemas/SimulateRequest" }, { status: "DELIVERED" }),
        responses: { 200: ok("Updated", { $ref: "#/components/schemas/Delivery" }), 400: err("Live key, unknown status, or finished delivery"), ...common } } },
      "/me": { get: {
        operationId: "whoAmI", summary: "Check your key", tags: ["Testing"],
        responses: { 200: ok("The business and mode of this key", { type: "object", properties: { business: { type: "string" }, mode: { type: "string" },
          livemode: { type: "boolean" }, has_default_pickup: { type: "boolean" } } }), ...common } } },
    },
    webhooks: {
      deliveryEvent: { post: {
        summary: "Delivery event (sent to your endpoint)",
        parameters: [{ name: "QCS-Signature", in: "header", required: true, schema: { type: "string" }, description: "t=<unix>,v1=<hex HMAC-SHA256>" },
                     { name: "QCS-Event", in: "header", schema: { type: "string" } }, { name: "QCS-Delivery-Attempt", in: "header", schema: { type: "integer" } }],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEvent" } } } },
        responses: { 200: { description: "Answer any 2xx within 10 seconds" } } } },
    },
  };
}
