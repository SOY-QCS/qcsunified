import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingRequest } from "@qcs/types";
import { ApiError, serviceClient } from "../supabase";
import { geocode as googleGeocode } from "../maps";
import { buildQuote, liveDeps } from "../quote";
import { codeFor, dbError, PRICE_CHECK_PHONE, type Ctx, type Deps, type Place, type QuoteResult } from "./core";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Errors look the same everywhere: { error: { code, message, details? } }. */
export function apiJson(body: unknown, status: number, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}
const errorBody = (e: ApiError) => ({ error: { code: e.code ?? codeFor(e.status), message: e.message, ...(e.details?.length ? { details: e.details } : {}) } });

export interface Handler {
  (ctx: Ctx, deps: Deps, body: unknown, db: SupabaseClient): Promise<{ status: number; body: unknown; reference?: string | null }>;
}

/**
 * Every Business API call: check the key (Authorization: Bearer qcs_live_… / qcs_test_…), rate limit, log,
 * Idempotency-Key replay for POSTs that create things, consistent errors. The log id comes back as QCS-Request-Id.
 */
export async function runApi(req: Request, handler: Handler, opts: { idempotent?: boolean; liveOnly?: boolean; testOnly?: boolean } = {}): Promise<Response> {
  const started = Date.now();
  const auth = req.headers.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : (req.headers.get("x-api-key") ?? "").trim();
  if (!/^qcs_(live|test)_[0-9a-f]{48}$/.test(key)) {
    return apiJson({ error: { code: "unauthorized", message: "Send your API key as: Authorization: Bearer qcs_live_… (or qcs_test_…)" } }, 401);
  }
  let db: SupabaseClient;
  try { db = serviceClient(); } catch (e) { return apiJson(errorBody(e as ApiError), 500); }
  const url = new URL(req.url);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || null;
  const { data: begin, error: beginErr } = await db.rpc("api_begin", { p_hash: sha256(key), p_method: req.method, p_path: url.pathname.replace(/^\/api\/business/, ""), p_ip: ip });
  if (beginErr) return apiJson({ error: { code: "server_error", message: "Please try again" } }, 503);
  const b = begin as { ok: boolean; status?: number; error?: string; vendor_id: string; mode: "live" | "test"; owner_id: string; account_type: string;
                       log_id: number; default_pickup_address_id: string | null; business_name: string };
  if (!b.ok) return apiJson({ error: { code: codeFor(b.status!), message: b.error } }, b.status!, b.status === 429 ? { "Retry-After": "60" } : {});
  const headers: Record<string, string> = { "QCS-Request-Id": String(b.log_id), "QCS-Mode": b.mode };
  const integration = (req.headers.get("qcs-integration") ?? "").toLowerCase();
  const ctx: Ctx = { vendorId: b.vendor_id, mode: b.mode, ownerId: b.owner_id, accountType: b.account_type, defaultPickupId: b.default_pickup_address_id,
                     businessName: b.business_name, source: integration === "woocommerce" || integration === "shopify" ? integration : "api" };
  const finish = async (status: number, body: unknown, reference?: string | null, error?: string) => {
    await db.rpc("api_end", { p_log: b.log_id, p_status: status, p_ms: Date.now() - started, p_error: error ?? null, p_reference: reference ?? null });
    return apiJson(body, status, headers);
  };
  if (opts.liveOnly && ctx.mode === "test") return finish(400, { error: { code: "live_only", message: "This needs a live key" } });
  if (opts.testOnly && ctx.mode === "live") return finish(400, { error: { code: "test_only", message: "Only test keys can simulate status changes. Live deliveries move when the rider does." } });

  let raw = "";
  let body: unknown = null;
  if (req.method === "POST") {
    raw = await req.text();
    if (raw.length > 1_000_000) return finish(413, { error: { code: "too_large", message: "Request body is over 1 MB" } });
    try { body = raw ? JSON.parse(raw) : {}; } catch { return finish(400, { error: { code: "invalid_json", message: "The body is not valid JSON" } }); }
  }

  const idem = opts.idempotent ? (req.headers.get("idempotency-key") ?? "").trim() : "";
  if (idem) {
    if (idem.length > 200) return finish(400, { error: { code: "invalid_request", message: "Idempotency-Key is too long (max 200)" } });
    const { data: prior } = await db.rpc("api_idem_claim", { p_vendor: ctx.vendorId, p_mode: ctx.mode, p_key: idem, p_hash: sha256(raw) });
    const p = prior as { conflict?: boolean; in_progress?: boolean; status?: number; response?: unknown } | null;
    if (p?.conflict) return finish(409, { error: { code: "idempotency_conflict", message: "This Idempotency-Key was already used with a different request" } });
    if (p?.in_progress) return finish(409, { error: { code: "in_progress", message: "The first request with this Idempotency-Key is still being processed. Retry in a few seconds." } });
    if (p?.status) { headers["QCS-Idempotent-Replay"] = "true"; return finish(p.status, p.response, null, "replayed"); }
  }

  let status = 500; let out: unknown; let reference: string | null | undefined; let err: string | undefined;
  try {
    const r = await handler(ctx, liveApiDeps(db, ctx), body, db);
    ({ status, body: out, reference } = r);
  } catch (e) {
    if (e instanceof ApiError) { status = e.status; out = errorBody(e); err = e.message; }
    else { console.error("business api", e); status = 500; out = { error: { code: "server_error", message: "Something went wrong. Please retry (with the same Idempotency-Key)." } }; err = String(e).slice(0, 300); }
  }
  if (idem) await db.rpc("api_idem_save", { p_vendor: ctx.vendorId, p_mode: ctx.mode, p_key: idem, p_status: status, p_response: out });
  return finish(status, out, reference, err);
}

// ---------- the real outside world ----------

const cache = new Map<string, { at: number; v: { lat: number; lng: number } | null }>();
/** Google geocoding, remembered for a day per server (checkout pages ask for the same addresses again and again). */
async function cachedGeocode(q: string) {
  const k = q.toLowerCase().replace(/\s+/g, " ").trim();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.v;
  const v = await googleGeocode(q);
  if (cache.size > 5000) cache.clear();
  cache.set(k, { at: Date.now(), v });
  return v;
}

export function liveApiDeps(db: SupabaseClient, ctx: Ctx): Deps {
  const q = liveDeps(db, ctx.ownerId, [ctx.vendorId]);
  return {
    geocode: cachedGeocode,
    savedAddress: async (id) => {
      const [{ data }, { data: v }] = await Promise.all([
        db.from("addresses").select("formatted_address, lat, lng, ghana_post_gps, landmark, contact_name, contact_phone").eq("id", id).eq("vendor_id", ctx.vendorId).maybeSingle(),
        db.from("vendors").select("contact_phone").eq("id", ctx.vendorId).single(),
      ]);
      // the rider calls this number at pickup: the address's own contact, else the business's phone
      return data ? { ...data, contact_name: data.contact_name || ctx.businessName, contact_phone: data.contact_phone || v?.contact_phone || PRICE_CHECK_PHONE, instructions: null } as Place : null;
    },
    quote: async (req: BookingRequest, save: boolean) => (await buildQuote(req, save ? q : { ...q, saveQuote: async () => ({ id: "", expires_at: "" }) })) as unknown as QuoteResult,
    loadQuote: async (id) => {
      const { data } = await db.from("quotes").select("request, price, used_at, expires_at, vendor_id, total").eq("id", id).eq("user_id", ctx.ownerId).maybeSingle();
      return data ? { ...data, price: { ...data.price, quote_id: id, totalPesewas: data.total } } : null;
    },
    book: async (quoteId) => {
      const { data, error } = await db.rpc("create_booking", { p_user: ctx.ownerId, p_quote: quoteId });
      if (error) throw dbError(error.message);
      await db.rpc("api_mark_source", { p_quote: quoteId, p_source: ctx.source });
      return ((data as { orders: { tracking_number: string }[] }).orders).map((o) => o.tracking_number);
    },
    getDelivery: async (tn) => (await db.rpc("api_get_delivery", { p_vendor: ctx.vendorId, p_tracking: tn })).data,
    testCreate: async (d) => {
      const { data, error } = await db.rpc("api_test_create", { p_vendor: ctx.vendorId, p_data: d });
      if (error) throw dbError(error.message);
      return data;
    },
  };
}
