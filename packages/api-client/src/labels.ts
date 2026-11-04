/**
 * Printable shipping labels with a QR code, one label per page.
 *   A6       105 × 148 mm — office printers (4 per A4 sheet if printed "4 per page")
 *   4×6 in   101.6 × 152.4 mm — thermal label printers used at hubs
 * The QR holds only the tracking number, so any scanner (and the rider app) can read it.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  /** inter-city: the hub the parcel is going to (printed big so sorters see it) */
  dest_hub_code?: string | null;
  collect_at_hub?: boolean;
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
    if (o.dest_hub_code) {
      const hubTxt = `> ${o.dest_hub_code.replace("-HUB", "")}${o.collect_at_hub ? " COLLECT" : ""}`;
      text(hubTxt, tx, H - 30 * MM, 16, bold, ORANGE);
    }

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

// ---------- hub paperwork ----------
export interface BagTag { code: string; from: string; to: string; parcels: number; created_at: string }

/** Bag tag: a big QR of the bag code (scanned onto the manifest and at arrival) and where it's going. One per page. */
export async function bagTagsPdf(bags: BagTag[], size: LabelSize = "4x6"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`QCS bag tags (${bags.length})`);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = LABEL_SIZES[size];
  for (const b of bags) {
    const page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 14 * MM, width: W, height: 14 * MM, color: ORANGE });
    page.drawText("QCS BAG", { x: 5 * MM, y: H - 10 * MM, size: 18, font: bold, color: rgb(1, 1, 1) });
    const to = safe(b.to.replace("-HUB", ""));
    page.drawText(`TO ${to}`, { x: 5 * MM, y: H - 34 * MM, size: 40, font: bold, color: BLACK });
    page.drawText(safe(`from ${b.from.replace("-HUB", "")} · ${b.parcels} parcel(s)`), { x: 5 * MM, y: H - 42 * MM, size: 11, font: regular, color: GREY });
    const q = 70 * MM;
    const img = await pdf.embedPng(await QRCode.toBuffer(b.code, { errorCorrectionLevel: "M", margin: 0, width: 600 }));
    page.drawImage(img, { x: (W - q) / 2, y: 22 * MM, width: q, height: q });
    const c = safe(b.code);
    page.drawText(c, { x: (W - bold.widthOfTextAtSize(c, 13)) / 2, y: 13 * MM, size: 13, font: bold, color: BLACK });
    const d = new Date(b.created_at).toLocaleDateString("en-GB", { timeZone: "Africa/Accra", day: "2-digit", month: "short", year: "numeric" });
    page.drawText(d, { x: (W - regular.widthOfTextAtSize(d, 9)) / 2, y: 7 * MM, size: 9, font: regular, color: GREY });
  }
  return pdf.save();
}

export interface ManifestSheet {
  code: string; from: string; to: string; bus_company: string | null; bus_station: string | null; driver_name: string | null; driver_phone: string | null;
  vehicle_reg: string | null; waybill_no: string | null; seal_no: string | null; departed_at: string | null;
  bags: { code: string; parcels: string[] }[];
}

/** A4 manifest the bus driver and both hubs sign: bus details, every bag and parcel, signature lines. */
export async function manifestPdf(m: ManifestSheet): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Manifest ${m.code}`);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = [210 * MM, 297 * MM];
  let page = pdf.addPage([W, H]);
  let y = H - 20 * MM;
  const line = (t: string, s = 10, f = regular, x = 15 * MM) => { page.drawText(safe(t), { x, y, size: s, font: f, color: BLACK }); y -= s * 0.55 * MM + 2 * MM; };
  const img = await pdf.embedPng(await QRCode.toBuffer(m.code, { margin: 0, width: 300 }));
  page.drawImage(img, { x: W - 45 * MM, y: H - 45 * MM, width: 30 * MM, height: 30 * MM });
  line("QCS LINE-HAUL MANIFEST", 16, bold);
  line(m.code, 12, bold);
  line(`${m.from.replace("-HUB", "")}  ->  ${m.to.replace("-HUB", "")}`, 12, bold);
  y -= 2 * MM;
  for (const [k, v] of [["Bus company / station", [m.bus_company, m.bus_station].filter(Boolean).join(" / ")], ["Vehicle", m.vehicle_reg], ["Driver", [m.driver_name, m.driver_phone].filter(Boolean).join(" · ")],
                        ["Bus waybill no.", m.waybill_no], ["Seal no.", m.seal_no],
                        ["Departed", m.departed_at ? new Date(m.departed_at).toLocaleString("en-GB", { timeZone: "Africa/Accra" }) : ""]] as const) line(`${k}: ${v ?? ""}`);
  y -= 2 * MM;
  line(`${m.bags.length} bag(s), ${m.bags.reduce((n, b) => n + b.parcels.length, 0)} parcel(s)`, 11, bold);
  for (const b of m.bags) {
    if (y < 40 * MM) { page = pdf.addPage([W, H]); y = H - 20 * MM; }
    line(`${b.code}  (${b.parcels.length})`, 10, bold);
    for (let i = 0; i < b.parcels.length; i += 3) {
      if (y < 30 * MM) { page = pdf.addPage([W, H]); y = H - 20 * MM; }
      line(b.parcels.slice(i, i + 3).join("     "), 9, regular, 20 * MM);
    }
  }
  if (y < 50 * MM) { page = pdf.addPage([W, H]); y = H - 20 * MM; }
  y -= 8 * MM;
  for (const who of ["Handed over (origin hub)", "Received by driver", "Received (destination hub)"]) { line(`${who}:  Name ____________________   Signature ____________   Time ______`, 9); y -= 4 * MM; }
  return pdf.save();
}

/** Load orders for labels as the signed-in person (Row Level Security decides which they may print), in the order asked. */
export async function loadLabelOrders(db: SupabaseClient, ids: string[]): Promise<LabelOrder[]> {
  const { data, error } = await db.from("orders")
    .select(`id, tracking_number, service_type, recipient_name, recipient_phone, dropoff_address_text, dropoff_landmark, dropoff_ghana_post_gps,
             pickup_contact_name, pickup_contact_phone, weight_g, package_size, is_fragile, is_insured, cod_amount, payer, created_at, delivery_instructions,
             external_ref, trip_id, intercity_option, zone:zones!orders_dropoff_zone_id_fkey(name, city:cities(name)), vendor:vendors(business_name),
             dest_hub:hubs!orders_dest_hub_id_fkey(code)`)
    .in("id", ids);
  if (error) throw error;
  const rows = data ?? [];
  const tripSizes = new Map<string, number>();
  rows.forEach((o) => o.trip_id && tripSizes.set(o.trip_id, (tripSizes.get(o.trip_id) ?? 0) + 1));
  const tripIndex = new Map<string, number>();
  const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] : x) ?? null;
  return ids.map((id) => rows.find((o) => o.id === id)).filter(Boolean).map((o) => {
    const r = o!;
    const n = r.trip_id ? (tripIndex.get(r.trip_id) ?? 0) + 1 : null;
    if (r.trip_id) tripIndex.set(r.trip_id, n!);
    return {
      ...r,
      zone_name: one(r.zone as unknown as { name: string } | null)?.name ?? null,
      // the delivery city (for inter-city it differs from the order's pickup city)
      city_name: one(one(r.zone as unknown as { city: { name: string } } | null)?.city ?? null)?.name ?? null,
      sender_name: one(r.vendor as unknown as { business_name: string } | null)?.business_name ?? r.pickup_contact_name,
      sender_phone: r.pickup_contact_phone,
      stop_no: r.service_type === "intercity" ? null : n, stop_count: r.trip_id && r.service_type !== "intercity" ? tripSizes.get(r.trip_id) ?? null : null,
      dest_hub_code: one(r.dest_hub as unknown as { code: string } | null)?.code ?? null,
      collect_at_hub: r.intercity_option === "hub_collection",
    } as LabelOrder;
  });
}

export function pdfResponse(pdf: Uint8Array, name: string): Response {
  return new Response(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "private, no-store" } });
}
