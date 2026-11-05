import { serviceClient } from "@/server/supabase";
import { liveApiDeps } from "@/server/business/http";
import { rates } from "@/server/business/core";
import { vendorCtx } from "@/server/business/vendor-ctx";
import { rateRequestToApi, ratesToShopify, type ShopifyRateRequest } from "@/server/integrations/shopify";

/**
 * POST /api/integrations/shopify/rates/<token> — Shopify asks for prices while the customer is at checkout.
 * Must answer fast; on any problem we answer "no rates" so the checkout never breaks.
 */
export async function POST(req: Request, ctx2: { params: Promise<{ token: string }> }) {
  const none = () => Response.json({ rates: [] });
  try {
    const { token } = await ctx2.params;
    if (!/^[0-9a-f]{32}$/.test(token)) return none();
    const db = serviceClient();
    const { data: shop } = await db.from("shopify_shops").select("vendor_id, service, uninstalled_at").eq("rates_token", token).maybeSingle();
    if (!shop || shop.uninstalled_at) return none();
    const body = await req.json() as ShopifyRateRequest;
    if (body.rate?.currency !== "GHS" || body.rate.destination?.country !== "GH") return none();
    const ctx = await vendorCtx(db, shop.vendor_id, "shopify");
    if (!ctx) return none();
    const r = await rates(ctx, rateRequestToApi(body, shop.service as "ecommerce" | "express"), liveApiDeps(db, ctx));
    return Response.json(ratesToShopify(r.rates as Parameters<typeof ratesToShopify>[0]));
  } catch {
    return none();
  }
}
