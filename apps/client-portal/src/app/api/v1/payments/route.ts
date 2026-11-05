import { z } from "zod";
import { hubtel } from "@qcs/api-client";
import { ApiError, caller, errorResponse, serviceClient } from "@/server/supabase";
import { fakePayments, publicUrl, requireHubtel } from "@/server/hubtel-live";
import { limited } from "@/server/rate-limit";

const Body = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("order"), order_ids: z.array(z.uuid()).min(1).max(25), app: z.boolean().optional() }),
  z.object({ purpose: z.literal("wallet_topup"), amount: z.number().int().positive(), vendor_id: z.uuid().nullable().optional(), app: z.boolean().optional() }),
]);

/** POST /api/v1/payments — start a Hubtel checkout for unpaid orders or a wallet top-up. Returns the link to Hubtel's payment page. */
export async function POST(req: Request) {
  try {
    const me = await caller(req);
    const stop = await limited("payments", `user:${me.user.id}`); if (stop) return stop;
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) throw new ApiError(400, "Check the payment details", parsed.error.issues.map((i) => i.message));
    const b = parsed.data;
    const db = serviceClient();
    const { data: pay, error } = await db.rpc("create_payment", {
      p_user: me.user.id, p_purpose: b.purpose,
      p_order_ids: b.purpose === "order" ? b.order_ids : null,
      p_amount: b.purpose === "wallet_topup" ? b.amount : null,
      p_vendor: b.purpose === "wallet_topup" ? b.vendor_id ?? null : null,
    });
    if (error) throw new ApiError(400, error.message);
    const ret = `${publicUrl()}/pay/return?ref=${pay.client_reference}${b.app ? "&app=1" : ""}`;

    if (fakePayments() && !hubtel.hubtelConfig(process.env)) {
      const url = `${publicUrl()}/pay/fake?ref=${pay.client_reference}${b.app ? "&app=1" : ""}`;
      await db.rpc("attach_checkout", { p_payment: pay.id, p_checkout_id: `fake-${pay.client_reference}`, p_url: url });
      return Response.json({ client_reference: pay.client_reference, checkout_url: url, amount: pay.amount, test_mode: true });
    }

    const cfg = requireHubtel();
    const started = await hubtel.initiateCheckout(cfg, {
      amountPesewas: pay.amount, clientReference: pay.client_reference,
      description: b.purpose === "order" ? `QCS delivery (${b.order_ids.length} parcel${b.order_ids.length > 1 ? "s" : ""})` : "QCS wallet top-up",
      callbackUrl: `${publicUrl()}/api/v1/payments/hubtel/callback?token=${encodeURIComponent(process.env.HUBTEL_CALLBACK_TOKEN!)}`,
      returnUrl: ret, cancellationUrl: `${ret}&cancelled=1`,
      payeeMobileNumber: me.user.phone ? me.user.phone.replace(/^\+/, "") : undefined,
    });
    await db.rpc("attach_checkout", { p_payment: pay.id, p_checkout_id: started.checkoutId, p_url: started.checkoutUrl });
    return Response.json({ client_reference: pay.client_reference, checkout_url: started.checkoutUrl, amount: pay.amount });
  } catch (e) {
    return errorResponse(e);
  }
}
