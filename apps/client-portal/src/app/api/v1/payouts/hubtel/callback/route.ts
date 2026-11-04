import { hubtel } from "@qcs/api-client";
import { serviceClient } from "@/server/supabase";

/** POST /api/v1/payouts/hubtel/callback?token=… — Hubtel reports whether money it sent to a MoMo wallet arrived. */
export async function POST(req: Request) {
  if (!hubtel.sameSecret(new URL(req.url).searchParams.get("token"), process.env.HUBTEL_CALLBACK_TOKEN)) return new Response("Unauthorized", { status: 401 });
  const body = await req.json().catch(() => null);
  const cb = hubtel.parsePayoutCallback(body);
  if (!cb) return new Response("Unreadable", { status: 400 });
  const db = serviceClient();
  const { data: isNew } = await db.rpc("record_payment_event", { p_ref: cb.clientReference, p_source: "payout_callback", p_dedupe: cb.dedupeKey, p_payload: body });
  if (!isNew) return Response.json({ received: true, outcome: "duplicate" });
  const { error } = cb.outcome === "paid"
    ? await db.rpc("complete_payout", { p_ref: cb.clientReference, p_txn: cb.transactionId })
    : await db.rpc("fail_payout", { p_ref: cb.clientReference, p_reason: cb.message });
  return Response.json({ received: true, outcome: error ? `rejected: ${error.message}` : cb.outcome });
}
