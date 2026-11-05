import { hubtel } from "@qcs/api-client";
import { serviceClient } from "@/server/supabase";
import { hubtelCfg } from "@/server/hubtel-live";

/**
 * GET /api/v1/payments/reconcile — run every 5 minutes by the database scheduler (job payments-reconcile in supabase/setup/schedule-jobs.sql; Authorization: Bearer CRON_SECRET).
 * Catches payments whose Hubtel callback never arrived, by asking Hubtel directly (needs the status check to be configured).
 */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || !hubtel.sameSecret(req.headers.get("authorization"), `Bearer ${process.env.CRON_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const db = serviceClient();
  await db.rpc("expire_unpaid_orders");
  const cfg = hubtelCfg();
  if (!cfg?.statusUrl) return Response.json({ checked: 0, note: "status check not configured" });
  const { data: pending } = await db.from("payments").select("client_reference, checkout_id, amount")
    .eq("state", "pending").lt("created_at", new Date(Date.now() - 3 * 60_000).toISOString()).limit(50);
  let settled = 0;
  for (const p of pending ?? []) {
    const s = await hubtel.checkTransactionStatus(cfg, p.client_reference);
    await db.rpc("record_payment_event", { p_ref: p.client_reference, p_source: "status_check", p_dedupe: `status:${p.client_reference}:${Date.now()}`, p_payload: s ?? {} });
    if (s?.outcome === "paid" && s.amountPesewas != null) {
      const { error } = await db.rpc("settle_payment", { p_ref: p.client_reference, p_checkout_id: null, p_amount: s.amountPesewas, p_txn: s.transactionId, p_channel: s.channel, p_phone: null });
      if (!error) settled++;
    }
  }
  return Response.json({ checked: pending?.length ?? 0, settled });
}
