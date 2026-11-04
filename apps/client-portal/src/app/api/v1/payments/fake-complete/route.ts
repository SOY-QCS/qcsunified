import { z } from "zod";
import { fakePayments } from "@/server/hubtel-live";
import { serviceClient } from "@/server/supabase";

/** Local testing only (DEV_FAKE_PAYMENTS=1, never in production): pretend Hubtel confirmed or failed a payment. */
export async function POST(req: Request) {
  if (!fakePayments()) return new Response("Not available", { status: 404 });
  const b = z.object({ ref: z.string(), ok: z.boolean() }).parse(await req.json());
  const db = serviceClient();
  const { data: p } = await db.from("payments").select("amount, checkout_id").eq("client_reference", b.ref).single();
  const { error } = b.ok
    ? await db.rpc("settle_payment", { p_ref: b.ref, p_checkout_id: p!.checkout_id, p_amount: p!.amount, p_txn: `fake-${Date.now()}`, p_channel: "mtn-gh", p_phone: "+233200000001" })
    : await db.rpc("fail_payment", { p_ref: b.ref, p_reason: "Test payment declined" });
  return Response.json({ ok: !error, error: error?.message });
}
