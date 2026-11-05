import { serviceClient } from "@/server/supabase";
import { liveApiDeps } from "@/server/business/http";
import { create } from "@/server/business/core";
import { vendorCtx } from "@/server/business/vendor-ctx";
import { SHOPIFY_API_VERSION, orderDecision, orderToDelivery, verifyWebhook, type ShopifyOrder } from "@/server/integrations/shopify";

/**
 * POST /api/integrations/shopify/webhooks — every Shopify topic arrives here (checked with the app secret):
 *  orders/create (COD orders) and orders/paid (paid orders) → book the delivery and tag the order "QCS <tracking>";
 *  app/uninstalled → disconnect; customers/data_request, customers/redact, shop/redact → GDPR (required by Shopify).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256"), process.env.SHOPIFY_API_SECRET ?? "")) return new Response("bad signature", { status: 401 });
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shopDomain = req.headers.get("x-shopify-shop-domain") ?? "";
  const db = serviceClient();

  if (topic === "app/uninstalled") {
    await db.from("shopify_shops").update({ uninstalled_at: new Date().toISOString(), carrier_service_id: null }).eq("shop", shopDomain);
    await db.from("shopify_tokens").delete().eq("shop", shopDomain);
    return new Response("ok");
  }
  if (topic === "shop/redact") {          // 48 h after uninstall: forget the shop (deliveries stay: they are QCS's own business records)
    await db.from("shopify_shops").delete().eq("shop", shopDomain);
    return new Response("ok");
  }
  if (topic.startsWith("customers/")) return new Response("ok");   // we keep no Shopify customer profiles; delivery records are QCS's own
  if (topic !== "orders/create" && topic !== "orders/paid") return new Response("ignored");

  const { data: shop } = await db.from("shopify_shops").select("shop, vendor_id, service, auto_create, carrier_service_id, uninstalled_at").eq("shop", shopDomain).maybeSingle();
  if (!shop || shop.uninstalled_at) return new Response("not connected");
  const order = JSON.parse(raw) as ShopifyOrder;
  const decision = orderDecision(order, topic, shop);
  if (!decision.book) return new Response(`skipped: ${decision.why}`);
  const ctx = await vendorCtx(db, shop.vendor_id, "shopify");
  if (!ctx?.verified) {
    await db.from("shopify_shops").update({ last_error: `Order ${order.name} not booked: QCS hasn't verified your business ID yet` }).eq("shop", shopDomain);
    return new Response("not verified");
  }
  try {
    const d = await create(ctx, orderToDelivery(order, decision), liveApiDeps(db, ctx));
    // tag the order so the merchant sees the tracking number in Shopify
    const { data: t } = await db.from("shopify_tokens").select("access_token").eq("shop", shopDomain).maybeSingle();
    if (t) {
      const tags = [order.tags, `QCS ${d.tracking_number}`].filter(Boolean).join(", ");
      await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${order.id}.json`, { method: "PUT",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t.access_token },
        body: JSON.stringify({ order: { id: order.id, tags, note_attributes: [{ name: "QCS tracking", value: String(d.tracking_url ?? d.tracking_number) }] } }) }).catch(() => {});
    }
    await db.from("shopify_shops").update({ last_error: null }).eq("shop", shopDomain);
    return new Response("booked");
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 409) return new Response("already booked");     // Shopify retries webhooks: the order number guards against doubles
    await db.from("shopify_shops").update({ last_error: `Order ${order.name} not booked: ${(e as Error).message}${(e as { details?: string[] }).details ? " — " + (e as { details: string[] }).details.join("; ") : ""}`.slice(0, 500) }).eq("shop", shopDomain);
    return new Response("not booked");       // 200 so Shopify doesn't retry a request that will fail the same way; the merchant sees the reason in the portal
  }
}
