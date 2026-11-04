/**
 * WhatsApp Cloud API (Meta). Pure helpers so they can be tested.
 * Meta signs every webhook: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body).
 */
export async function validSignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export interface InboundText { id: string; from: string; body: string }

/** Pull the text messages out of a webhook payload (ignores delivery receipts, images, etc.). */
export function textMessages(payload: unknown): InboundText[] {
  const out: InboundText[] = [];
  const p = payload as { entry?: { changes?: { value?: { messages?: { id: string; from: string; type: string; text?: { body: string } }[] } }[] }[] };
  for (const e of p?.entry ?? []) for (const c of e.changes ?? []) for (const m of c.value?.messages ?? []) {
    if (m.type === "text" && m.text?.body) out.push({ id: m.id, from: m.from, body: m.text.body });
  }
  return out;
}

export function replyRequest(cfg: { token: string; phoneNumberId: string; version: string }, to: string, body: string) {
  return {
    url: `https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    } satisfies RequestInit,
  };
}
