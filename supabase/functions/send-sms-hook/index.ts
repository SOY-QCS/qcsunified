/**
 * Supabase Auth "Send SMS" hook → Hubtel.
 * Supabase calls this whenever it needs to text a login code (phone + OTP sign-in).
 * The request is signed by Supabase; we check the signature before sending anything.
 *
 * Secrets (supabase secrets set ...):
 *   SEND_SMS_HOOK_SECRET      v1,whsec_...  (generated in Supabase → Auth → Hooks)
 *   HUBTEL_SMS_CLIENT_ID, HUBTEL_SMS_CLIENT_SECRET, HUBTEL_SMS_SENDER_ID
 *   HUBTEL_SMS_URL            optional, defaults to Hubtel's endpoint
 */
import { Webhook } from "npm:standardwebhooks@1.0.0";
import { loginCodeMessage, sendHubtelSms, type HubtelSmsConfig } from "../_shared/hubtel-sms.ts";

export interface HookDeps {
  hookSecrets: string[];          // without the "v1,whsec_" prefix; several allowed during rotation
  hubtel: HubtelSmsConfig;
  fetchImpl?: typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hookError = (http_code: number, message: string) => json({ error: { http_code, message } }, http_code);

export async function handle(req: Request, deps: HookDeps): Promise<Response> {
  if (req.method !== "POST") return hookError(405, "Method not allowed");
  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);

  type SmsHookEvent = { user?: { phone?: string }; sms?: { otp?: string } };
  let event: SmsHookEvent | undefined;
  for (const secret of deps.hookSecrets) {
    try { event = new Webhook(secret).verify(payload, headers) as SmsHookEvent; break; } catch { /* try next */ }
  }
  if (event === undefined) return hookError(401, "Invalid signature");

  const phone = event.user?.phone;
  const otp = event.sms?.otp;
  if (!phone || !otp) return hookError(400, "Missing phone or code");

  const result = await sendHubtelSms(deps.hubtel, phone, loginCodeMessage(otp), deps.fetchImpl);
  if (!result.ok) {
    console.error("send-sms-hook:", result.error);
    return hookError(502, "We could not send your code right now. Please try again.");
  }
  return json({});
}

if (import.meta.main) {
  const secrets = (Deno.env.get("SEND_SMS_HOOK_SECRET") ?? "")
    .split("|").map((s) => s.trim().replace(/^v1,whsec_/, "")).filter(Boolean);
  const hubtel: HubtelSmsConfig = {
    clientId: Deno.env.get("HUBTEL_SMS_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("HUBTEL_SMS_CLIENT_SECRET") ?? "",
    senderId: Deno.env.get("HUBTEL_SMS_SENDER_ID") ?? "QCS",
    url: Deno.env.get("HUBTEL_SMS_URL") || undefined,
  };
  Deno.serve((req) => {
    if (!secrets.length || !hubtel.clientId || !hubtel.clientSecret) {
      console.error("send-sms-hook: secrets are not configured");
      return hookError(500, "SMS is not configured");
    }
    return handle(req, { hookSecrets: secrets, hubtel });
  });
}
