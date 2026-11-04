import QRCode from "qrcode";
import { TRACKING_NUMBER_RE } from "@qcs/config";

/** GET /api/v1/qr/ACC-202611041301-KUM.png — QR image of a tracking number (public: tracking numbers are on the parcel anyway). */
export async function GET(_req: Request, ctx: RouteContext<"/api/v1/qr/[tracking]">) {
  const { tracking } = await ctx.params;
  const tn = tracking.replace(/\.png$/i, "").toUpperCase();
  if (!TRACKING_NUMBER_RE.test(tn)) return new Response("Not a QCS tracking number", { status: 400 });
  const png = await QRCode.toBuffer(tn, { errorCorrectionLevel: "M", margin: 1, width: 360 });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" } });
}
