"use server";
import { revalidatePath } from "next/cache";
import { getStaff } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { sendAll, sendingReady, sendPayout, type Payout } from "@/lib/payout-send";

export interface Result { ok: boolean; message: string }
const fail = (message: string): Result => ({ ok: false, message });

/**
 * Approve a single payout (customer withdrawal or rider cash-out): the database checks you're Finance and marks it
 * "processing", then Hubtel is asked to send it. Hubtel's callback marks it paid (or returns the money to the wallet).
 */
export async function approvePayout(id: string): Promise<Result> {
  if (!(await getStaff())) return fail("Not signed in");
  const notReady = sendingReady();
  if (notReady) return fail(notReady);
  const sb = await supabaseServer();
  const { data: po, error } = await sb.rpc("approve_payout", { p_payout: id });
  if (error) return fail(error.message);
  const r = await sendPayout(po);
  revalidatePath("/finance");
  return r.ok ? { ok: true, message: "Sent to Hubtel. It will show as paid when Hubtel confirms." } : fail(`${r.message}. Nothing was sent; the money is back in the wallet.`);
}

/** Approve a whole batch (a second Finance person), then send every payout in it through Hubtel. */
export async function approveBatch(id: string): Promise<Result> {
  if (!(await getStaff())) return fail("Not signed in");
  const notReady = sendingReady();
  if (notReady) return fail(notReady);
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc("approve_payout_batch", { p_batch: id });
  if (error) return fail(error.message);
  let r: Awaited<ReturnType<typeof sendAll>>;
  try { r = await sendAll((data ?? []) as Payout[]); }
  catch (e) { revalidatePath("/finance", "layout"); return fail(`Approved, but sending stopped: ${(e as Error).message}. Check the batch page before trying again.`); }
  revalidatePath("/finance", "layout");
  return r.failed.length
    ? { ok: r.sent > 0, message: `${r.sent} sent to Hubtel; ${r.failed.length} not sent (money back in their wallets): ${r.failed.slice(0, 3).map((f) => f.reason).join("; ")}` }
    : { ok: true, message: `Approved. ${r.sent} payout(s) sent to Hubtel; each shows as paid when Hubtel confirms.` };
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
