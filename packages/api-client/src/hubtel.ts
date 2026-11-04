/**
 * Hubtel (CLAUDE.md §3: the ONLY payment provider). Server-side only — never import into an app.
 *
 *  • Online Checkout: POST payproxyapi.hubtel.com/items/initiate (Basic auth: API ID + API key).
 *    The customer pays by card or any MoMo network on Hubtel's page; Hubtel calls our callback URL.
 *  • Transaction status check: confirms a payment directly with Hubtel. Hubtel only answers from
 *    whitelisted server IPs, so it's optional (HUBTEL_STATUS_URL) — see README.
 *  • Send money (disbursement) for wallet withdrawals and payouts.
 *
 * Hubtel does not sign its callbacks, so we never trust a callback on its own:
 *   1. the callback URL carries a secret token only Hubtel knows,
 *   2. the payment must match one we created (reference, checkout id and exact amount),
 *   3. if the status check is configured we ask Hubtel directly before crediting,
 *   4. every message is stored once (idempotent): repeats change nothing.
 * Endpoint URLs are settings so they can be matched to the integration pack Hubtel gives with your account.
 */

export interface HubtelConfig {
  apiId: string;
  apiKey: string;
  merchantAccount: string;           // POS Sales ID / merchant account number
  checkoutUrl: string;
  statusUrl: string | null;          // e.g. https://api-txnstatus.hubtel.com/transactions/{merchant}/status
  sendMoneyUrl: string | null;       // e.g. https://smp.hubtel.com/api/merchants/{prepaidAccount}/send/mobilemoney
}

export function hubtelConfig(env: Record<string, string | undefined>): HubtelConfig | null {
  if (!env.HUBTEL_API_ID || !env.HUBTEL_API_KEY || !env.HUBTEL_MERCHANT_ACCOUNT) return null;
  return {
    apiId: env.HUBTEL_API_ID, apiKey: env.HUBTEL_API_KEY, merchantAccount: env.HUBTEL_MERCHANT_ACCOUNT,
    checkoutUrl: env.HUBTEL_CHECKOUT_URL || "https://payproxyapi.hubtel.com/items/initiate",
    statusUrl: env.HUBTEL_STATUS_URL || null,
    sendMoneyUrl: env.HUBTEL_SEND_MONEY_URL || null,
  };
}

const basic = (c: HubtelConfig) => `Basic ${btoa(`${c.apiId}:${c.apiKey}`)}`;
/** Hubtel works in cedis with 2 decimals; we store pesewas. */
export const toCedis = (p: number) => Math.round(p) / 100;
export const fromCedis = (c: unknown) => Math.round(Number(c) * 100);

export class HubtelError extends Error {}

export interface CheckoutRequest {
  amountPesewas: number; description: string; clientReference: string;
  callbackUrl: string; returnUrl: string; cancellationUrl: string;
  payeeName?: string; payeeMobileNumber?: string; payeeEmail?: string;
}
export interface CheckoutStarted { checkoutId: string; checkoutUrl: string; checkoutDirectUrl: string | null }

export async function initiateCheckout(cfg: HubtelConfig, r: CheckoutRequest, fetchImpl: typeof fetch = fetch): Promise<CheckoutStarted> {
  if (r.clientReference.length > 32) throw new HubtelError("clientReference must be at most 32 characters");
  const res = await fetchImpl(cfg.checkoutUrl, {
    method: "POST",
    headers: { Authorization: basic(cfg), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      totalAmount: toCedis(r.amountPesewas), description: r.description.slice(0, 100), clientReference: r.clientReference,
      callbackUrl: r.callbackUrl, returnUrl: r.returnUrl, cancellationUrl: r.cancellationUrl,
      merchantAccountNumber: cfg.merchantAccount,
      ...(r.payeeName ? { payeeName: r.payeeName } : {}), ...(r.payeeMobileNumber ? { payeeMobileNumber: r.payeeMobileNumber } : {}),
      ...(r.payeeEmail ? { payeeEmail: r.payeeEmail } : {}),
    }),
  });
  const body = await res.json().catch(() => ({})) as { responseCode?: string; status?: string; data?: { checkoutId?: string; checkoutUrl?: string; checkoutDirectUrl?: string; message?: string } };
  if (!res.ok || body.responseCode !== "0000" || !body.data?.checkoutUrl || !body.data.checkoutId) {
    throw new HubtelError(`Hubtel checkout failed (${res.status} ${body.responseCode ?? ""}): ${body.data?.message ?? body.status ?? "no details"}`);
  }
  return { checkoutId: body.data.checkoutId, checkoutUrl: body.data.checkoutUrl, checkoutDirectUrl: body.data.checkoutDirectUrl ?? null };
}

export interface CheckoutCallback {
  clientReference: string; checkoutId: string | null; outcome: "paid" | "failed" | "unknown";
  amountPesewas: number | null; transactionId: string | null; phone: string | null; channel: string | null; dedupeKey: string;
}

/** Read Hubtel's checkout callback ({ ResponseCode, Status, Data: { CheckoutId, SalesInvoiceId, ClientReference, Status, Amount, CustomerPhoneNumber, PaymentDetails } }). */
export function parseCheckoutCallback(body: unknown): CheckoutCallback | null {
  const b = body as Record<string, unknown> | null;
  const d = (b?.Data ?? b?.data) as Record<string, unknown> | undefined;
  if (!b || !d) return null;
  const ref = String(d.ClientReference ?? d.clientReference ?? "");
  if (!ref) return null;
  const code = String(b.ResponseCode ?? b.responseCode ?? "");
  const status = String(d.Status ?? d.status ?? b.Status ?? "").toLowerCase();
  const details = (d.PaymentDetails ?? d.paymentDetails ?? {}) as Record<string, unknown>;
  const outcome = code === "0000" && ["success", "paid", "successful"].includes(status) ? "paid"
    : code && code !== "0000" ? "failed" : ["failed", "unpaid", "cancelled"].includes(status) ? "failed" : "unknown";
  const txn = (d.SalesInvoiceId ?? d.TransactionId ?? d.transactionId ?? null) as string | null;
  return {
    clientReference: ref,
    checkoutId: (d.CheckoutId ?? d.checkoutId ?? null) as string | null,
    outcome,
    amountPesewas: d.Amount != null || d.amount != null ? fromCedis(d.Amount ?? d.amount) : null,
    transactionId: txn,
    phone: (details.MobileMoneyNumber ?? d.CustomerPhoneNumber ?? null) as string | null,
    channel: ((details.Channel ?? details.PaymentType ?? null) as string | null)?.toLowerCase() ?? null,
    dedupeKey: `checkout:${ref}:${txn ?? ""}:${code}:${status}`,
  };
}

export interface StatusResult { outcome: "paid" | "unpaid" | "refunded" | "unknown"; amountPesewas: number | null; transactionId: string | null; channel: string | null }

/** Ask Hubtel directly whether a payment went through. Returns null when not configured. */
export async function checkTransactionStatus(cfg: HubtelConfig, clientReference: string, fetchImpl: typeof fetch = fetch): Promise<StatusResult | null> {
  if (!cfg.statusUrl) return null;
  const url = `${cfg.statusUrl.replace("{merchant}", cfg.merchantAccount)}?clientReference=${encodeURIComponent(clientReference)}`;
  const res = await fetchImpl(url, { headers: { Authorization: basic(cfg), Accept: "application/json" } });
  if (!res.ok) return { outcome: "unknown", amountPesewas: null, transactionId: null, channel: null };
  const body = await res.json().catch(() => ({})) as { responseCode?: string; data?: Record<string, unknown> };
  const d = body.data ?? {};
  const s = String(d.status ?? "").toLowerCase();
  return {
    outcome: s === "paid" ? "paid" : s === "unpaid" ? "unpaid" : s === "refunded" ? "refunded" : "unknown",
    amountPesewas: d.amount != null ? fromCedis(d.amount) : null,
    transactionId: (d.transactionId ?? d.externalTransactionId ?? null) as string | null,
    channel: (d.paymentMethod as string | undefined)?.toLowerCase() ?? null,
  };
}

/** MoMo network name → Hubtel channel code. */
export function momoChannel(network: string | null | undefined): string {
  const n = (network ?? "").toLowerCase();
  if (n.includes("mtn")) return "mtn-gh";
  if (n.includes("telecel") || n.includes("vodafone")) return "vodafone-gh";
  if (n.includes("airtel") || n.includes("tigo") || n.includes("at")) return "tigo-gh";
  throw new HubtelError(`Unknown MoMo network: ${network}`);
}

export interface SendMoneyRequest { clientReference: string; amountPesewas: number; msisdn: string; network: string; recipientName: string; description: string; callbackUrl: string }

/** Ask Hubtel to send money to a MoMo wallet. Hubtel answers "pending", then calls back with the result. */
export async function sendMoney(cfg: HubtelConfig, r: SendMoneyRequest, fetchImpl: typeof fetch = fetch): Promise<{ accepted: boolean; transactionId: string | null; message: string }> {
  if (!cfg.sendMoneyUrl) throw new HubtelError("Hubtel send-money is not configured (HUBTEL_SEND_MONEY_URL)");
  const res = await fetchImpl(cfg.sendMoneyUrl, {
    method: "POST",
    headers: { Authorization: basic(cfg), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      RecipientName: r.recipientName, RecipientMsisdn: r.msisdn.replace(/^\+/, ""), Channel: momoChannel(r.network),
      Amount: toCedis(r.amountPesewas), PrimaryCallbackUrl: r.callbackUrl, Description: r.description.slice(0, 100), ClientReference: r.clientReference,
    }),
  });
  const body = await res.json().catch(() => ({})) as { ResponseCode?: string; Message?: string; Data?: { TransactionId?: string } };
  // 0000 = done, 0001 = accepted and pending; anything else is a refusal
  const accepted = res.ok && (body.ResponseCode === "0000" || body.ResponseCode === "0001");
  return { accepted, transactionId: body.Data?.TransactionId ?? null, message: body.Message ?? `HTTP ${res.status}` };
}

export function parsePayoutCallback(body: unknown): { clientReference: string; outcome: "paid" | "failed"; transactionId: string | null; message: string; dedupeKey: string } | null {
  const b = body as Record<string, unknown> | null;
  const d = (b?.Data ?? b?.data) as Record<string, unknown> | undefined;
  const ref = String(d?.ClientReference ?? "");
  if (!b || !ref) return null;
  const code = String(b.ResponseCode ?? "");
  const txn = (d?.TransactionId ?? null) as string | null;
  return { clientReference: ref, outcome: code === "0000" ? "paid" : "failed", transactionId: txn, message: String(d?.Description ?? b.Message ?? code),
           dedupeKey: `payout:${ref}:${txn ?? ""}:${code}` };
}

/** Constant-time comparison for the callback token. */
export function sameSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
