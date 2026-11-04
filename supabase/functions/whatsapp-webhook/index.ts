/**
 * WhatsApp backup for riders: "DELIVERED <tracking no> <code>" sent to the QCS WhatsApp number updates the order.
 *  GET  — Meta's one-time webhook check (hub.verify_token).
 *  POST — incoming messages; the Meta signature is checked before anything else.
 * Secrets: WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION (optional)
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { replyRequest, textMessages, validSignature } from "../_shared/whatsapp.ts";

export interface Deps {
  verifyToken: string;
  appSecret: string;
  handle: (id: string, from: string, body: string) => Promise<string | null>;   // null = already handled
  reply: (to: string, body: string) => Promise<void>;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === deps.verifyToken && deps.verifyToken !== "";
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256"), deps.appSecret))) {
    return new Response("Invalid signature", { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  for (const m of textMessages(payload)) {
    try {
      const answer = await deps.handle(m.id, m.from, m.body);
      if (answer) await deps.reply(m.from, answer);
    } catch (e) {
      console.error("whatsapp message failed", m.id, e);
      await deps.reply(m.from, "Sorry, we couldn't process that. Please use the rider app or call dispatch.").catch(() => {});
    }
  }
  return new Response("ok", { status: 200 });   // always 200 for signed messages, or Meta keeps retrying
}

if (import.meta.main) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const cfg = { token: Deno.env.get("WHATSAPP_TOKEN") ?? "", phoneNumberId: Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "", version: Deno.env.get("WHATSAPP_API_VERSION") ?? "v21.0" };
  Deno.serve((req) => handle(req, {
    verifyToken: Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "",
    appSecret: Deno.env.get("WHATSAPP_APP_SECRET") ?? "",
    handle: async (id, from, body) => {
      const { data, error } = await db.rpc("handle_whatsapp_message", { p_id: id, p_from: from, p_body: body });
      if (error) throw error;
      return data as string | null;
    },
    reply: async (to, body) => {
      if (!cfg.token || !cfg.phoneNumberId) return;
      const { url, init } = replyRequest(cfg, to, body);
      const res = await fetch(url, init);
      if (!res.ok) console.error("whatsapp reply failed", res.status, await res.text());
    },
  }));
}
