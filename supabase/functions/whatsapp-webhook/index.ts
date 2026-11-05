/**
 * The QCS WhatsApp number:
 *  • riders' backup: "DELIVERED <tracking no> <code>" updates the order;
 *  • everyone else: the message becomes (or continues) a support ticket; STOP / START opts out of / back in to offers.
 * Photos and PDFs customers send are saved to the private "support" storage bucket and attached to the ticket.
 *  GET  — Meta's one-time webhook check (hub.verify_token).
 *  POST — incoming messages; the Meta signature is checked before anything else.
 * Secrets: WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION (optional)
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { inboundMessages, KEEP_MEDIA, replyRequest, validSignature, type Inbound } from "../_shared/whatsapp.ts";
import { sameSecret } from "../_shared/auth.ts";

export interface Deps {
  verifyToken: string;
  appSecret: string;
  handle: (m: Inbound, mediaPath: string | null) => Promise<string | null>;   // null = nothing to say back
  reply: (to: string, body: string) => Promise<void>;
  saveMedia?: (m: Inbound) => Promise<string | null>;                        // storage path, or null if not kept
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && sameSecret(url.searchParams.get("hub.verify_token"), deps.verifyToken);
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256"), deps.appSecret))) {
    return new Response("Invalid signature", { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  for (const m of inboundMessages(payload)) {
    try {
      let path: string | null = null;
      if (m.media && deps.saveMedia) path = await deps.saveMedia(m).catch((e) => { console.error("media save failed", m.id, e); return null; });
      const answer = await deps.handle(m, path);
      if (answer) await deps.reply(m.from, answer);
    } catch (e) {
      console.error("whatsapp message failed", m.id, e);
      await deps.reply(m.from, "Sorry, we couldn't process that just now. Please try again in a few minutes or call QCS.").catch(() => {});
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
    handle: async (m, path) => {
      const { data, error } = await db.rpc("handle_whatsapp_message", {
        p_id: m.id, p_from: m.from, p_body: m.body, p_name: m.name,
        p_media: m.media ? { kind: m.media.kind, path, mime: m.media.mime, filename: m.media.filename ?? null } : null,
      });
      if (error) throw error;
      return data as string | null;
    },
    // Meta keeps media for a short time: fetch it now and keep a private copy (photos/PDFs up to 5 MB).
    saveMedia: async (m) => {
      const ext = m.media && KEEP_MEDIA[m.media.mime.split(";")[0]!];
      if (!m.media || !ext || !cfg.token) return null;
      const auth = { Authorization: `Bearer ${cfg.token}` };
      const meta = await (await fetch(`https://graph.facebook.com/${cfg.version}/${m.media.id}`, { headers: auth })).json() as { url?: string; file_size?: number };
      if (!meta.url || (meta.file_size ?? 0) > 5_000_000) return null;
      const bytes = await (await fetch(meta.url, { headers: auth })).arrayBuffer();
      const path = `wa/${m.id.replace(/[^A-Za-z0-9._-]/g, "_")}.${ext}`;
      const { error } = await db.storage.from("support").upload(path, bytes, { contentType: m.media.mime, upsert: true });
      if (error) throw error;
      return path;
    },
    reply: async (to, body) => {
      if (!cfg.token || !cfg.phoneNumberId) return;
      const { url, init } = replyRequest(cfg, to, body);
      const res = await fetch(url, init);
      if (!res.ok) console.error("whatsapp reply failed", res.status, await res.text());
    },
  }));
}
