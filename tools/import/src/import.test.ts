import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv, sheetCsvUrl, toCsv } from "./csv.ts";
import { checkRows, columnFor, ghanaPhone, type Kind } from "./rows.ts";
import { importPeople, summary, type Deps } from "./run.ts";

const CITIES = [{ code: "ACC", name: "Accra" }, { code: "KSI", name: "Kumasi" }, { code: "TKD", name: "Takoradi" }, { code: "TML", name: "Tamale" }];
const template = (k: Kind) => parseCsv(readFileSync(new URL(`../templates/${k}.csv`, import.meta.url), "utf8"));

describe("CSV", () => {
  it("reads Excel/Sheets exports: BOM, quotes, commas and new lines inside quotes, Windows line ends, blank lines", () => {
    const t = parseCsv('﻿name,notes\r\n"Mensah, Kofi","said ""hi""\nthen left"\r\n\r\nAma,\r\n');
    expect(t).toEqual([["name", "notes"], ["Mensah, Kofi", 'said "hi"\nthen left'], ["Ama", ""]]);
  });
  it("writes what it reads", () => {
    const rows = [["a", "b,c", 'd"e'], ["1", "", "x\ny"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it("turns a Google Sheets link into its CSV download", () => {
    expect(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC-xyz_9/edit#gid=12345"))
      .toBe("https://docs.google.com/spreadsheets/d/1AbC-xyz_9/export?format=csv&gid=12345");
    expect(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing")).toContain("gid=0");
    expect(() => sheetCsvUrl("https://example.com/x.csv")).toThrow(/Google Sheets/);
  });
});

describe("rows", () => {
  it("understands the column names people use", () => {
    expect(["Full Name", "Phone Number", "E-mail", "Shop name", "MoMo No.", "Plate number", "Commission %"].map(columnFor))
      .toEqual(["name", "phone", "email", "business_name", null, "plate", "commission_pct"]);
    expect(columnFor("momo number")).toBe("momo_number");
  });
  it("normalises Ghana numbers like the apps do", () => {
    expect(["0241234567", "+233 24 123 4567", "233241234567", "241234567", "024-123-4567"].map(ghanaPhone)).toEqual(Array(5).fill("+233241234567"));
    expect(ghanaPhone("12345")).toBeNull();
    expect(ghanaPhone("0841234567")).toBeNull();
  });
  it("the templates are valid as they are", () => {
    for (const k of ["clients", "riders"] as const) {
      const c = checkRows(k, template(k), CITIES, new Set());
      expect(c.problems).toEqual([]);
      expect(c.good).toHaveLength(3);
    }
  });
  it("explains every problem in plain words, with the spreadsheet line number", () => {
    const t = [["Name", "Phone", "City", "Type", "Business name", "MoMo number", "Network", "Marketing"],
      ["Ama", "0241234567", "Accra", "", "", "", "", "yes"],                 // 2 ok
      ["Kofi", "12345", "Accra", "", "", "", "", ""],                         // 3 bad phone
      ["Esi", "0551234567", "Cape Coast", "", "", "", "", ""],                // 4 unknown city
      ["Yaw", "0201234567", "accra", "vendor", "", "", "", ""],               // 5 vendor without business name
      ["Abena", "0271234567", "ACC", "", "", "0271234567", "", ""],          // 6 MoMo without network
      ["Kojo", "0241234567", "Kumasi", "", "", "", "", ""],                   // 7 same phone as line 2
      ["Akua", "0501234567", "Tamale", "", "", "0501234567", "vodafone", "maybe"], // 8 bad yes/no
      ["Efua", "0261234567", "", "Corporate", "Gold Ltd", "0261234567", "airtel tigo", "no"]]; // 9 ok, no city is fine for clients
    const c = checkRows("clients", t, CITIES, new Set(["+233201234567"]));
    expect(c.good.map((g) => g.line)).toEqual([2, 9]);
    expect(Object.fromEntries(c.problems.map((p) => [p.line, p.error]))).toEqual({
      3: 'phone "12345" is not a Ghana mobile number',
      4: 'city "Cape Coast" is not a QCS city (Accra, Kumasi, Takoradi, Tamale)',
      5: "business_name is needed for a vendor",
      6: "momo_network is needed with a MoMo number",
      7: "+233241234567 is also on line 2 of this sheet",
      8: "use yes or no",
    });
    expect(c.good[1]!.row).toMatchObject({ type: "corporate", momo_network: "AirtelTigo", city: undefined, marketing_opt_in: false });
  });
  it("people already on QCS are skipped, not errors (safe to re-run)", () => {
    const c = checkRows("clients", [["name", "phone"], ["Yaw", "020 123 4567"]], CITIES, new Set(["+233201234567"]));
    expect(c.skipped).toHaveLength(1);
    expect(c.problems).toHaveLength(0);
  });
  it("riders need a city; common words are understood", () => {
    const t = [["name", "phone", "city", "rider type", "vehicle", "commission"],
      ["Yaw", "0244111222", "", "", "", ""], ["Kwame", "0277333444", "Kumasi", "Independent", "Okada", "15"], ["Ebo", "0244999888", "Accra", "", "", "abc"]];
    const c = checkRows("riders", t, CITIES, new Set());
    expect(c.problems.map((p) => [p.line, p.error])).toEqual([[2, "city is needed for a rider"], [4, "commission_pct must be a number"]]);
    expect(c.good[0]!.row).toMatchObject({ rider_type: "commission", vehicle_type: "bike", commission_pct: 15, status: "active", city: "KSI" });
  });
  it("refuses a sheet without name or phone columns", () => {
    expect(() => checkRows("clients", [["Customer", "Address"]], CITIES, new Set())).toThrow(/needs these columns: name, phone/);
  });
});

describe("import", () => {
  function fakeDeps(existing: string[] = [], failFinishFor?: string) {
    const created: { id: string; phone: string; name: string }[] = [], finished: { kind: Kind; id: string; d: Record<string, unknown> }[] = [], removed: string[] = [];
    const deps: Deps = {
      cities: async () => CITIES,
      existingPhones: async (phones) => new Set(phones.filter((p) => existing.includes(p))),
      createLogin: async (phone, name) => { const id = `u${created.length + 1}`; created.push({ id, phone, name }); return id; },
      finish: async (kind, id, d) => { if (created.find((c) => c.id === id)?.phone === failFinishFor) throw new Error("Unknown city"); finished.push({ kind, id, d }); },
      removeLogin: async (id) => { removed.push(id); },
    };
    return { deps, created, finished, removed };
  }

  it("dry run checks everything and saves nothing", async () => {
    const f = fakeDeps(["+233201234567"]);
    const r = await importPeople({ kind: "clients", table: template("clients"), dryRun: true, source: "test" }, f.deps);
    expect(f.created).toHaveLength(0);
    expect([r.ready, r.skipped, r.problems]).toEqual([2, 1, 0]);
    expect(summary(r)).toContain("DRY RUN");
    const report = parseCsv(r.csv);
    expect(report[0]!.slice(-2)).toEqual(["result", "detail"]);
    expect(report.slice(1).map((l) => l.at(-2))).toEqual(["would create", "skipped", "would create"]);
  });

  it("creates logins and details; a failure undoes that login and the rest carry on", async () => {
    const f = fakeDeps([], "+233244111222");
    const r = await importPeople({ kind: "riders", table: template("riders"), dryRun: false, source: "old-riders.csv" }, f.deps);
    expect([r.created, r.failed]).toEqual([2, 1]);
    expect(f.removed).toEqual(["u1"]);                                   // Yaw's login removed again
    expect(f.finished[0]).toMatchObject({ kind: "riders", d: { name: "Kwame Ofori", city: "KSI", rider_type: "commission", commission_pct: 20, momo_network: "AirtelTigo", source: "old-riders.csv" } });
    expect(f.created.map((c) => c.phone)).toEqual(["+233244111222", "+233277333444", "+233509555666"]);
    const results = parseCsv(r.csv).slice(1).map((l) => [l.at(-2), l.at(-1)]);
    expect(results).toEqual([["failed", "Unknown city"], ["created", "u2"], ["created", "u3"]]);
  });

  it("client details carry vendor fields", async () => {
    const f = fakeDeps();
    await importPeople({ kind: "clients", table: template("clients"), dryRun: false, source: "s" }, f.deps);
    expect(f.finished[1]!.d).toMatchObject({ type: "vendor", business_name: "Kente Hub", tags: ["fashion", "instagram"], cod_payout: "weekly", marketing_opt_in: true, momo_network: "Telecel" });
  });
});
