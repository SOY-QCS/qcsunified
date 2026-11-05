import { NextResponse } from "next/server";
import { serviceClient } from "@/server/supabase";
import { SHOP_RE, SHOPIFY_API_VERSION, verifyOAuthQuery } from "@/server/integrations/shopify";

/**
 * GET /api/integrations/shopify/callback — Shopify sends the merchant back here after they approve the app.
 * Checks Shopify's signature and our one-time state, saves the token, then registers live rates and order webhooks.
 */
export async function GET(req: Request) {
  const back = (q: string) => NextResponse.redirect(new URL(`/developers?tab=integrations&${q}`, req.url));
  const fail = (m: string) => back("shopify_error=" + encodeURIComponent(m));
  const p = new URL(req.url).searchParams;
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  const shop = p.get("shop") ?? "";
  if (!verifyOAuthQuery(p, secret) || !SHOP_RE.test(shop)) return fail("The answer from Shopify could not be verified. Please try again.");
  const db = serviceClient();
  const { data: st } = await db.from("shopify_oauth_states").delete().eq("state", p.get("state") ?? "").select("vendor_id, user_id, shop, created_at").maybeSingle();
  if (!st || st.shop !== shop || Date.now() - Date.parse(st.created_at) > 3600_000) return fail("This connection link expired. Press Connect Shopify again.");

  const tok = await fetch(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.SHOPIFY_API_KEY, client_secret: secret, code: p.get("code") }) });
  if (!tok.ok) return fail("Shopify didn't give access. Please try again.");
  const { access_token, scope } = await tok.json() as { access_token: string; scope: string };

  const { data: row, error } = await db.from("shopify_shops").upsert({ shop, vendor_id: st.vendor_id, scopes: scope, connected_by: st.user_id, installed_at: new Date().toISOString(),
    uninstalled_at: null, last_error: null, carrier_service_id: null }, { onConflict: "shop" }).select("rates_token").single();
  if (error) return fail(error.message);
  await db.from("shopify_tokens").upsert({ shop, access_token, updated_at: new Date().toISOString() });

  const base = (process.env.PUBLIC_API_URL ?? new URL(req.url).origin).replace(/\/$/, "");
  const admin = (path: string, body: unknown) => fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": access_token }, body: JSON.stringify(body) });
  const problems: string[] = [];
  // live rates at checkout (needs carrier-calculated shipping on the merchant's plan)
  const cs = await admin("carrier_services.json", { carrier_service: { name: "QCS Ghana", callback_url: `${base}/api/integrations/shopify/rates/${row.rates_token}`, service_discovery: true } });
  if (cs.ok) await db.from("shopify_shops").update({ carrier_service_id: (await cs.json()).carrier_service.id }).eq("shop", shop);
  else problems.push("Live rates at checkout aren't available on this Shopify plan (needs carrier-calculated shipping). Orders are still booked automatically.");
  for (const topic of ["orders/create", "orders/paid", "app/uninstalled"]) {
    const w = await admin("webhooks.json", { webhook: { topic, address: `${base}/api/integrations/shopify/webhooks`, format: "json" } });
    if (!w.ok && w.status !== 422) problems.push(`Couldn't subscribe to ${topic} (HTTP ${w.status})`);   // 422 = already subscribed
  }
  if (problems.length) await db.from("shopify_shops").update({ last_error: problems.join(" ") }).eq("shop", shop);
  return back("shopify=connected");
}
