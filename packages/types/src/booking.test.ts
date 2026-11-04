import { describe, expect, it } from "vitest";
import { BookingRequest, bookingProblems, checkBulkRows, problemsCsv, splitIntoTrips, bulkTemplateCsv, normaliseHeader } from "./index";

const place = { formatted_address: "Oxford St, Osu", lat: 5.556, lng: -0.178, contact_name: "Ama", contact_phone: "0241234567" };
const drop = { ...place, contact_name: "Kofi", contact_phone: "0201234567", weight_g: 1500 };
const V = "11111111-1111-4111-8111-111111111111";

describe("BookingRequest", () => {
  it("accepts a simple express booking and tidies phone numbers", () => {
    const r = BookingRequest.parse({ service: "express", pickup: place, dropoffs: [drop], payer: "sender", payment_method: "momo" });
    expect(r.pickup.contact_phone).toBe("+233241234567");
    expect(r.dropoffs[0]!.size).toBe("small");
  });
  const bad = (o: object) => {
    const r = BookingRequest.safeParse({ service: "express", pickup: place, dropoffs: [drop], payer: "sender", payment_method: "momo", ...o });
    return r.success ? [] : bookingProblems(r.error);
  };
  it("express over 15 kg", () => expect(bad({ dropoffs: [{ ...drop, weight_g: 16000 }] }).join()).toMatch(/15 kg/));
  it("express with two drop-offs", () => expect(bad({ dropoffs: [drop, drop] }).join()).toMatch(/one drop-off/));
  it("e-commerce needs a business account", () => expect(bad({ service: "ecommerce" }).join()).toMatch(/business/));
  it("COD only for businesses", () => expect(bad({ dropoffs: [{ ...drop, cod_amount: 5000 }] }).join()).toMatch(/Cash on Delivery/));
  it("payment method must match payer", () => expect(bad({ payer: "recipient", payment_method: "momo" }).join()).toMatch(/payment method/));
  it("wallet/invoice only for businesses", () => expect(bad({ payer: "vendor_wallet", payment_method: "wallet" }).join()).toMatch(/business/));
  it("pin outside Ghana", () => expect(bad({ pickup: { ...place, lat: 51.5 } }).join()).toMatch(/Ghana/));
  it("insurance flag defaults to off", () => {
    expect(BookingRequest.parse({ service: "express", pickup: place, dropoffs: [drop], payer: "sender", payment_method: "momo" }).dropoffs[0]!.insured).toBe(false);
  });
  it("bad phone explained with the drop-off number", () => expect(bad({ dropoffs: [{ ...drop, contact_phone: "123" }] })[0]).toMatch(/^Drop-off 1: Enter a Ghana phone/));
  it("bulk trip of 25 for a vendor", () => {
    const r = BookingRequest.safeParse({ service: "ecommerce", vendor_id: V, pickup: place, dropoffs: Array(25).fill(drop), payer: "vendor_wallet", payment_method: "wallet" });
    expect(r.success).toBe(true);
  });
  it("26 is too many", () => expect(bad({ service: "ecommerce", vendor_id: V, dropoffs: Array(26).fill(drop), payer: "vendor_wallet", payment_method: "wallet" }).join()).toMatch(/at most 25/));
});

describe("bulk upload", () => {
  const ok = { "Recipient name": "Esi", "Recipient phone": "0241234567", Address: "East Legon", "Weight (kg)": "1.5", "Cash to collect (GHS)": "350", latitude: "5.6355", longitude: "-0.161", order_ref: "WC-1" };
  it("reads friendly headers and converts cedis and kg", () => {
    const r = checkBulkRows([ok]);
    expect(r.problems).toEqual([]);
    expect(r.rows[0]!.dropoff).toMatchObject({ weight_g: 1500, cod_amount: 35000, contact_phone: "+233241234567", lat: 5.6355, insured: false });
    expect(checkBulkRows([{ ...ok, "Insure (yes/no)": "Yes" }]).rows[0]!.dropoff.insured).toBe(true);
  });
  it("reports each problem with the Excel row number", () => {
    const r = checkBulkRows([ok, { ...ok, "Recipient phone": "12", order_ref: "WC-2" }, { ...ok, "Weight (kg)": "heavy", order_ref: "WC-3" }]);
    expect(r.problems.map((p) => p.row)).toEqual([3, 4]);
    expect(r.problems[0]!.message).toMatch(/Ghana phone/);
    expect(r.problems[1]!.message).toMatch(/Weight/);
  });
  it("rows without coordinates are flagged for lookup, not rejected", () => {
    const r = checkBulkRows([{ ...ok, latitude: "", longitude: "", ghana_post_gps: "GA-123-4567" }]);
    expect(r.problems).toEqual([]);
    expect(r.needsLocation).toEqual([2]);
  });
  it("duplicate order numbers are caught", () => {
    expect(checkBulkRows([ok, ok]).problems[0]!.message).toMatch(/also on row 2/);
  });
  it("blank lines are skipped, missing required fields reported", () => {
    const r = checkBulkRows([{ "Recipient name": "", Address: "" }, { "Recipient name": "Yaw" }]);
    expect(r.problems.some((p) => p.row === 3 && /phone is missing/.test(p.message))).toBe(true);
    expect(r.problems.some((p) => p.row === 2)).toBe(false);
  });
  it("header aliases", () => {
    expect(normaliseHeader("Phone")).toBe("recipient_phone");
    expect(normaliseHeader("Digital Address")).toBe("ghana_post_gps");
    expect(normaliseHeader("COD")).toBe("cod_ghs");
  });
  it("error report and template", () => {
    expect(problemsCsv([{ row: 3, column: "x", message: 'Bad, "quoted"' }])).toBe('row,column,problem\n3,x,"Bad, ""quoted"""\n');
    expect(bulkTemplateCsv().split("\n")[0]).toContain("recipient_phone");
  });
  it("splits 60 drop-offs into trips of 25, 25, 10", () => {
    expect(splitIntoTrips(Array(60).fill(0)).map((t) => t.length)).toEqual([25, 25, 10]);
  });
});
