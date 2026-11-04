import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { statementCsv, statementPdf, statementTotals, type StatementRow } from "./statement";

const rows: StatementRow[] = [
  { at: null, kind: "opening", reference: null, description: "Opening balance", debit: null, credit: null, balance: 10000, cod: null },
  { at: "2026-11-04T10:00:00Z", kind: "delivery_fee", reference: "ACC-202611041000-ACC", description: "Delivery, \"Osu\"", debit: 3000, credit: null, balance: 7000, cod: null },
  { at: "2026-11-04T11:00:00Z", kind: "cod_collected", reference: "ACC-202611041000-ACC", description: "Cash collected", debit: null, credit: null, balance: 7000, cod: 35000 },
  { at: "2026-11-04T12:00:00Z", kind: "refund", reference: null, description: "Refund", debit: null, credit: 1000, balance: 8000, cod: null },
  { at: "2026-11-05T00:00:00Z", kind: "closing", reference: null, description: "Closing balance", debit: null, credit: null, balance: 8000, cod: null },
];

describe("statements", () => {
  it("CSV has friendly names, cedis and escaped text", () => {
    const csv = statementCsv(rows).split("\n");
    expect(csv[0]).toBe("Date,Type,Tracking no.,Description,Debit (GHS),Credit (GHS),Balance (GHS),COD (GHS)");
    expect(csv[2]).toContain('Delivery fee,ACC-202611041000-ACC,"Delivery, ""Osu""",30.00,,70.00,');
  });
  it("totals", () => expect(statementTotals(rows)).toMatchObject({ opening: 10000, closing: 8000, charged: 3000, credited: 1000, codCollected: 35000 }));
  it("PDF on A4, many pages when long", async () => {
    const many = [rows[0]!, ...Array.from({ length: 150 }, () => rows[1]!), rows[4]!];
    const pdf = await PDFDocument.load(await statementPdf(many, { businessName: "Kente Hub", from: "2026-11-01", to: "2026-11-30", generatedAt: new Date() }));
    expect(pdf.getPageCount()).toBeGreaterThan(2);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
  });
});
