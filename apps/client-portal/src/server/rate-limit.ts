import "server-only";
import { serviceClient } from "./supabase";
import { CORS } from "./tracking";

/** Count one hit in a bucket; false = over the limit. */
export type Hit = (bucket: string, max: number, windowS: number) => Promise<boolean>;

/**
 * Limits per route (hits per window). Generous for real people, tight enough to stop scripts and
 * to cap what a misbehaving app could cost us on Google Maps.
 */
export const LIMITS = {
  track:        { max: 30,  windowS: 60 },     // public tracking page, per IP
  confirmView:  { max: 30,  windowS: 60 },     // confirm-your-location page, per IP
  confirmMove:  { max: 10,  windowS: 3600 },   // pin corrections, per link (each one may re-price the trip)
  unsubscribe:  { max: 20,  windowS: 60 },     // per IP
  autocomplete: { max: 120, windowS: 60 },     // Google Places, per user (one call per few keystrokes)
  placeDetails: { max: 60,  windowS: 60 },     // Google Places, per user
  geocode:      { max: 30,  windowS: 60 },     // Google Geocoding, per user
  quotes:       { max: 60,  windowS: 60 },     // per user (each quote may call Google Routes)
  bookings:     { max: 20,  windowS: 60 },     // per user
  payments:     { max: 10,  windowS: 60 },     // starting a Hubtel checkout, per user
  health:       { max: 30,  windowS: 60 },     // uptime checker, per IP
} as const;
export type LimitName = keyof typeof LIMITS;

/** The visitor's IP. On Vercel, x-forwarded-for is set by Vercel itself (a visitor can't fake the first entry). */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

const liveHit: Hit = async (bucket, max, windowS) => {
  let db;
  try { db = serviceClient(); } catch { return true; }               // no server key (local dev): no limits
  const { data, error } = await db.rpc("rate_hit", { p_bucket: bucket, p_limit: max, p_window_s: windowS });
  if (error) { console.warn("rate limit check failed:", error.message); return true; }   // never block people because the counter is down
  return data === true;
};

/**
 * Returns a ready "429 Too many requests" answer when `who` has used up `name`'s limit, otherwise null.
 *   const stop = await limited("track", `ip:${clientIp(req)}`); if (stop) return stop;
 */
export async function limited(name: LimitName, who: string, hit: Hit = liveHit): Promise<Response | null> {
  const { max, windowS } = LIMITS[name];
  if (await hit(`${name}:${who}`, max, windowS)) return null;
  const retry = windowS - (Math.floor(Date.now() / 1000) % windowS);
  return Response.json({ error: windowS >= 3600 ? "Too many tries. Please wait an hour and try again." : "Too many requests. Please wait a minute and try again." },
    { status: 429, headers: { ...CORS, "Retry-After": String(retry) } });
}
