import { describe, expect, it } from "vitest";
import { canGrant, navFor, roleAssignmentProblem, isOps, normalizeGhanaPhone } from "./index";

const ACC = "acc-id", KSI = "ksi-id";

describe("who can grant roles", () => {
  it("super admin can grant anything", () => {
    expect(canGrant([{ role: "super_admin", city_id: null }], "finance", null)).toBe(true);
  });
  it("city admin grants field roles in their own city only", () => {
    const me = [{ role: "city_admin" as const, city_id: ACC }];
    expect(canGrant(me, "dispatcher", ACC)).toBe(true);
    expect(canGrant(me, "dispatcher", KSI)).toBe(false);
    expect(canGrant(me, "super_admin", ACC)).toBe(false);
    expect(canGrant(me, "city_admin", ACC)).toBe(false);
    expect(canGrant(me, "finance", null)).toBe(false);
  });
  it("dispatcher cannot grant", () => {
    expect(canGrant([{ role: "dispatcher", city_id: ACC }], "support", ACC)).toBe(false);
  });
});

describe("role assignment shape", () => {
  it("city roles need a city", () => expect(roleAssignmentProblem("dispatcher", null, null)).toMatch(/city/));
  it("global roles must not have a city", () => expect(roleAssignmentProblem("finance", ACC, null)).toMatch(/all cities/));
  it("only hub roles link to a hub", () => expect(roleAssignmentProblem("support", ACC, "hub")).toMatch(/hub/));
  it("valid assignment", () => expect(roleAssignmentProblem("hub_handler", ACC, "hub")).toBeNull());
  it("customers can't be assigned from the dashboard", () => expect(roleAssignmentProblem("customer", null, null)).not.toBeNull());
});

describe("ops navigation", () => {
  const labels = (r: Parameters<typeof navFor>[0]) => navFor(r).map((n) => n.label);
  it("finance sees finance, not staff management", () => {
    const l = labels([{ role: "finance", city_id: null }]);
    expect(l).toContain("Finance");
    expect(l).not.toContain("Staff & roles");
  });
  it("city admin sees staff and rider applications", () => {
    const l = labels([{ role: "city_admin", city_id: ACC }]);
    expect(l).toEqual(expect.arrayContaining(["Staff & roles", "Rider applications", "Dispatch"]));
  });
  it("support does not see pricing", () => expect(labels([{ role: "support", city_id: ACC }])).not.toContain("Pricing"));
  it("customers are not ops", () => expect(isOps([{ role: "customer", city_id: null }])).toBe(false));
});

describe("phone numbers", () => {
  it("normalises local formats", () => {
    expect(normalizeGhanaPhone("024 123 4567")).toBe("+233241234567");
    expect(normalizeGhanaPhone("+233 20 000 0001")).toBe("+233200000001");
    expect(normalizeGhanaPhone("0123")).toBeNull();
  });
});
