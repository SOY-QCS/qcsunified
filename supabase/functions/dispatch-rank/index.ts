/**
 * Ranks the 5 nearest eligible riders for each waiting job by motorbike ROAD time (Google Routes API),
 * so the first offer goes to the rider who can really get there fastest (CLAUDE.md §6). One Google call per job.
 * Run by a schedule every few seconds (see README). If Google is unavailable, dispatch carries on by straight-line distance.
 * Secrets: GOOGLE_MAPS_SERVER_KEY, DISPATCH_RANK_SECRET (the schedule sends it as "x-qcs-secret").
 */
import { createClient } from "npm:@supabase/supabase-js@2";

export interface RankDeps {
  tripsToRank: () => Promise<{ trip_id: string; pickup_lat: number; pickup_lng: number }[]>;
  candidates: (tripId: string) => Promise<string[]>;
  positions: (riders: string[]) => Promise<{ rider_id: string; lat: number; lng: number }[]>;
  routeMatrix: (origins: { lat: number; lng: number }[], dest: { lat: number; lng: number }) => Promise<(number | null)[]>;   // seconds per origin
  save: (tripId: string, ranked: string[]) => Promise<void>;
}

export async function rankAll(deps: RankDeps): Promise<{ ranked: number }> {
  let ranked = 0;
  for (const t of await deps.tripsToRank()) {
    const ids = await deps.candidates(t.trip_id);
    if (ids.length === 0) { await deps.save(t.trip_id, []); continue; }
    const pos = await deps.positions(ids);
    let times: (number | null)[] = [];
    try { times = await deps.routeMatrix(pos, { lat: t.pickup_lat, lng: t.pickup_lng }); } catch { times = []; }
    const order = pos.map((p, i) => ({ id: p.rider_id, s: times[i] ?? null }))
      .sort((a, b) => (a.s ?? Infinity) - (b.s ?? Infinity) || ids.indexOf(a.id) - ids.indexOf(b.id))
      .map((x) => x.id);
    await deps.save(t.trip_id, order);
    ranked++;
  }
  return { ranked };
}

/** Google Routes API computeRouteMatrix: many riders → one pickup, motorbike, traffic-aware. */
export async function googleRouteMatrix(key: string, origins: { lat: number; lng: number }[], dest: { lat: number; lng: number }, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "originIndex,duration,condition" },
    body: JSON.stringify({
      origins: origins.map((o) => ({ waypoint: { location: { latLng: { latitude: o.lat, longitude: o.lng } } } })),
      destinations: [{ waypoint: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } } }],
      travelMode: "TWO_WHEELER", routingPreference: "TRAFFIC_AWARE",
    }),
  });
  if (!res.ok) throw new Error(`Routes API ${res.status}`);
  const rows = await res.json() as { originIndex?: number; duration?: string; condition?: string }[];
  const out: (number | null)[] = origins.map(() => null);
  for (const r of rows) if (r.condition === "ROUTE_EXISTS" && r.duration) out[r.originIndex ?? 0] = parseInt(r.duration, 10);
  return out;
}

if (import.meta.main) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const key = Deno.env.get("GOOGLE_MAPS_SERVER_KEY") ?? "";
  Deno.serve(async (req) => {
    if (req.headers.get("x-qcs-secret") !== Deno.env.get("DISPATCH_RANK_SECRET")) return new Response("Unauthorized", { status: 401 });
    const result = await rankAll({
      tripsToRank: async () => (await db.rpc("trips_to_rank")).data ?? [],
      candidates: async (id) => ((await db.rpc("candidate_riders", { p_trip: id, p_limit: 5 })).data ?? []).map((r: { rider_id: string }) => r.rider_id),
      positions: async (ids) => (await db.rpc("rider_positions", { p_riders: ids })).data ?? [],
      routeMatrix: (o, d) => (key ? googleRouteMatrix(key, o, d) : Promise.resolve([])),
      save: async (id, ranked) => { await db.rpc("set_dispatch_ranking", { p_trip: id, p_riders: ranked }); },
    });
    await db.rpc("dispatch_tick");   // offer straight away
    return Response.json(result);
  });
}
