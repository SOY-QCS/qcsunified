import "server-only";
/**
 * Google Maps Platform calls, made from the server so the API key never sits in an app.
 *   • Routes API (replaces the legacy Distance Matrix) — motorbike road distance/time for Express
 *   • Places API (New) — address autocomplete limited to Ghana
 *   • Geocoding API — finding pins for bulk-upload rows that have no coordinates
 * Without GOOGLE_MAPS_SERVER_KEY (e.g. local testing) we fall back to straight-line estimates.
 * Cost control: one Routes call per Express quote; autocomplete uses session tokens (billed per session, not per keystroke).
 */

const KEY = () => process.env.GOOGLE_MAPS_SERVER_KEY ?? "";
export const hasGoogle = () => KEY() !== "";

export interface LatLng { lat: number; lng: number }

export function straightLineM(a: LatLng, b: LatLng): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Road distance/time by motorbike. Falls back to straight line × 1.35 at 22 km/h (typical Accra traffic). */
export async function roadRoute(from: LatLng, to: LatLng, fetchImpl: typeof fetch = fetch): Promise<{ distanceM: number; durationS: number; estimated: boolean }> {
  const fallback = () => {
    const d = Math.round(straightLineM(from, to) * 1.35);
    return { distanceM: d, durationS: Math.round((d / 1000 / 22) * 3600), estimated: true };
  };
  if (!hasGoogle()) return fallback();
  try {
    const res = await fetchImpl("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY(), "X-Goog-FieldMask": "routes.distanceMeters,routes.duration" },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: "TWO_WHEELER",
        routingPreference: "TRAFFIC_AWARE",
      }),
    });
    const body = await res.json() as { routes?: { distanceMeters?: number; duration?: string }[] };
    const r = body.routes?.[0];
    if (!res.ok || !r?.distanceMeters) return fallback();
    return { distanceM: r.distanceMeters, durationS: parseInt(r.duration ?? "0", 10), estimated: false };
  } catch {
    return fallback();
  }
}

export interface Suggestion { place_id: string; main: string; secondary: string }

export async function autocomplete(q: string, session: string, near?: LatLng): Promise<Suggestion[]> {
  if (!hasGoogle() || q.trim().length < 3) return [];
  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY() },
    body: JSON.stringify({
      input: q, sessionToken: session, includedRegionCodes: ["gh"],
      ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 30000 } } } : {}),
    }),
  });
  if (!res.ok) return [];
  const body = await res.json() as { suggestions?: { placePrediction?: { placeId: string; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }[] };
  return (body.suggestions ?? []).flatMap((s) => s.placePrediction ? [{
    place_id: s.placePrediction.placeId,
    main: s.placePrediction.structuredFormat?.mainText?.text ?? "",
    secondary: s.placePrediction.structuredFormat?.secondaryText?.text ?? "",
  }] : []);
}

export async function placeDetails(id: string, session: string): Promise<{ formatted_address: string; lat: number; lng: number; google_place_id: string } | null> {
  if (!hasGoogle()) return null;
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?sessionToken=${encodeURIComponent(session)}`, {
    headers: { "X-Goog-Api-Key": KEY(), "X-Goog-FieldMask": "id,formattedAddress,displayName,location" },
  });
  if (!res.ok) return null;
  const p = await res.json() as { id: string; formattedAddress?: string; displayName?: { text: string }; location?: { latitude: number; longitude: number } };
  if (!p.location) return null;
  const name = p.displayName?.text, addr = p.formattedAddress ?? "";
  return { google_place_id: p.id, formatted_address: name && !addr.startsWith(name) ? `${name}, ${addr}` : addr, lat: p.location.latitude, lng: p.location.longitude };
}

export async function geocode(address: string): Promise<LatLng | null> {
  if (!hasGoogle()) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:GH&key=${KEY()}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json() as { results?: { geometry: { location: LatLng } }[] };
  return body.results?.[0]?.geometry.location ?? null;
}
