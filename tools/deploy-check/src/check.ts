/**
 * Is this environment (staging or live) set up completely?   pnpm check:deploy
 *
 * Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and the three web addresses:
 *   PORTAL_URL (https://portal.qcsghana.com), OPS_URL (https://ops.qcsghana.com), SITE_URL (https://qcsghana.com)
 * Prints ✅ / ❌ per item with how to fix it; exits with an error if anything is missing.
 */
import { createClient } from "@supabase/supabase-js";

type Item = { item: string; ok: boolean; detail?: string | null; fix?: string };

async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (Supabase → Project settings → API).");
  const items: Item[] = [];

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.rpc("deployment_check");
  if (error) items.push({ item: "database migrations", ok: false, detail: error.message, fix: "npx supabase db push (docs/go-live.md step 3)" });
  else items.push(...(data as { items: Item[] }).items);

  for (const fn of ["send-notifications", "send-webhooks", "send-sms-hook", "whatsapp-webhook"]) {
    // deployed functions answer (401/403/405 without the secret); a missing one answers 404
    const r = await fetch(`${url}/functions/v1/${fn}`, { method: "POST" }).catch(() => null);
    items.push({ item: `Edge Function ${fn} deployed`, ok: !!r && r.status !== 404, detail: r ? `HTTP ${r.status}` : "no answer",
                 fix: `npx supabase functions deploy ${fn}` });
  }

  const web: [string, string | undefined, string][] = [
    ["business portal health", process.env.PORTAL_URL, "/api/health"],
    ["operations dashboard", process.env.OPS_URL, "/login"],
    ["public website", process.env.SITE_URL, "/"],
  ];
  for (const [name, base, path] of web) {
    if (!base) { items.push({ item: name, ok: false, detail: "address not given", fix: `set ${name === "public website" ? "SITE_URL" : name.startsWith("business") ? "PORTAL_URL" : "OPS_URL"}` }); continue; }
    const r = await fetch(base.replace(/\/$/, "") + path, { redirect: "manual" }).catch(() => null);
    const body = path === "/api/health" && r ? await r.json().catch(() => null) as { problems?: string[] } | null : null;
    items.push({ item: `${name} answers`, ok: !!r && r.status < 400, detail: r ? `HTTP ${r.status}${body?.problems?.length ? ` · red checks: ${body.problems.join(", ")}` : ""}` : "no answer",
                 fix: "Vercel → the project → Deployments / Domains" });
  }

  for (const i of items) console.log(`${i.ok ? "✅" : "❌"} ${i.item}${i.detail ? `  (${i.detail})` : ""}${i.ok || !i.fix ? "" : `\n     → ${i.fix}`}`);
  const bad = items.filter((i) => !i.ok).length;
  console.log(bad ? `\n${bad} thing(s) to fix before going live.` : "\nAll set ✔");
  if (bad) process.exitCode = 1;
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
