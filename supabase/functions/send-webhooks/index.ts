/**
 * Sends queued business webhooks (delivery.created / delivery.status_changed / ping). Run by a schedule every
 * 10–15 seconds, like send-notifications. The database decides what to send and when to retry; this only delivers.
 * Secrets: NOTIFY_SECRET (the schedule sends it as "x-qcs-secret").
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { deliver, type Attempt, type WebhookJob } from "../_shared/webhooks.ts";

export interface Deps {
  claim: (limit: number) => Promise<WebhookJob[]>;
  finish: (id: string, a: Attempt) => Promise<void>;
  fetch: typeof fetch;
}

export async function sendBatch(d: Deps, limit = 100): Promise<{ sent: number; failed: number }> {
  const jobs = await d.claim(limit);
  let sent = 0, failed = 0;
  // 10 at a time; one slow endpoint can't hold up everyone else for more than its 10 seconds
  for (let i = 0; i < jobs.length; i += 10) {
    await Promise.all(jobs.slice(i, i + 10).map(async (j) => {
      const a = await deliver(j, d.fetch);
      await d.finish(j.id, a);
      a.ok ? sent++ : failed++;
    }));
  }
  return { sent, failed };
}

if (import.meta.main) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  Deno.serve(async (req) => {
    const secret = Deno.env.get("NOTIFY_SECRET") ?? "";
    if (!secret || req.headers.get("x-qcs-secret") !== secret) return new Response("Unauthorized", { status: 401 });
    const result = await sendBatch({
      claim: async (n) => ((await db.rpc("claim_webhooks", { p_limit: n })).data ?? []) as WebhookJob[],
      finish: async (id, a) => { await db.rpc("finish_webhook", { p_id: id, p_ok: a.ok, p_status: a.status, p_error: a.error, p_response: a.response }); },
      fetch,
    });
    return Response.json(result);
  });
}
