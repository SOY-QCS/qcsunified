import { z } from "zod";

export type Kind = "clients" | "riders";
export interface City { code: string; name: string }

/** Column names people actually use in spreadsheets → our names. Matching ignores case, spaces, dots and dashes. */
const ALIASES: Record<string, string> = {
  name: "name", fullname: "name", customername: "name", ridername: "name", contactname: "name",
  phone: "phone", phonenumber: "phone", mobile: "phone", mobilenumber: "phone", tel: "phone", telephone: "phone", contact: "phone", whatsapp: "phone",
  email: "email", emailaddress: "email",
  city: "city", town: "city", location: "city", branch: "city",
  type: "type", accounttype: "type", customertype: "type", clienttype: "type",
  businessname: "business_name", business: "business_name", company: "business_name", companyname: "business_name", shopname: "business_name", shop: "business_name",
  marketingoptin: "marketing_opt_in", optin: "marketing_opt_in", marketing: "marketing_opt_in", promotions: "marketing_opt_in",
  momonumber: "momo_number", momo: "momo_number", mobilemoney: "momo_number", payoutnumber: "momo_number",
  momonetwork: "momo_network", network: "momo_network",
  codpayout: "cod_payout", payoutschedule: "cod_payout",
  tags: "tags", notes: "notes", note: "notes", comments: "notes",
  ridertype: "rider_type", contract: "rider_type",
  status: "status",
  vehicletype: "vehicle_type", vehicle: "vehicle_type",
  plate: "plate", platenumber: "plate", vehiclenumber: "plate", registration: "plate", regno: "plate", numberplate: "plate",
  makemodel: "make_model", make: "make_model", model: "make_model", bike: "make_model", bikemodel: "make_model",
  commissionpct: "commission_pct", commission: "commission_pct", commissionpercent: "commission_pct",
};
export const COLUMNS: Record<Kind, string[]> = {
  clients: ["name", "phone", "email", "city", "type", "business_name", "marketing_opt_in", "momo_number", "momo_network", "cod_payout", "tags", "notes"],
  riders: ["name", "phone", "email", "city", "rider_type", "status", "vehicle_type", "plate", "make_model", "momo_number", "momo_network", "commission_pct"],
};
export const columnFor = (header: string) => ALIASES[header.toLowerCase().replace(/[\s._%-]/g, "")] ?? null;

/** Any Ghana number format → +233XXXXXXXXX (same rule as the apps). */
export function ghanaPhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, "");
  let local: string;
  if (digits.startsWith("233") && digits.length === 12) local = digits.slice(3);
  else if (digits.startsWith("0") && digits.length === 10) local = digits.slice(1);
  else if (digits.length === 9) local = digits;
  else return null;
  return /^[235]\d{8}$/.test(local) ? `+233${local}` : null;
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const text = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const yesNo = z.preprocess(blank, z.string().trim().toLowerCase()
  .refine((v) => ["yes", "y", "true", "1", "no", "n", "false", "0"].includes(v), "use yes or no")
  .transform((v) => ["yes", "y", "true", "1"].includes(v)).optional());
const phone = (label: string) => z.string({ error: `${label} is missing` }).trim().min(1, `${label} is missing`)
  .transform((v, ctx) => ghanaPhone(v) ?? (ctx.addIssue({ code: "custom", message: `${label} "${v}" is not a Ghana mobile number` }), z.NEVER));
const optPhone = (label: string) => z.preprocess(blank, phone(label).optional());
const network = z.preprocess(blank, z.string().trim().toLowerCase().transform((v, ctx) => {
  if (v.includes("mtn")) return "MTN";
  if (v.includes("telecel") || v.includes("vodafone")) return "Telecel";
  if (v.includes("airtel") || v.includes("tigo") || v === "at") return "AirtelTigo";
  ctx.addIssue({ code: "custom", message: `MoMo network "${v}" should be MTN, Telecel or AirtelTigo` }); return z.NEVER;
}).optional());
const oneOf = <T extends string>(label: string, values: readonly T[], dflt: T) => z.preprocess(blank,
  z.string().trim().toLowerCase().refine((v): v is T => (values as readonly string[]).includes(v), `${label} should be one of: ${values.join(", ")}`).optional())
  .transform((v) => (v ?? dflt) as T);

const common = { name: z.string({ error: "name is missing" }).trim().min(2, "name is missing").max(120), phone: phone("phone"),
  email: z.preprocess(blank, z.email("email is not valid").optional()), city: z.string().optional(), momo_number: optPhone("MoMo number"), momo_network: network };

export const ClientRow = z.object({
  ...common,
  type: oneOf("type", ["individual", "vendor", "corporate"] as const, "individual"),
  business_name: text(160), marketing_opt_in: yesNo, cod_payout: oneOf("cod_payout", ["daily", "weekly"] as const, "weekly"),
  tags: z.preprocess(blank, z.string().optional()).transform((v) => (v ? v.split(/[;,|]/).map((t) => t.trim().toLowerCase()).filter(Boolean) : [])),
  notes: text(1000),
}).superRefine((r, ctx) => {
  if (r.type !== "individual" && !r.business_name) ctx.addIssue({ code: "custom", message: `business_name is needed for a ${r.type}`, path: ["business_name"] });
  if (r.momo_number && !r.momo_network) ctx.addIssue({ code: "custom", message: "momo_network is needed with a MoMo number", path: ["momo_network"] });
});
export type ClientRow = z.infer<typeof ClientRow>;

export const RiderRow = z.object({
  ...common,
  rider_type: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/^independent$/, "commission").replace(/^qcs$/, "fleet") : v),
    oneOf("rider_type", ["fleet", "commission"] as const, "fleet")),
  status: oneOf("status", ["active", "pending"] as const, "active"),
  vehicle_type: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/^(motor ?bike|motorcycle|okada)$/, "bike") : v),
    oneOf("vehicle_type", ["bike", "ebike", "tricycle", "car", "van"] as const, "bike")),
  plate: text(20), make_model: text(80),
  commission_pct: z.preprocess(blank, z.coerce.number({ error: "commission_pct must be a number" }).min(0).max(100).optional()),
}).superRefine((r, ctx) => {
  if (r.momo_number && !r.momo_network) ctx.addIssue({ code: "custom", message: "momo_network is needed with a MoMo number", path: ["momo_network"] });
});
export type RiderRow = z.infer<typeof RiderRow>;

export interface Problem { line: number; values: string[]; error: string }
export interface Checked<T> { headers: string[]; good: { line: number; values: string[]; row: T }[]; problems: Problem[]; skipped: Problem[]; unknownColumns: string[] }

/**
 * Checks every row of a sheet. `line` numbers match the spreadsheet (header = line 1).
 * Rows whose phone already has a QCS account are `skipped` (safe to run the import again); bad rows are `problems`.
 */
export function checkRows(kind: Kind, table: string[][], cities: City[], existingPhones: Set<string>): Checked<ClientRow | RiderRow> {
  const [head = [], ...body] = table;
  const cols = head.map(columnFor);
  const unknownColumns = head.filter((_, i) => !cols[i]);
  const missing = ["name", "phone"].filter((c) => !cols.includes(c));
  if (missing.length) throw new Error(`The sheet needs these columns: ${missing.join(", ")} (found: ${head.join(", ")})`);
  const cityCode = (v: string | undefined) => {
    if (!v?.trim()) return undefined;
    const s = v.trim().toLowerCase();
    return cities.find((c) => c.code.toLowerCase() === s || c.name.toLowerCase() === s)?.code ?? null;
  };
  const schema = kind === "clients" ? ClientRow : RiderRow;
  const out: Checked<ClientRow | RiderRow> = { headers: head, good: [], problems: [], skipped: [], unknownColumns };
  const seen = new Map<string, number>();
  body.forEach((values, i) => {
    const line = i + 2;
    const raw: Record<string, string> = {};
    cols.forEach((c, j) => { if (c && raw[c] === undefined) raw[c] = values[j] ?? ""; });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) { out.problems.push({ line, values, error: parsed.error.issues.map((x) => x.message).join("; ") }); return; }
    const row = parsed.data;
    const code = cityCode(raw.city);
    if (code === null) { out.problems.push({ line, values, error: `city "${raw.city}" is not a QCS city (${cities.map((c) => c.name).join(", ")})` }); return; }
    if (kind === "riders" && !code) { out.problems.push({ line, values, error: "city is needed for a rider" }); return; }
    row.city = code;
    if (existingPhones.has(row.phone)) { out.skipped.push({ line, values, error: `${row.phone} already has a QCS account` }); return; }
    if (seen.has(row.phone)) { out.problems.push({ line, values, error: `${row.phone} is also on line ${seen.get(row.phone)} of this sheet` }); return; }
    seen.set(row.phone, line);
    out.good.push({ line, values, row });
  });
  return out;
}
