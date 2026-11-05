import { checkRows, type City, type ClientRow, type Kind, type RiderRow } from "./rows.ts";
import { toCsv } from "./csv.ts";

/** Everything the import needs from Supabase (passed in, so tests can use fakes). */
export interface Deps {
  cities(): Promise<City[]>;
  existingPhones(phones: string[]): Promise<Set<string>>;
  /** creates the phone login; returns the new user id */
  createLogin(phone: string, name: string): Promise<string>;
  /** fills in profile / vendor / rider details (database function import_client / import_rider) */
  finish(kind: Kind, userId: string, details: Record<string, unknown>): Promise<void>;
  /** undo a login when finishing failed, so a re-run starts clean */
  removeLogin(userId: string): Promise<void>;
}

export interface Report {
  kind: Kind; dryRun: boolean; total: number; ready: number; created: number; skipped: number; problems: number; failed: number;
  unknownColumns: string[];
  /** the original sheet plus two columns: result (created / would create / skipped / problem / failed) and detail */
  csv: string;
}

export async function importPeople(opts: { kind: Kind; table: string[][]; dryRun: boolean; source: string }, deps: Deps, log: (s: string) => void = () => {}): Promise<Report> {
  const { kind, table, dryRun, source } = opts;
  const cities = await deps.cities();
  const existing = await deps.existingPhones(candidatePhones(table));
  const checked = checkRows(kind, table, cities, existing);
  const results = new Map<number, [string, string]>();
  for (const p of checked.problems) results.set(p.line, ["problem", p.error]);
  for (const s of checked.skipped) results.set(s.line, ["skipped", s.error]);

  let created = 0, failed = 0;
  if (dryRun) {
    for (const g of checked.good) results.set(g.line, ["would create", g.row.phone]);
  } else {
    for (const g of checked.good) {
      const row = g.row as ClientRow & RiderRow;
      let id: string | null = null;
      try {
        id = await deps.createLogin(row.phone, row.name);
        await deps.finish(kind, id, details(kind, row, source));
        created++; results.set(g.line, ["created", id]);
        if (created % 50 === 0) log(`  … ${created} created`);
      } catch (e) {
        if (id) await deps.removeLogin(id).catch(() => undefined);
        failed++; results.set(g.line, ["failed", (e as Error).message]);
      }
    }
  }
  const csv = toCsv([[...checked.headers, "result", "detail"], ...table.slice(1).map((values, i) => [...values, ...(results.get(i + 2) ?? ["", ""])])]);
  return { kind, dryRun, total: table.length - 1, ready: checked.good.length, created, skipped: checked.skipped.length, problems: checked.problems.length, failed,
           unknownColumns: checked.unknownColumns, csv };
}

/** What import_client / import_rider receive. */
export function details(kind: Kind, r: ClientRow & RiderRow, source: string): Record<string, unknown> {
  const base = { name: r.name, email: r.email ?? null, city: r.city ?? null, momo_number: r.momo_number ?? null, momo_network: r.momo_network ?? null, source };
  return kind === "clients"
    ? { ...base, type: r.type, business_name: r.business_name ?? null, marketing_opt_in: r.marketing_opt_in ?? false, notes: r.notes ?? null, tags: r.tags, cod_payout: r.cod_payout }
    : { ...base, rider_type: r.rider_type, status: r.status, vehicle_type: r.vehicle_type, plate: r.plate ?? null, make_model: r.make_model ?? null, commission_pct: r.commission_pct ?? null };
}

/** Every value in the sheet that could be a phone number, in +233 form (to ask the database which already exist, in one go). */
function candidatePhones(table: string[][]): string[] {
  const out = new Set<string>();
  for (const row of table.slice(1)) for (const v of row) {
    const d = v.replace(/[^\d]/g, "");
    const local = d.startsWith("233") && d.length === 12 ? d.slice(3) : d.startsWith("0") && d.length === 10 ? d.slice(1) : d.length === 9 ? d : null;
    if (local && /^[235]\d{8}$/.test(local)) out.add(`+233${local}`);
  }
  return [...out];
}

export function summary(r: Report): string {
  const lines = [
    `${r.dryRun ? "DRY RUN (nothing saved)" : "IMPORT"} — ${r.kind}: ${r.total} rows`,
    r.dryRun ? `  ready to create:   ${r.ready}` : `  created:           ${r.created}`,
    `  already on QCS:    ${r.skipped} (skipped, safe to re-run)`,
    `  need fixing:       ${r.problems}`,
  ];
  if (!r.dryRun) lines.push(`  failed:            ${r.failed}`);
  if (r.unknownColumns.length) lines.push(`  columns ignored:   ${r.unknownColumns.join(", ")}`);
  return lines.join("\n");
}
