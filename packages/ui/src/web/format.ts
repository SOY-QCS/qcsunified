/** Number formats for charts and tables. Plain functions (usable on the server); charts take the format NAME. */
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-GH");
export const fmtGhs = (p: number) => `GHS ${(p / 100).toLocaleString("en-GH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
export const fmtPct = (n: number) => `${n.toFixed(n % 1 ? 1 : 0)}%`;
export const fmtMins = (n: number) => (n >= 90 ? `${(n / 60).toFixed(1)} h` : `${Math.round(n)} min`);
export const fmtHours = (n: number) => `${n.toLocaleString("en-GH", { maximumFractionDigits: n >= 100 ? 0 : 1 })} h`;
export const FORMATS = { int: fmtInt, ghs: fmtGhs, pct: fmtPct, mins: fmtMins, hours: fmtHours } as const;
export type FmtName = keyof typeof FORMATS;

/** Fixed colour per service (never by rank); checked for colour-blind separation. */
export const SERVICE_SERIES = [
  { key: "express", label: "Express", color: "#2a78d6" },
  { key: "ecommerce", label: "E-commerce", color: "#eb6834" },
  { key: "intercity", label: "Inter-city", color: "#1baf7a" },
] as const;
