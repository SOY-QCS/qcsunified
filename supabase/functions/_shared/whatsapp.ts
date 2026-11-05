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

export interface InboundMedia { kind: "image" | "document" | "audio" | "video"; id: string; mime: string; filename?: string }
/** One customer message: text, or a photo/document/voice note (with its caption as the text). */
export interface Inbound { id: string; from: string; name: string | null; body: string; media: InboundMedia | null }

type MetaMsg = {
  id: string; from: string; type: string; text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string }; document?: { id: string; mime_type: string; caption?: string; filename?: string };
  audio?: { id: string; mime_type: string }; video?: { id: string; mime_type: string; caption?: string };
};
type MetaPayload = { entry?: { changes?: { value?: { contacts?: { wa_id: string; profile?: { name?: string } }[]; messages?: MetaMsg[] } }[] }[] };

/** Pull the customer messages out of a webhook payload (ignores delivery receipts, reactions, locations…). */
export function inboundMessages(payload: unknown): Inbound[] {
  const out: Inbound[] = [];
  for (const e of (payload as MetaPayload)?.entry ?? []) for (const c of e.changes ?? []) {
    const names = new Map((c.value?.contacts ?? []).map((x) => [x.wa_id, x.profile?.name ?? null]));
    for (const m of c.value?.messages ?? []) {
      const name = names.get(m.from) ?? null;
      if (m.type === "text" && m.text?.body) { out.push({ id: m.id, from: m.from, name, body: m.text.body, media: null }); continue; }
      const kind = m.type as InboundMedia["kind"];
      const att = (kind === "image" || kind === "document" || kind === "audio" || kind === "video")
        ? m[kind] as { id: string; mime_type: string; caption?: string; filename?: string } | undefined : undefined;
      if (att?.id) {
        out.push({ id: m.id, from: m.from, name, body: att.caption ?? "", media: { kind, id: att.id, mime: att.mime_type, filename: att.filename } });
      }
    }
  }
  return out;
}

/** Text messages only (riders' DELIVERED commands). */
export function textMessages(payload: unknown): InboundText[] {
  return inboundMessages(payload).filter((m) => !m.media).map(({ id, from, body }) => ({ id, from, body }));
}

/** File types we keep from customers (same as the private "support" storage bucket allows). */
export const KEEP_MEDIA: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

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
