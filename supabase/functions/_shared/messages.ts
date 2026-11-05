/**
 * Builders for the four outgoing channels. Pure functions (no Deno globals) so they can be tested.
 *   push     → Expo push service (free; delivers to Android FCM and Apple APNs for us)
 *   sms      → Hubtel SMS (see hubtel-sms.ts)
 *   whatsapp → WhatsApp Cloud API, using a Meta-approved template (required for messages we start);
 *              support replies inside the 24-hour window after the customer wrote are plain text
 *   email    → Resend
 */
export interface Outgoing {
  id: string;
  channel: "push" | "sms" | "whatsapp" | "email";
  to: string | string[];
  key: string;
  subject: string;
  body: string;
  wa_template: string | null;
  wa_params: string[];
  data: Record<string, unknown>;
}

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export function expoPushRequest(m: Outgoing) {
  const tokens = Array.isArray(m.to) ? m.to : [m.to];
  return {
    url: EXPO_PUSH_URL,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(tokens.map((to) => ({
        to, title: m.subject || "QCS", body: m.body, data: m.data, sound: "default",
        priority: "high", channelId: m.key === "job_offer" ? "jobs" : "default",
        ttl: m.key === "job_offer" ? 20 : undefined,   // a job offer is useless after 20 seconds
      }))),
    } satisfies RequestInit,
    tokens,
  };
}

/** Expo answers one ticket per token. Returns which tokens are dead (app uninstalled) and whether anything got through. */
export function readExpoTickets(tokens: string[], json: unknown): { ok: boolean; dead: string[]; error?: string } {
  const tickets = (json as { data?: { status: string; message?: string; details?: { error?: string } }[] })?.data ?? [];
  const dead: string[] = [];
  let ok = false; let error: string | undefined;
  tickets.forEach((t, i) => {
    if (t.status === "ok") ok = true;
    else {
      error = t.message ?? t.details?.error ?? "push failed";
      if (t.details?.error === "DeviceNotRegistered" && tokens[i]) dead.push(tokens[i]!);
    }
  });
  return { ok, dead, error };
}

/** WhatsApp numbers are digits only with the country code: 233XXXXXXXXX. */
export function waNumber(phone: string): string | null {
  const d = phone.replace(/\D/g, "");
  if (d.startsWith("233") && d.length === 12) return d;
  if (d.startsWith("0") && d.length === 10) return "233" + d.slice(1);
  if (d.length === 9) return "233" + d;
  return null;
}

export function whatsappTemplateRequest(cfg: { token: string; phoneNumberId: string; version: string; language?: string }, m: Outgoing) {
  const to = waNumber(String(m.to));
  if (!to) throw new Error("not a Ghana mobile number");
  if (!m.wa_template) throw new Error("no WhatsApp template name set");
  return {
    url: `https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "template",
        template: {
          name: m.wa_template, language: { code: cfg.language ?? "en" },
          components: m.wa_params.length ? [{ type: "body", parameters: m.wa_params.map((text) => ({ type: "text", text: text || "-" })) }] : [],
        },
      }),
    } satisfies RequestInit,
  };
}

/** Plain-text WhatsApp: only allowed within 24 hours of the customer's last message (support replies). */
export function whatsappTextRequest(cfg: { token: string; phoneNumberId: string; version: string }, m: Outgoing) {
  const to = waNumber(String(m.to));
  if (!to) throw new Error("not a Ghana mobile number");
  return {
    url: `https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: m.body.slice(0, 4000) } }),
    } satisfies RequestInit,
  };
}

/** Free text when the database says the 24-hour window is open (wa_text), otherwise the approved template. */
export function whatsappRequest(cfg: { token: string; phoneNumberId: string; version: string; language?: string }, m: Outgoing) {
  return m.data?.wa_text === true && !m.wa_template ? whatsappTextRequest(cfg, m) : whatsappTemplateRequest(cfg, m);
}

export function resendRequest(cfg: { apiKey: string; from: string }, m: Outgoing) {
  return {
    url: "https://api.resend.com/emails",
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.from, to: [String(m.to)], subject: m.subject || "QCS", text: m.body }),
    } satisfies RequestInit,
  };
}
