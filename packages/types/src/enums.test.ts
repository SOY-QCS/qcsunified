import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_ROLES, ORDER_STATUSES, SERVICE_TYPES, TRIP_STATUSES, PAYER_TYPES, GhanaPostGps } from "./index";

// The TypeScript lists must match the Postgres enums exactly.
const sql = readFileSync(
  fileURLToPath(new URL("../../../supabase/migrations/20261104000100_extensions_and_types.sql", import.meta.url)),
  "utf8",
);
function dbEnum(name: string): string[] {
  const m = sql.match(new RegExp(`create type public\\.${name} as enum \\(([\\s\\S]*?)\\);`));
  if (!m) throw new Error(`enum ${name} not found`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe("types mirror the database", () => {
  it("app_role", () => expect([...APP_ROLES]).toEqual(dbEnum("app_role")));
  it("order_status", () => expect([...ORDER_STATUSES]).toEqual(dbEnum("order_status")));
  it("service_type", () => expect([...SERVICE_TYPES]).toEqual(dbEnum("service_type")));
  it("trip_status", () => expect([...TRIP_STATUSES]).toEqual(dbEnum("trip_status")));
  it("payer_type", () => expect([...PAYER_TYPES]).toEqual(dbEnum("payer_type")));
});

describe("Ghana Post GPS", () => {
  it("accepts GA-123-4567 and lower case", () => {
    expect(GhanaPostGps.parse("ga-123-4567")).toBe("GA-123-4567");
  });
  it("rejects nonsense", () => expect(() => GhanaPostGps.parse("hello")).toThrow());
});
