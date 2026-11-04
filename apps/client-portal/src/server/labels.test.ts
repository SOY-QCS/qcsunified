import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { labelsPdf, LABEL_SIZES, type LabelOrder } from "./labels";

const order: LabelOrder = {
  tracking_number: "QCS00100001", service_type: "ecommerce", recipient_name: "Esi Mensah", recipient_phone: "+233241234567",
  dropoff_address_text: "House 12, Lagos Avenue, East Legon — behind the big mango tree near the A&C Mall car park entrance",
  dropoff_landmark: "A&C Mall", dropoff_ghana_post_gps: "GA-123-4567", zone_name: "East Legon / Airport", city_name: "Accra",
  sender_name: "Kente Hub", sender_phone: "+233200000202", weight_g: 1500, package_size: "small", is_fragile: true,
  cod_amount: 35000, payer: "vendor_wallet", created_at: "2026-11-04T10:00:00Z", delivery_instructions: "Call on arrival ✓",
  external_ref: "WC-1043", stop_no: 3, stop_count: 12,
};

describe("labels", () => {
  it("one page per order at the exact A6 size", async () => {
    const pdf = await PDFDocument.load(await labelsPdf([order, { ...order, tracking_number: "QCS00100002", cod_amount: 0 }], "a6"));
    expect(pdf.getPageCount()).toBe(2);
    const { width, height } = pdf.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual(LABEL_SIZES.a6.map(Math.round));
  });
  it("4x6 thermal size is 288 × 432 points", async () => {
    const pdf = await PDFDocument.load(await labelsPdf([order], "4x6"));
    expect(pdf.getPage(0).getSize()).toEqual({ width: 288, height: 432 });
  });
  it("odd characters (emoji, ₵, long dashes) don't break printing", async () => {
    await expect(labelsPdf([{ ...order, recipient_name: "Ama 😀 ₵", dropoff_address_text: "“Quoted” – address" }], "a6")).resolves.toBeInstanceOf(Uint8Array);
  });
});
