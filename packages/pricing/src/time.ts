/** Times are stored in UTC and shown in Africa/Accra (which is UTC+0 all year, no daylight saving). */
import type { NightWindow } from "./rules";

const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h! * 60 + m!; };
const accraMinutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

/** Is this moment inside the night window (which may cross midnight, e.g. 20:00–06:00)? */
export function isNight(at: Date, window: NightWindow): boolean {
  const t = accraMinutes(at), s = minutesOf(window.start), e = minutesOf(window.end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

/**
 * Same-day cut-off: book before the city's cut-off (e.g. 09:00) for same-day delivery,
 * otherwise the parcel is picked up the next day. Sundays roll to Monday.
 */
export function deliveryDay(now: Date, cutoff: string, opts: { noSunday?: boolean } = { noSunday: true }): { date: string; sameDay: boolean } {
  const sameDay = accraMinutes(now) < minutesOf(cutoff.slice(0, 5));
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (!sameDay) d.setUTCDate(d.getUTCDate() + 1);
  if (opts.noSunday && d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  const isToday = d.getUTCDate() === now.getUTCDate() && d.getUTCMonth() === now.getUTCMonth();
  return { date: d.toISOString().slice(0, 10), sameDay: isToday };
}

/** A scheduled pickup must be in the future (with a few minutes' slack) and not more than 14 days ahead. */
export function scheduleProblem(at: Date, now: Date): string | null {
  if (at.getTime() < now.getTime() + 15 * 60_000) return "Choose a pickup time at least 15 minutes from now";
  if (at.getTime() > now.getTime() + 14 * 86_400_000) return "You can schedule up to 14 days ahead";
  return null;
}
