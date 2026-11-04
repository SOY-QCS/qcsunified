/** Vendor statements as CSV (for Excel) and PDF (for printing/sending). Amounts in pesewas in, cedis out. */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface StatementRow { at: string | null; kind: string; reference: string | null; description: string; debit: number | null; credit: number | null; balance: number | null; cod: number | null }
export interface StatementInfo { businessName: string; from: string; to: string; generatedAt: Date }

const KIND: Record<string, string> = {
  opening: "Opening balance", closing: "Closing balance", delivery_fee: "Delivery fee", return_fee: "Return fee (50%)",
  insurance_premium: "Insurance", topup: "Wallet top-up", refund: "Refund", cancellation_refund: "Cancellation refund",
  return_refund: "Return refund", cod_collected: "COD collected", cod_remitted: "COD remitted", cod_payout: "COD paid to you",
  withdrawal_hold: "Withdrawal", withdrawal_returned: "Withdrawal returned", payout: "Payout",
};
const label = (k: string) => KIND[k] ?? k.replaceAll("_", " ");
const ghs = (p: number | null) => (p == null ? "" : (p / 100).toFixed(2));
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

export function statementCsv(rows: StatementRow[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ["Date", "Type", "Tracking no.", "Description", "Debit (GHS)", "Credit (GHS)", "Balance (GHS)", "COD (GHS)"];
  return [head.join(","), ...rows.map((r) => [day(r.at), label(r.kind), r.reference ?? "", r.description, ghs(r.debit), ghs(r.credit), ghs(r.balance), ghs(r.cod)].map((x) => esc(String(x))).join(","))].join("\n") + "\n";
}

export function statementTotals(rows: StatementRow[]) {
  const sum = (f: (r: StatementRow) => number | null, kinds?: string[]) => rows.filter((r) => !kinds || kinds.includes(r.kind)).reduce((t, r) => t + (f(r) ?? 0), 0);
  return {
    opening: rows.find((r) => r.kind === "opening")?.balance ?? 0,
    closing: rows.find((r) => r.kind === "closing")?.balance ?? 0,
    charged: sum((r) => r.debit),
    credited: sum((r) => r.credit),
    codCollected: sum((r) => r.cod, ["cod_collected"]),
    codRemitted: sum((r) => r.cod, ["cod_remitted"]),
  };
}

export async function statementPdf(rows: StatementRow[], info: StatementInfo): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`QCS statement ${info.businessName} ${info.from} to ${info.to}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safe = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
  const W = 595, H = 842, M = 36;   // A4 portrait
  const cols = [M, M + 92, M + 180, M + 262, M + 383, M + 433, M + 483];   // date, type, tracking, description, debit, credit, balance
  const t = statementTotals(rows);
  let page = pdf.addPage([W, H]), y = H - M;
  const text = (s: string, x: number, size = 8, f = font, right = false, color = rgb(0, 0, 0)) => {
    const v = safe(s); page.drawText(v, { x: right ? x - f.widthOfTextAtSize(v, size) : x, y, size, font: f, color });
  };
  const header = () => {
    page.drawRectangle({ x: 0, y: H - 60, width: W, height: 60, color: rgb(0xdf / 255, 0x65 / 255, 0x18 / 255) });
    y = H - 30; text("QCS Ghana — Wallet statement", M, 16, bold, false, rgb(1, 1, 1));
    y = H - 48; text(`${info.businessName} · ${info.from} to ${info.to}`, M, 10, font, false, rgb(1, 1, 1));
    y = H - 80;
    ["Date", "Type", "Tracking no.", "Description"].forEach((h, i) => text(h, cols[i]!, 8, bold));
    text("Debit", cols[4]! + 40, 8, bold, true); text("Credit", cols[5]! + 40, 8, bold, true); text("Balance", W - M, 8, bold, true);
    y -= 12;
  };
  header();
  for (const r of rows) {
    if (y < M + 70) { page = pdf.addPage([W, H]); header(); }
    const isTotal = r.kind === "opening" || r.kind === "closing";
    text(day(r.at).slice(0, 17), cols[0]!); text(label(r.kind).slice(0, 18), cols[1]!, 8, isTotal ? bold : font);
    text((r.reference ?? "").slice(0, 21), cols[2]!, 7); text(r.description.slice(0, 26), cols[3]!, 7);
    if (r.debit) text(ghs(r.debit), cols[4]! + 40, 8, font, true);
    if (r.credit) text(ghs(r.credit), cols[5]! + 40, 8, font, true);
    if (r.cod) text(`COD ${ghs(r.cod)}`, cols[5]! + 40, 7, font, true, rgb(0.4, 0.4, 0.4));
    if (r.balance != null && r.cod == null) text(ghs(r.balance), W - M, 8, isTotal ? bold : font, true);
    y -= 12;
  }
  y -= 10;
  const sumLine = (k: string, v: number) => { text(k, M, 9, bold); text(`GHS ${ghs(v)}`, M + 200, 9, font, true); y -= 13; };
  sumLine("Opening balance", t.opening); sumLine("Charged", t.charged); sumLine("Credited", t.credited); sumLine("Closing balance", t.closing);
  sumLine("COD collected (paid out separately)", t.codCollected); sumLine("COD remitted to QCS", t.codRemitted);
  y -= 6; text(`Generated ${info.generatedAt.toLocaleString("en-GB", { timeZone: "Africa/Accra" })}. Negative balance = fees you owe QCS.`, M, 7, font, false, rgb(0.4, 0.4, 0.4));
  return pdf.save();
}
