/**
 * Sends queued notifications (push, SMS, WhatsApp, email). Run by a schedule every 10–15 seconds (see README).
 * The database decides WHO gets WHAT (templates + preferences); this function only delivers and reports back.
 * Secrets: NOTIFY_SECRET (the schedule sends it as "x-qcs-secret"), HUBTEL_SMS_*, WHATSAPP_*, RESEND_API_KEY, EMAIL_FROM.
 * A channel whose keys aren't set yet is reported as failed (and retried later), so nothing is lost.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendHubtelSms, type HubtelSmsConfig } from "../_shared/hubtel-sms.ts";
import { expoPushRequest, readExpoTickets, resendRequest, whatsappRequest, type Outgoing } from "../_shared/messages.ts";
import { fromScheduler } from "../_shared/auth.ts";

export interface SendDeps {
  claim: (limit: number) => Promise<Outgoing[]>;
  finish: (id: string, ok: boolean, error?: string) => Promise<void>;
  dropToken: (token: string) => Promise<void>;
  fetch: typeof fetch;
  sms: HubtelSmsConfig | null;
  whatsapp: { token: string; phoneNumberId: string; version: string } | null;
  email: { apiKey: string; from: string } | null;
}

export async function sendOne(m: Outgoing, d: SendDeps): Promise<{ ok: boolean; error?: string }> {
  try {
    if (m.channel === "push") {
      const r = expoPushRequest(m);
      const res = await d.fetch(r.url, r.init);
      if (!res.ok) return { ok: false, error: `Expo ${res.status}` };
      const t = readExpoTickets(r.tokens, await res.json());
      for (const tok of t.dead) await d.dropToken(tok);
      return { ok: t.ok, error: t.ok ? undefined : t.error };
    }
    if (m.channel === "sms") {
      if (!d.sms) return { ok: false, error: "Hubtel SMS keys not set" };
      const r = await sendHubtelSms(d.sms, String(m.to), m.body, d.fetch);
      return { ok: r.ok, error: r.error };
    }
    if (m.channel === "whatsapp") {
      if (!d.whatsapp) return { ok: false, error: "WhatsApp keys not set" };
      const r = whatsappRequest(d.whatsapp, m);
      const res = await d.fetch(r.url, r.init);
      return res.ok ? { ok: true } : { ok: false, error: `WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    if (!d.email) return { ok: false, error: "Resend key not set" };
    const r = resendRequest(d.email, m);
    const res = await d.fetch(r.url, r.init);
    return res.ok ? { ok: true } : { ok: false, error: `Resend ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function sendBatch(d: SendDeps, limit = 100): Promise<{ sent: number; failed: number }> {
  const batch = await d.claim(limit);
  let sent = 0, failed = 0;
  // a few at a time: fast enough for 10,000+ deliveries a day, gentle on Hubtel/Meta rate limits
  for (let i = 0; i < batch.length; i += 10) {
    await Promise.all(batch.slice(i, i + 10).map(async (m) => {
      const r = await sendOne(m, d);
      await d.finish(m.id, r.ok, r.error);
      r.ok ? sent++ : failed++;
    }));
  }
  return { sent, failed };
}

if (import.meta.main) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const env = (k: string) => Deno.env.get(k) ?? "";
  Deno.serve(async (req) => {
    if (!fromScheduler(req, "NOTIFY_SECRET")) return new Response("Unauthorized", { status: 401 });
    const result = await sendBatch({
      claim: async (n) => ((await db.rpc("claim_notifications", { p_limit: n })).data ?? []) as Outgoing[],
      finish: async (id, ok, error) => { await db.rpc("finish_notification", { p_id: id, p_ok: ok, p_error: error ?? null }); },
      dropToken: async (t) => { await db.rpc("drop_push_token", { p_token: t }); },
      fetch,
      sms: env("HUBTEL_SMS_CLIENT_ID") ? { clientId: env("HUBTEL_SMS_CLIENT_ID"), clientSecret: env("HUBTEL_SMS_CLIENT_SECRET"), senderId: env("HUBTEL_SMS_SENDER_ID") || "QCS", url: env("HUBTEL_SMS_URL") || undefined } : null,
      whatsapp: env("WHATSAPP_TOKEN") ? { token: env("WHATSAPP_TOKEN"), phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"), version: env("WHATSAPP_API_VERSION") || "v21.0" } : null,
      email: env("RESEND_API_KEY") ? { apiKey: env("RESEND_API_KEY"), from: env("EMAIL_FROM") || "QCS <hello@qcsghana.com>" } : null,
    });
    return Response.json(result);
  });
}
