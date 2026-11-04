import { handleCheckoutCallback } from "@/server/payments";
import { callbackDeps } from "@/server/hubtel-live";

/** POST /api/v1/payments/hubtel/callback?token=… — Hubtel tells us a checkout finished. See server/payments.ts for the checks. */
export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  let body: unknown = null;
  try { body = await req.json(); } catch { /* unreadable */ }
  try {
    const r = await handleCheckoutCallback(token, body, callbackDeps());
    if (r.status !== 200) console.warn("hubtel callback refused:", r.outcome);
    return Response.json({ received: r.status === 200, outcome: r.outcome }, { status: r.status });
  } catch (e) {
    console.error("hubtel callback error", e);
    return Response.json({ received: false }, { status: 500 });   // Hubtel will retry
  }
}
