/** Report periods in Accra days. Address-bar values: ?from=YYYY-MM-DD&to=YYYY-MM-DD or ?p=7d|30d|90d|month|lastmonth */
const accraToday = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Accra" }));
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export const PRESETS = [["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["month", "This month"], ["lastmonth", "Last month"]] as const;

export function period(sp: Record<string, string | string[] | undefined>): { from: string; to: string; preset: string | null; label: string } {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
  const today = accraToday();
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const f = one("from"), t = one("to");
  if (f && t && re.test(f) && re.test(t) && f <= t) return { from: f, to: t, preset: null, label: `${f} → ${t}` };
  const p = one("p") ?? "7d";
  if (p === "month") return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today), preset: p, label: "This month" };
  if (p === "lastmonth") {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return { from: iso(first), to: iso(new Date(today.getFullYear(), today.getMonth(), 0)), preset: p, label: "Last month" };
  }
  const n = p === "30d" ? 30 : p === "90d" ? 90 : 7;
  return { from: iso(addDays(today, -(n - 1))), to: iso(today), preset: `${n}d`, label: `Last ${n} days` };
}

export const shortDay = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const longDay = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
