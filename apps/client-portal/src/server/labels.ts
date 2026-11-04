/**
 * Printable shipping labels with a QR code, one label per page.
 *   A6       105 × 148 mm — office printers (4 per A4 sheet if printed "4 per page")
 *   4×6 in   101.6 × 152.4 mm — thermal label printers used at hubs
 * The QR holds only the tracking number, so any scanner (and the rider app) can read it.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";

export type LabelSize = "a6" | "4x6";
const MM = 72 / 25.4;
export const LABEL_SIZES: Record<LabelSize, [number, number]> = {
  a6: [105 * MM, 148 * MM],
  "4x6": [4 * 72, 6 * 72],
};

export interface LabelOrder {
  tracking_number: string;
  service_type: string;
  recipient_name: string;
  recipient_phone: string;
  dropoff_address_text: string | null;
  dropoff_landmark: string | null;
  dropoff_ghana_post_gps: string | null;
  zone_name: string | null;
  city_name: string | null;
  sender_name: string | null;
  sender_phone: string | null;
  weight_g: number;
  package_size: string | null;
  is_fragile: boolean;
  is_insured?: boolean;
  cod_amount: number;
  payer: string;
  created_at: string;
  delivery_instructions: string | null;
  external_ref: string | null;
  stop_no?: number | null;
  stop_count?: number | null;
}

const ORANGE = rgb(0xdf / 255, 0x65 / 255, 0x18 / 255);
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);

/** The built-in PDF fonts only know Western characters; replace anything else so printing never fails. */
const safe = (s: string | null | undefined) => (s ?? "").replace(/₵/g, "GHS ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");

function wrap(text: string, font: PDFFont, size: number, width: number, maxLines: number): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) <= width) line = t;
    else { if (line) lines.push(line); line = w; }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = lines[maxLines - 1]!.replace(/.{0,3}$/, "...");
  return lines;
}

export async function labelsPdf(orders: LabelOrder[], size: LabelSize): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`QCS labels (${orders.length})`);
  pdf.setCreator("QCS Unified");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = LABEL_SIZES[size];
  const pad = 5 * MM;

  for (const o of orders) {
    const page: PDFPage = pdf.addPage([W, H]);
    const text = (t: string, x: number, y: number, s: number, f = regular, color = BLACK) => page.drawText(safe(t), { x, y, size: s, font: f, color });

    // header
    page.drawRectangle({ x: 0, y: H - 11 * MM, width: W, height: 11 * MM, color: ORANGE });
    text("QCS", pad, H - 8 * MM, 18, bold, rgb(1, 1, 1));
    const svc = o.service_type === "express" ? "EXPRESS" : o.service_type === "ecommerce" ? "E-COMMERCE" : o.service_type.toUpperCase();
    text(svc, W - pad - bold.widthOfTextAtSize(svc, 11), H - 7.5 * MM, 11, bold, rgb(1, 1, 1));

    // QR + tracking number
    const qrSize = 34 * MM;
    const png = await QRCode.toBuffer(o.tracking_number, { errorCorrectionLevel: "M", margin: 0, width: 400 });
    const img = await pdf.embedPng(png);
    let y = H - 13 * MM - qrSize;
    page.drawImage(img, { x: pad, y, width: qrSize, height: qrSize });
    const tx = pad + qrSize + 4 * MM;
    text("Tracking no.", tx, H - 17 * MM, 8, regular, GREY);
    // shrink the tracking number until it fits next to the QR code
    let tSize = 15;
    while (tSize > 8 && bold.widthOfTextAtSize(o.tracking_number, tSize) > W - tx - pad) tSize -= 0.5;
    text(o.tracking_number, tx, H - 23 * MM, tSize, bold);
    if (o.stop_no && o.stop_count) text(`Stop ${o.stop_no} of ${o.stop_count}`, tx, H - 29 * MM, 10, bold);
    text(`${(o.weight_g / 1000).toFixed(1)} kg${o.package_size ? ` · ${o.package_size}` : ""}`, tx, H - 35 * MM, 9);
    const tags = [o.is_fragile ? "FRAGILE" : null, o.is_insured ? "INSURED" : null].filter(Boolean).join("  ");
    if (tags) text(tags, tx, H - 41 * MM, 11, bold, ORANGE);
    if (o.external_ref) text(`Ref: ${o.external_ref}`, tx, H - 46 * MM, 8, regular, GREY);

    // recipient
    y -= 7 * MM;
    page.drawLine({ start: { x: pad, y: y + 4 * MM }, end: { x: W - pad, y: y + 4 * MM }, thickness: 0.8, color: GREY });
    text("DELIVER TO", pad, y, 8, bold, GREY);
    y -= 6 * MM;
    text(o.recipient_name, pad, y, 13, bold);
    y -= 5.5 * MM;
    text(o.recipient_phone, pad, y, 11);
    const lines = wrap([o.dropoff_address_text, o.dropoff_landmark ? `(${o.dropoff_landmark})` : null].filter(Boolean).join(" "), regular, 9.5, W - 2 * pad, 3);
    for (const l of lines) { y -= 4.6 * MM; text(l, pad, y, 9.5); }
    const area = [o.dropoff_ghana_post_gps, o.zone_name, o.city_name].filter(Boolean).join(" · ");
    if (area) { y -= 5 * MM; text(area, pad, y, 10, bold); }
    if (o.delivery_instructions) for (const l of wrap(`Note: ${o.delivery_instructions}`, regular, 8.5, W - 2 * pad, 2)) { y -= 4.2 * MM; text(l, pad, y, 8.5, regular, GREY); }

    // COD / payment box
    const boxH = 12 * MM, boxY = 17 * MM;
    if (o.cod_amount > 0) {
      page.drawRectangle({ x: pad, y: boxY, width: W - 2 * pad, height: boxH, borderColor: BLACK, borderWidth: 1.5 });
      text("COLLECT CASH", pad + 3 * MM, boxY + 7 * MM, 8, bold);
      const amt = `GHS ${(o.cod_amount / 100).toLocaleString("en-GH", { minimumFractionDigits: 2 })}`;
      text(amt, W - pad - 3 * MM - bold.widthOfTextAtSize(amt, 16), boxY + 3.5 * MM, 16, bold);
    } else {
      const paid = o.payer === "recipient" ? "RECIPIENT PAYS DELIVERY FEE" : "NO CASH TO COLLECT";
      text(paid, pad, boxY + 4 * MM, 10, bold);
    }

    // sender + date
    text(`From: ${o.sender_name ?? ""}${o.sender_phone ? ` · ${o.sender_phone}` : ""}`, pad, 10 * MM, 8.5);
    text(new Date(o.created_at).toLocaleDateString("en-GB", { timeZone: "Africa/Accra", day: "2-digit", month: "short", year: "numeric" }), pad, 5.5 * MM, 8, regular, GREY);
    const site = process.env.QCS_LABEL_FOOTER ?? "QCS Ghana";  // e.g. "Track at qcs.com.gh"
    text(site, W - pad - regular.widthOfTextAtSize(site, 8), 5.5 * MM, 8, regular, GREY);
  }
  return pdf.save();
}
