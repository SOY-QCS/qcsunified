import "server-only";
import { hubtel } from "@qcs/api-client";
import { supabaseAdmin } from "./supabase/server";

export interface Payout { id: string; client_reference: string; amount: number; momo_number: string; momo_network: string | null; purpose: string }
const WHAT: Record<string, string> = { rider_weekly: "QCS rider weekly pay", rider_instant: "QCS rider cash-out", vendor_cod: "QCS COD payout", customer_refund: "QCS wallet withdrawal" };

/** Is Hubtel send-money set up? Checked BEFORE approving, so nothing is ever approved that can't be sent. */
export function sendingReady(): string | null {
  const cfg = hubtel.hubtelConfig(process.env);
  if (!cfg?.sendMoneyUrl || !process.env.HUBTEL_CALLBACK_TOKEN || !process.env.PUBLIC_API_URL) return "Hubtel send-money isn't set up yet (keys, send-money URL, callback token, public address), so nothing was approved or sent.";
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return "The dashboard's server key isn't set, so nothing was approved or sent.";
  return null;
}

/**
 * Ask Hubtel to send one approved payout. If Hubtel isn't set up or refuses, the payout is marked failed straight away
 * and the money goes back to the owner's wallet (nothing is ever lost or sent twice). Hubtel's callback marks success.
 */
export async function sendPayout(po: Payout): Promise<{ ok: boolean; message: string }> {
  const cfg = hubtel.hubtelConfig(process.env);
  const admin = supabaseAdmin();
  const failWith = async (reason: string) => { await admin.rpc("fail_payout", { p_ref: po.client_reference, p_reason: reason }); return { ok: false, message: reason }; };
  if (!cfg?.sendMoneyUrl || !process.env.HUBTEL_CALLBACK_TOKEN || !process.env.PUBLIC_API_URL) return failWith("Hubtel send-money is not set up yet");
  try {
    const r = await hubtel.sendMoney(cfg, {
      clientReference: po.client_reference, amountPesewas: po.amount, msisdn: po.momo_number, network: po.momo_network ?? "mtn",
      recipientName: "QCS payee", description: WHAT[po.purpose] ?? "QCS payout",
      callbackUrl: `${process.env.PUBLIC_API_URL!.replace(/\/$/, "")}/api/v1/payouts/hubtel/callback?token=${encodeURIComponent(process.env.HUBTEL_CALLBACK_TOKEN)}`,
    });
    return r.accepted ? { ok: true, message: "sent" } : failWith(`Hubtel refused: ${r.message}`);
  } catch (e) {
    return failWith(`Couldn't reach Hubtel: ${(e as Error).message}`);
  }
}

/** Send many, a few at a time (gentle on Hubtel's limits). */
export async function sendAll(list: Payout[]): Promise<{ sent: number; failed: { ref: string; reason: string }[] }> {
  let sent = 0; const failed: { ref: string; reason: string }[] = [];
  for (let i = 0; i < list.length; i += 5) {
    const rs = await Promise.all(list.slice(i, i + 5).map(async (p) => ({ p, r: await sendPayout(p) })));
    for (const { p, r } of rs) r.ok ? sent++ : failed.push({ ref: p.client_reference, reason: r.message });
  }
  return { sent, failed };
}
