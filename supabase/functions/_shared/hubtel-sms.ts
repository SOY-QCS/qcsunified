/**
 * Sending SMS through Hubtel (CLAUDE.md §3: Hubtel ONLY).
 * Hubtel "Simple Messaging": POST /v1/messages/send, Basic Auth with the SMS client id/secret,
 * JSON body { From, To, Content }. Pure code (no Deno globals) so it can be tested.
 */

export interface HubtelSmsConfig {
  clientId: string;
  clientSecret: string;
  /** Sender ID registered and approved on your Hubtel account, e.g. "QCS" (max 11 characters). */
  senderId: string;
  url?: string;
}

export const HUBTEL_SMS_URL = "https://smsc.hubtel.com/v1/messages/send";

/** Turn any Ghana number format into +233XXXXXXXXX. Returns null if it isn't a valid Ghana mobile number. */
export function normalizeGhanaPhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, "");
  let local: string;
  if (digits.startsWith("233") && digits.length === 12) local = digits.slice(3);
  else if (digits.startsWith("0") && digits.length === 10) local = digits.slice(1);
  else if (digits.length === 9) local = digits;
  else return null;
  if (!/^[235]\d{8}$/.test(local)) return null; // Ghana mobile numbers start 2x, 5x (and 3x for some networks)
  return `+233${local}`;
}

export function loginCodeMessage(code: string): string {
  return `QCS: your login code is ${code}. It expires in 5 minutes. Never share this code.`;
}

export function buildHubtelRequest(cfg: HubtelSmsConfig, to: string, content: string): { url: string; init: RequestInit } {
  const auth = btoa(`${cfg.clientId}:${cfg.clientSecret}`);
  return {
    url: cfg.url ?? HUBTEL_SMS_URL,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({ From: cfg.senderId, To: to, Content: content }),
    },
  };
}

export interface SendResult { ok: boolean; messageId?: string; error?: string }

export async function sendHubtelSms(
  cfg: HubtelSmsConfig, to: string, content: string, fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const phone = normalizeGhanaPhone(to);
  if (!phone) return { ok: false, error: `Not a valid Ghana phone number: ${to}` };
  const { url, init } = buildHubtelRequest(cfg, phone, content);
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    return { ok: false, error: `Could not reach Hubtel: ${(e as Error).message}` };
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* Hubtel sometimes returns plain text on errors */ }
  // Hubtel returns status 0 for "request submitted successfully".
  if (res.ok && (body.status === 0 || body.status === "0" || body.messageId)) {
    return { ok: true, messageId: String(body.messageId ?? "") };
  }
  return { ok: false, error: `Hubtel error ${res.status}: ${body.statusDescription ?? text.slice(0, 200)}` };
}
