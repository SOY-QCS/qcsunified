import { describe, expect, it } from "vitest";
import { period, shortDay } from "./period";

describe("report periods", () => {
  it("exact dates win when valid", () => {
    expect(period({ from: "2026-10-01", to: "2026-10-31", p: "7d" })).toMatchObject({ from: "2026-10-01", to: "2026-10-31", preset: null });
  });
  it("bad or reversed dates fall back to the last 7 days", () => {
    const p = period({ from: "2026-10-31", to: "2026-10-01" });
    expect(p.preset).toBe("7d");
    expect((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000).toBe(6);
  });
  it("last month covers the whole previous month", () => {
    const p = period({ p: "lastmonth" });
    expect(p.from.endsWith("-01")).toBe(true);
    expect(new Date(`${p.to}T00:00:00Z`).getUTCDate()).toBeGreaterThanOrEqual(28);
  });
});

describe("day labels", () => {
  it("accept a plain date or a full timestamp", () => {
    expect(shortDay("2026-10-07")).toBe("7 Oct");
    expect(shortDay("2026-10-07T00:00:00+00:00")).toBe("7 Oct");
  });
});
