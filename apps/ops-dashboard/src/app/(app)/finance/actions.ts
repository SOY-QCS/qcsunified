"use server";
import { revalidatePath } from "next/cache";
import { hubtel } from "@qcs/api-client";
import { getStaff } from "@/lib/session";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";

export interface Result { ok: boolean; message: string }
const fail = (message: string): Result => ({ ok: false, message });

/**
 * Approve a withdrawal: the database checks you're Finance and marks it "processing",
 * then we ask Hubtel to send the money. Hubtel's callback marks it paid (or returns the money to the wallet).
 */
export async function approvePayout(id: string): Promise<Result> {
  if (!(await getStaff())) return fail("Not signed in");
  const sb = await supabaseServer();
  const { data: po, error } = await sb.rpc("approve_payout", { p_payout: id });
  if (error) return fail(error.message);
  const cfg = hubtel.hubtelConfig(process.env);
  const admin = supabaseAdmin();
  if (!cfg?.sendMoneyUrl || !process.env.HUBTEL_CALLBACK_TOKEN || !process.env.PUBLIC_API_URL) {
    await admin.rpc("fail_payout", { p_ref: po.client_reference, p_reason: "Hubtel send-money is not set up yet" });
    revalidatePath("/finance");
    return fail("Hubtel send-money isn't set up yet, so nothing was sent. The money is back in the customer's wallet.");
  }
  try {
    const r = await hubtel.sendMoney(cfg, {
      clientReference: po.client_reference, amountPesewas: po.amount, msisdn: po.momo_number, network: po.momo_network ?? "mtn",
      recipientName: "QCS customer", description: "QCS wallet withdrawal",
      callbackUrl: `${process.env.PUBLIC_API_URL!.replace(/\/$/, "")}/api/v1/payouts/hubtel/callback?token=${encodeURIComponent(process.env.HUBTEL_CALLBACK_TOKEN)}`,
    });
    if (!r.accepted) {
      await admin.rpc("fail_payout", { p_ref: po.client_reference, p_reason: r.message });
      revalidatePath("/finance");
      return fail(`Hubtel refused: ${r.message}. The money is back in the wallet.`);
    }
  } catch (e) {
    await admin.rpc("fail_payout", { p_ref: po.client_reference, p_reason: (e as Error).message });
    revalidatePath("/finance");
    return fail(`Couldn't reach Hubtel: ${(e as Error).message}. The money is back in the wallet.`);
  }
  revalidatePath("/finance");
  return { ok: true, message: "Sent to Hubtel. It will show as paid when Hubtel confirms." };
}

export async function rejectPayout(id: string, reason: string): Promise<Result> {
  const sb = await supabaseServer();
  const { error } = await sb.rpc("reject_payout", { p_payout: id, p_reason: reason });
  revalidatePath("/finance");
  return error ? fail(error.message) : { ok: true, message: "Rejected — the money is back in the wallet." };
}

export async function refund(tracking: string, amountGhs: number, reason: string): Promise<Result> {
  const sb = await supabaseServer();
  const { data: o } = await sb.from("orders").select("id").eq("tracking_number", tracking.trim().toUpperCase()).maybeSingle();
  if (!o) return fail("No order with that tracking number");
  const { error } = await sb.rpc("refund_order", { p_order: o.id, p_amount: Math.round(amountGhs * 100), p_reason: reason });
  revalidatePath("/finance");
  return error ? fail(error.message) : { ok: true, message: `Refunded GHS ${amountGhs.toFixed(2)} to the payer's wallet.` };
}
