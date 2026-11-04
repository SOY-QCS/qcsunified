import { z } from "zod";
import { hubtel } from "@qcs/api-client";
import { ApiError, caller, errorResponse, serviceClient } from "@/server/supabase";
import { fakePayments, publicUrl, requireHubtel } from "@/server/hubtel-live";

const Body = z.object({ order_ids: z.array(z.uuid()).min(1).max(200) });

/**
 * POST /api/v1/rider/cod-remit — a rider hands in COD cash by Mobile Money.
 * Starts a Hubtel checkout for exactly the chosen parcels' cash; Hubtel's confirmation marks them handed in.
 */
export async function POST(req: Request) {
  try {
    const me = await caller(req);
    const b = Body.safeParse(await req.json());
    if (!b.success) throw new ApiError(400, "Choose the cash to hand in");
    const db = serviceClient();
    const { data: pay, error } = await db.rpc("create_cod_remit_payment", { p_rider: me.user.id, p_orders: b.data.order_ids });
    if (error) throw new ApiError(400, error.message);
    const ret = `${publicUrl()}/pay/return?ref=${pay.client_reference}&app=rider&kind=remit`;
    if (fakePayments() && !hubtel.hubtelConfig(process.env)) {
      const url = `${publicUrl()}/pay/fake?ref=${pay.client_reference}&app=rider&kind=remit`;
      await db.rpc("attach_checkout", { p_payment: pay.id, p_checkout_id: `fake-${pay.client_reference}`, p_url: url });
      return Response.json({ client_reference: pay.client_reference, checkout_url: url, amount: pay.amount, test_mode: true });
    }
    const cfg = requireHubtel();
    const started = await hubtel.initiateCheckout(cfg, {
      amountPesewas: pay.amount, clientReference: pay.client_reference,
      description: `QCS COD hand-in (${b.data.order_ids.length} parcel${b.data.order_ids.length > 1 ? "s" : ""})`,
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
