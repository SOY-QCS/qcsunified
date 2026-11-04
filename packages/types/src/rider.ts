/**
 * Rider-app logic that doesn't need a phone, so it can be tested:
 * next-stop choice, failed-attempt reasons, navigation links and the offline action queue.
 */

export interface LatLng { lat: number; lng: number }

export function metresBetween(a: LatLng, b: LatLng): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

const DONE = new Set(["DELIVERED", "COLLECTED", "RETURNED", "CANCELLED", "LOST", "DAMAGED", "AT_HUB", "RESCHEDULED", "FAILED_ATTEMPT", "RETURNING_TO_SENDER"]);
export const isOpenStop = (status: string) => !DONE.has(status);

/** CLAUDE.md §6: always suggest the nearest undelivered stop next (straight line — free, works offline). */
export function nearestStop<T extends { id: string; status: string; lat: number; lng: number }>(stops: T[], here: LatLng | null): T | null {
  const open = stops.filter((s) => isOpenStop(s.status));
  if (!open.length) return null;
  if (!here) return open[0]!;
  return open.reduce((best, s) => (metresBetween(here, s) < metresBetween(here, best) ? s : best));
}

/** Order the open stops by a simple "nearest next" walk from where the rider is. */
export function suggestedRoute<T extends { id: string; status: string; lat: number; lng: number }>(stops: T[], here: LatLng | null): T[] {
  const left = stops.filter((s) => isOpenStop(s.status));
  const out: T[] = [];
  let at = here;
  while (left.length) {
    const next = nearestStop(left, at)!;
    out.push(next);
    left.splice(left.indexOf(next), 1);
    at = next;
  }
  return out;
}

export const FAILED_REASONS = [
  { value: "recipient_unreachable", label: "Recipient not answering calls" },
  { value: "recipient_not_available", label: "Recipient not at the address" },
  { value: "wrong_address", label: "Wrong or unclear address" },
  { value: "refused", label: "Recipient refused the parcel" },
  { value: "no_cash", label: "Recipient doesn't have the COD cash" },
  { value: "rescheduled_by_recipient", label: "Recipient asked for another day" },
  { value: "unsafe", label: "Unsafe to deliver" },
  { value: "damaged", label: "Parcel damaged" },
] as const;

/** Hand-off to Google Maps turn-by-turn (motorbike directions where Google supports them). */
export function navigationUrl(to: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}&travelmode=two-wheeler`;
}

// ---------- offline queue ----------
export interface QueuedAction {
  key: string;                       // unique per action: the server ignores repeats of the same key
  action: Record<string, unknown>;
  occurredAt: string;                // phone time
  files?: { field: string; localUri: string; path: string; contentType: string }[];   // uploaded before the action is sent
  attempts: number;
  error?: string;
}
export interface Queue { items: QueuedAction[]; failed: QueuedAction[] }
export const emptyQueue = (): Queue => ({ items: [], failed: [] });

export function enqueue(q: Queue, a: Omit<QueuedAction, "attempts">): Queue {
  if (q.items.some((x) => x.key === a.key)) return q;
  return { ...q, items: [...q.items, { ...a, attempts: 0 }] };
}

/** Network problems are retried; refusals from the server (wrong code, not allowed…) are shown to the rider instead. */
export function isNetworkError(e: unknown): boolean {
  const m = String((e as { message?: string })?.message ?? e).toLowerCase();
  return m.includes("network") || m.includes("fetch") || m.includes("timeout") || m.includes("offline") || m.includes("failed to connect");
}

export function settle(q: Queue, key: string, outcome: { ok: true } | { ok: false; error: unknown }): Queue {
  const item = q.items.find((x) => x.key === key);
  if (!item) return q;
  const rest = q.items.filter((x) => x.key !== key);
  if (outcome.ok) return { ...q, items: rest };
  if (isNetworkError(outcome.error)) {
    return { ...q, items: q.items.map((x) => (x.key === key ? { ...x, attempts: x.attempts + 1 } : x)) };
  }
  return { items: rest, failed: [...q.failed, { ...item, attempts: item.attempts + 1, error: String((outcome.error as { message?: string })?.message ?? outcome.error) }] };
}

/** Actions for the same parcel must reach the server in order (arrived → picked up → delivered). */
export function nextToSend(q: Queue): QueuedAction | null {
  return q.items[0] ?? null;
}
