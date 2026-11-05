import { describe, expect, it } from "vitest";
import { helpBlocks, helpSections, problemsFor } from "./support";

describe("help articles", () => {
  it("turns plain text into paragraphs and bullet lists", () => {
    expect(helpBlocks("Open the app.\nTap Book.\n\n- Express\n- E-commerce\n\nDone.")).toEqual([
      { kind: "p", text: "Open the app. Tap Book." }, { kind: "ul", items: ["Express", "E-commerce"] }, { kind: "p", text: "Done." },
    ]);
  });
  it("groups by section and hides other audiences", () => {
    const a = (slug: string, audience: "all" | "rider" | "vendor", category: string, sort: number) => ({ id: slug, slug, audience, category, title: slug, body: "", sort });
    const s = helpSections([a("b", "all", "Booking", 2), a("r", "rider", "Earnings", 1), a("v", "vendor", "Money", 3), a("a", "all", "Booking", 1)], "public");
    expect(s.map((x) => [x.category, x.articles.map((y) => y.slug)])).toEqual([["Booking", ["a", "b"]], ["Money", ["v"]]]);
  });
});

describe("report a problem", () => {
  it("offers parcel problems only when there is a delivery, and COD only to vendors and riders", () => {
    expect(problemsFor("client", false).map((p) => p.value)).not.toContain("damaged");
    expect(problemsFor("client", true).map((p) => p.value)).toContain("damaged");
    expect(problemsFor("client", true).map((p) => p.value)).not.toContain("cod_money");
    expect(problemsFor("vendor", true).map((p) => p.value)).toContain("cod_money");
    expect(problemsFor("rider", true).map((p) => p.value)).toContain("payout");
  });
});
