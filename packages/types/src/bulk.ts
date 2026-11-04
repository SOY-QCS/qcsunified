/**
 * Bulk upload (CSV or Excel): check every row and explain problems row by row.
 * The file is read by the browser (papaparse / read-excel-file); this file only checks the rows.
 */
import { Dropoff, type Dropoff as DropoffT } from "./booking";

export const BULK_COLUMNS = [
  { key: "recipient_name", label: "Recipient name", required: true, example: "Esi Mensah" },
  { key: "recipient_phone", label: "Recipient phone", required: true, example: "0241234567" },
  { key: "address", label: "Address", required: true, example: "House 12, Lagos Avenue, East Legon" },
  { key: "landmark", label: "Landmark", required: false, example: "Near the A&C Mall" },
  { key: "ghana_post_gps", label: "Ghana Post GPS", required: false, example: "GA-123-4567" },
  { key: "latitude", label: "Latitude", required: false, example: "5.6355" },
  { key: "longitude", label: "Longitude", required: false, example: "-0.1610" },
  { key: "weight_kg", label: "Weight (kg)", required: true, example: "1.5" },
  { key: "size", label: "Size (small/medium/large/xl)", required: false, example: "small" },
  { key: "fragile", label: "Fragile (yes/no)", required: false, example: "no" },
  { key: "item_description", label: "Item", required: false, example: "2 dresses" },
  { key: "item_value_ghs", label: "Item value (GHS)", required: false, example: "350" },
  { key: "cod_ghs", label: "Cash to collect (GHS)", required: false, example: "350" },
  { key: "instructions", label: "Delivery instructions", required: false, example: "Call on arrival" },
  { key: "order_ref", label: "Your order number", required: false, example: "WC-1043" },
] as const;

export const MAX_BULK_ROWS = 500;

export function bulkTemplateCsv(): string {
  const head = BULK_COLUMNS.map((c) => c.key).join(",");
  const ex = BULK_COLUMNS.map((c) => (c.example.includes(",") ? `"${c.example}"` : c.example)).join(",");
  return `${head}\n${ex}\n`;
}

/** Accept the column key, the friendly label, or close variants ("Phone", "Recipient Phone #"). */
const ALIASES: Record<string, string> = {
  name: "recipient_name", customer: "recipient_name", customer_name: "recipient_name", recipient: "recipient_name",
  phone: "recipient_phone", phone_number: "recipient_phone", customer_phone: "recipient_phone", mobile: "recipient_phone",
  gps: "ghana_post_gps", digital_address: "ghana_post_gps", gps_address: "ghana_post_gps",
  lat: "latitude", lng: "longitude", lon: "longitude", long: "longitude",
  weight: "weight_kg", kg: "weight_kg", value: "item_value_ghs", item_value: "item_value_ghs",
  cod: "cod_ghs", cash_on_delivery: "cod_ghs", amount_to_collect: "cod_ghs",
  notes: "instructions", note: "instructions", ref: "order_ref", order_number: "order_ref", order_id: "order_ref", item: "item_description",
};
export function normaliseHeader(h: string): string {
  const k = h.trim().toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const byLabel = BULK_COLUMNS.find((c) => c.label.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") === k);
  return byLabel?.key ?? ALIASES[k] ?? k;
}

export interface BulkProblem { row: number; column: string; message: string }
export interface BulkRow { row: number; dropoff: Omit<DropoffT, "lat" | "lng"> & { lat: number | null; lng: number | null } }
export interface BulkResult { rows: BulkRow[]; problems: BulkProblem[]; needsLocation: number[] }

const num = (v: string | undefined) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, "").replace(/^GH[S₵]?/i, ""));
  return Number.isFinite(n) ? n : NaN;
};
const yes = (v: string | undefined) => /^(y|yes|true|1)$/i.test(String(v ?? "").trim());

/**
 * Check raw rows. Rows need either latitude+longitude or a Ghana Post GPS / address the server can find;
 * those without coordinates are listed in `needsLocation` so the server can look them up.
 * `rowOffset` = 2 for files with a header line (so row numbers match what the vendor sees in Excel).
 */
export function checkBulkRows(raw: Record<string, unknown>[], rowOffset = 2): BulkResult {
  const problems: BulkProblem[] = [];
  const rows: BulkRow[] = [];
  const needsLocation: number[] = [];
  if (raw.length === 0) return { rows, problems: [{ row: 0, column: "", message: "The file has no rows" }], needsLocation };
  if (raw.length > MAX_BULK_ROWS) return { rows, problems: [{ row: 0, column: "", message: `Upload at most ${MAX_BULK_ROWS} rows at a time` }], needsLocation };

  raw.forEach((original, i) => {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(original)) r[normaliseHeader(k)] = v == null ? "" : String(v).trim();
    if (Object.values(r).every((v) => v === "")) return; // skip empty lines
    const rowNo = i + rowOffset;
    const add = (column: string, message: string) => problems.push({ row: rowNo, column, message });

    for (const c of BULK_COLUMNS) if (c.required && !r[c.key]) add(c.key, `${c.label} is missing`);
    const lat = num(r.latitude), lng = num(r.longitude);
    if ((lat === null) !== (lng === null)) add(lat === null ? "latitude" : "longitude", "Give both latitude and longitude, or neither");
    if (Number.isNaN(lat) || Number.isNaN(lng)) add("latitude", "Latitude/longitude must be numbers");
    const kg = num(r.weight_kg);
    if (r.weight_kg && (kg === null || Number.isNaN(kg) || kg <= 0)) add("weight_kg", "Weight must be a number of kg, e.g. 1.5");
    const value = num(r.item_value_ghs), cod = num(r.cod_ghs);
    if (Number.isNaN(value)) add("item_value_ghs", "Item value must be a number");
    if (Number.isNaN(cod)) add("cod_ghs", "Cash to collect must be a number");
    const size = (r.size || "small").toLowerCase().replace("extra large", "xl").replace("extra_large", "xl");
    if (!["small", "medium", "large", "xl"].includes(size)) add("size", "Size must be small, medium, large or xl");
    if (problems.some((p) => p.row === rowNo)) return;

    const parsed = Dropoff.safeParse({
      formatted_address: r.address, lat: lat ?? 5.6, lng: lng ?? -0.19, // placeholder until located
      ghana_post_gps: r.ghana_post_gps || null, landmark: r.landmark || null,
      contact_name: r.recipient_name, contact_phone: r.recipient_phone, instructions: r.instructions || null,
      weight_g: Math.round((kg ?? 0) * 1000), size, fragile: yes(r.fragile), item_description: r.item_description || null,
      item_value: Math.round((value ?? 0) * 100), cod_amount: Math.round((cod ?? 0) * 100), external_ref: r.order_ref || null,
    });
    if (!parsed.success) {
      parsed.error.issues.forEach((iss) => add(String(iss.path[0] ?? ""), iss.message));
      return;
    }
    if (lat === null) needsLocation.push(rowNo);
    rows.push({ row: rowNo, dropoff: { ...parsed.data, lat, lng } });
  });

  // Same order number twice in one file is almost always a copy-paste mistake.
  const seen = new Map<string, number>();
  rows.forEach((r) => {
    const ref = r.dropoff.external_ref;
    if (!ref) return;
    if (seen.has(ref)) problems.push({ row: r.row, column: "order_ref", message: `Order number ${ref} is also on row ${seen.get(ref)}` });
    else seen.set(ref, r.row);
  });
  return { rows, problems, needsLocation };
}

/** A CSV the vendor can download: their row number, the column and what to fix. */
export function problemsCsv(problems: BulkProblem[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ["row,column,problem", ...problems.map((p) => [p.row, p.column, p.message].map((x) => esc(String(x))).join(","))].join("\n") + "\n";
}

/** Split many drop-offs into trips of at most 25. */
export function splitIntoTrips<T>(items: T[], size = 25): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
