import "server-only";
import { hubtel } from "@qcs/api-client";

/**
 * What we do when Hubtel calls back about a checkout. Written with its outside calls passed in,
 * so every case (good, duplicate, forged, wrong amount, failed) is tested without real money.
 */
export interface CallbackDeps {
  expectedToken: string | undefined;
  record: (ref: string, dedupe: string, payload: unknown) => Promise<boolean>;       // false = seen before
  statusCheck: (ref: string) => Promise<hubtel.StatusResult | null>;                 // null = not configured
  settle: (ref: string, checkoutId: string | null, amount: number, txn: string | null, channel: string | null, phone: string | null) => Promise<string>;
  fail: (ref: string, reason: string) => Promise<void>;
}
export type CallbackResult = { status: number; outcome: string };

export async function handleCheckoutCallback(token: string | null, body: unknown, deps: CallbackDeps): Promise<CallbackResult> {
  if (!hubtel.sameSecret(token, deps.expectedToken)) return { status: 401, outcome: "bad_token" };
  const cb = hubtel.parseCheckoutCallback(body);
  if (!cb) return { status: 400, outcome: "unreadable" };
  if (!(await deps.record(cb.clientReference, cb.dedupeKey, body))) return { status: 200, outcome: "duplicate" };

  if (cb.outcome === "failed") { await deps.fail(cb.clientReference, "Hubtel reported the payment failed"); return { status: 200, outcome: "failed" }; }
  if (cb.outcome !== "paid" || cb.amountPesewas == null) return { status: 200, outcome: "ignored" };

  // Ask Hubtel directly when we can. If Hubtel says it isn't paid, the callback is not believed.
  const check = await deps.statusCheck(cb.clientReference);
  if (check && check.outcome !== "paid") return { status: 200, outcome: `not_confirmed_${check.outcome}` };
  const amount = check?.amountPesewas ?? cb.amountPesewas;
  try {
    const r = await deps.settle(cb.clientReference, cb.checkoutId, amount, check?.transactionId ?? cb.transactionId, cb.channel ?? check?.channel ?? null, cb.phone);
    return { status: 200, outcome: r };
  } catch (e) {
    // e.g. amount mismatch: keep a 200 so Hubtel doesn't hammer us; Finance sees it in the payment record.
    return { status: 200, outcome: `rejected: ${(e as Error).message}` };
  }
}

/** Normalise the payer's number to +233… for refunds. */
export function payerPhone(p: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/\D/g, "");
  if (d.startsWith("233") && d.length === 12) return `+${d}`;
  if (d.startsWith("0") && d.length === 10) return `+233${d.slice(1)}`;
  return null;
}
