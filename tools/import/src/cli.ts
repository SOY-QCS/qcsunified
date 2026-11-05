/**
 * Import existing clients or riders from a CSV file or a Google Sheet.
 *
 *   pnpm import:people clients --file old-clients.csv --dry-run        ← check first, nothing is saved
 *   pnpm import:people clients --file old-clients.csv                  ← import for real
 *   pnpm import:people riders  --sheet "https://docs.google.com/spreadsheets/d/…/edit#gid=0" --dry-run
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the server key: keep it private).
 * Writes a report CSV next to the input (or in the current folder for sheets): the original rows + result + detail.
 * Safe to run again: anyone whose phone number already has a QCS account is skipped.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseCsv, sheetCsvUrl } from "./csv.ts";
import { importPeople, summary, type Deps } from "./run.ts";
import type { Kind } from "./rows.ts";

const HELP = `Usage: pnpm import:people <clients|riders> (--file <path.csv> | --sheet <google sheets link>) [--dry-run] [--source "label"]
Templates with the expected columns: tools/import/templates/`;

async function main() {
  const args = process.argv.slice(2);
  const kind = args[0] as Kind;
  const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
  if (kind !== "clients" && kind !== "riders") throw new Error(HELP);
  // pnpm runs this from tools/import: paths are relative to where YOU ran the command
  const here = process.env.INIT_CWD ?? process.cwd();
  const file = opt("file") && resolve(here, opt("file")!), sheet = opt("sheet"), dryRun = args.includes("--dry-run");
  if (!file === !sheet) throw new Error(HELP);

  const text = file ? await readFile(file, "utf8") : await fetchSheet(sheet!);
  const table = parseCsv(text);
  const source = opt("source") ?? (file ? basename(file) : "Google Sheet");

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (Supabase → Project settings → API).");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const deps: Deps = {
    cities: async () => {
      const { data, error } = await db.from("cities").select("code, name");
      if (error) throw new Error(`Could not read cities: ${error.message}`);
      return data ?? [];
    },
    existingPhones: async (phones) => {
      const found = new Set<string>();
      for (let i = 0; i < phones.length; i += 150) {
        const chunk = phones.slice(i, i + 150);
        // Supabase Auth may store numbers with or without the "+"
        const { data, error } = await db.from("profiles").select("phone").in("phone", [...chunk, ...chunk.map((p) => p.slice(1))]);
        if (error) throw new Error(`Could not check existing accounts: ${error.message}`);
        for (const r of data ?? []) if (r.phone) found.add(r.phone.startsWith("+") ? r.phone : `+${r.phone}`);
      }
      return found;
    },
    createLogin: async (phone, name) => {
      const { data, error } = await db.auth.admin.createUser({ phone, phone_confirm: true, user_metadata: { full_name: name } });
      if (error || !data.user) throw new Error(`login not created: ${error?.message ?? "unknown error"}`);
      return data.user.id;
    },
    finish: async (k, id, details) => {
      const { error } = await db.rpc(k === "clients" ? "import_client" : "import_rider", { p_user: id, p: details });
      if (error) throw new Error(error.message);
    },
    removeLogin: async (id) => { await db.auth.admin.deleteUser(id); },
  };

  console.log(`${dryRun ? "Checking" : "Importing"} ${table.length - 1} ${kind} from ${source} …`);
  const report = await importPeople({ kind, table, dryRun, source }, deps, console.log);
  const out = file ? join(dirname(file), `${basename(file, ".csv")}.${dryRun ? "dry-run" : "import"}-report.csv`)
                   : join(here, `${kind}-${dryRun ? "dry-run" : "import"}-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.csv`);
  await writeFile(out, report.csv);
  console.log(summary(report));
  console.log(`Report (open in Excel / Google Sheets, filter the "result" column): ${out}`);
  if (dryRun && report.ready) console.log("Looks right? Run the same command again without --dry-run.");
}

async function fetchSheet(link: string): Promise<string> {
  const r = await fetch(sheetCsvUrl(link), { redirect: "follow" });
  const body = await r.text();
  if (!r.ok || body.trimStart().startsWith("<")) {
    throw new Error("Could not download the sheet. Share it as \"Anyone with the link can view\", or use File → Download → CSV and --file.");
  }
  return body;
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
