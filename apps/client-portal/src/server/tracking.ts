import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { priceBooking, pinCorrectionExtra, NightWindow, type PricingRuleRow } from "@qcs/pricing";
import { metresBetween, type TrackResult } from "@qcs/types";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { ApiError } from "./supabase";
import { roadRoute, type LatLng } from "./maps";

/** The website and phone apps call these from other addresses, so allow any origin (no cookies are needed). */
export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization" };
export const preflight = () => new Response(null, { status: 204, headers: CORS });
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

export const anonClient = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Acts as the signed-in person if there is one (sender sees everything), otherwise as the public. */
export async function viewerClient(req: Request): Promise<SupabaseClient> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  }
  try {
    const sb = await supabaseServer();
    if ((await sb.auth.getUser()).data.user) return sb;
  } catch { /* no cookie session (e.g. called from the website) */ }
  return anonClient();
}

/** Tracking answer, with the rider's photo turned into a 10-minute link (the photo itself stays private). */
export async function track(db: SupabaseClient, service: SupabaseClient | null, tn: string, last4: string | null): Promise<TrackResult> {
  const { data, error } = await db.rpc("track_order", { p_tracking: tn, p_last4: last4 });
  if (error) throw new ApiError(400, error.message);
  const r = data as TrackResult & { rider?: { photo_path?: string | null } | null };
  if (r.rider) {
    const path = r.rider.photo_path;
    delete r.rider.photo_path;
    r.rider.photo_url = path && service ? (await service.storage.from("kyc").createSignedUrl(path, 600)).data?.signedUrl ?? null : null;
  }
  return r;
}

// ---------- recipient moves the pin ----------
export interface PinMoveDeps {
  link: (token: string) => Promise<{ service_type: string; lat: number; lng: number; can_change: boolean } | null>;
  order: (token: string) => Promise<{ city_id: string; created_at: string; weight_g: number; is_fragile: boolean; quote: { request: { pickup: LatLng }; price: { stops: { feePesewas?: number }[] } } | null }>;
  zoneFor: (p: LatLng) => Promise<{ zone_id: string; city_id: string } | null>;
  rules: (cityId: string) => Promise<PricingRuleRow[]>;
  setting: (key: string, cityId: string) => Promise<unknown>;
  cutoff: (cityId: string) => Promise<string>;
  route: typeof roadRoute;
  correct: (args: { p_token: string; p_lng: number; p_lat: number; p_landmark: string; p_note: string; p_extra: number }) => Promise<{ moved_m: number; extra: number }>;
}

/**
 * CLAUDE.md §10: Express pin moved more than 1 km → re-price with the pricing engine (same booking time, so the
 * same night/surge rules) and charge only the difference, collected on delivery. 1 km or less keeps the quote.
 * E-commerce/inter-city prices don't depend on distance, so they never change here.
 */
export async function movePin(token: string, to: LatLng & { landmark?: string; note?: string }, d: PinMoveDeps) {
  const link = await d.link(token);
  if (!link) throw new ApiError(404, "This link is not valid");
  if (!link.can_change) throw new ApiError(409, "This delivery can no longer be changed. Please call the rider.");
  const movedM = metresBetween({ lat: link.lat, lng: link.lng }, to);
  let extra = 0;
  if (link.service_type === "express" && movedM > 1000) {
    const o = await d.order(token);
    const zone = await d.zoneFor(to);
    if (!zone || zone.city_id !== o.city_id) throw new ApiError(400, "That location is outside the delivery area for this parcel");
    const pickup = o.quote?.request.pickup;
    const oldFee = o.quote?.price.stops[0]?.feePesewas;
    if (pickup && oldFee != null) {
      const [rules, cutoff, nightRaw, surgeRaw, r] = await Promise.all([d.rules(o.city_id), d.cutoff(o.city_id), d.setting("night_window", o.city_id), d.setting("surge_multiplier", o.city_id), d.route(pickup, to)]);
      const price = priceBooking({
        service: "express", cityId: o.city_id, rules, now: new Date(o.created_at), cutoff,
        nightWindow: NightWindow.safeParse(nightRaw).success ? NightWindow.parse(nightRaw) : { start: "20:00", end: "06:00" },
        surge: Math.min(3, Math.max(1, Number(surgeRaw ?? 1) || 1)),
        stops: [{ weightG: o.weight_g, fragile: o.is_fragile, zoneId: zone.zone_id, distanceM: r.distanceM, durationS: r.durationS }],
      });
      extra = pinCorrectionExtra(oldFee, movedM, price.stops[0]!.feePesewas);
    }
  }
  return d.correct({ p_token: token, p_lng: to.lng, p_lat: to.lat, p_landmark: to.landmark ?? "", p_note: to.note ?? "", p_extra: extra });
}

export function liveMoveDeps(service: SupabaseClient): PinMoveDeps {
  return {
    link: async (t) => (await service.rpc("address_link", { p_token: t })).data,
    order: async (t) => {
      const { data, error } = await service.from("orders").select("city_id, created_at, weight_g, is_fragile, quote:quotes(request, price)").eq("confirm_token", t).single();
      if (error) throw error;
      return data as unknown as Awaited<ReturnType<PinMoveDeps["order"]>>;
    },
    zoneFor: async (p) => ((await service.rpc("zone_for_point", { p_lng: p.lng, p_lat: p.lat })).data as { zone_id: string; city_id: string }[] | null)?.[0] ?? null,
    rules: async (c) => ((await service.from("pricing_rules").select("*").eq("is_active", true).or(`city_id.eq.${c},city_id.is.null`)).data ?? []) as PricingRuleRow[],
    setting: async (key, c) => ((await service.from("app_settings").select("value, city_id").eq("key", key).or(`city_id.eq.${c},city_id.is.null`)).data ?? [])
      .sort((a, b) => (a.city_id ? -1 : 1) - (b.city_id ? -1 : 1))[0]?.value,
    cutoff: async (c) => (await service.from("cities").select("same_day_cutoff").eq("id", c).single()).data?.same_day_cutoff ?? "09:00",
    route: roadRoute,
    correct: async (args) => {
      const { data, error } = await service.rpc("correct_address", args);
      if (error) throw new ApiError(400, error.message);
      return data;
    },
  };
}
