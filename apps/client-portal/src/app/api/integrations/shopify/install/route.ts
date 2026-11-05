import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { SHOPIFY_SCOPES } from "@/server/integrations/shopify";

const back = (req: Request, q: string) => NextResponse.redirect(new URL(`/developers?tab=integrations&${q}`, req.url));

/** GET /api/integrations/shopify/install?shop=… — from the portal's "Connect Shopify" button (the vendor is signed in). */
export async function GET(req: Request) {
  const key = process.env.SHOPIFY_API_KEY;
  const base = process.env.PUBLIC_API_URL;
  if (!key || !process.env.SHOPIFY_API_SECRET || !base) return back(req, "shopify_error=" + encodeURIComponent("Shopify isn't set up on QCS's side yet. Please contact QCS."));
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/developers", req.url));
  const { data: account } = await sb.rpc("my_account");
  if (!account?.vendor) return back(req, "shopify_error=" + encodeURIComponent("Only business accounts can connect a shop"));
  const { data, error } = await sb.rpc("start_shopify_connect", { p_vendor: account.vendor.id, p_shop: new URL(req.url).searchParams.get("shop") ?? "" });
  if (error) return back(req, "shopify_error=" + encodeURIComponent(error.message));
  const [state, shop] = (data as string).split(":");
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set("client_id", key);
  u.searchParams.set("scope", SHOPIFY_SCOPES);
  u.searchParams.set("redirect_uri", `${base.replace(/\/$/, "")}/api/integrations/shopify/callback`);
  u.searchParams.set("state", state!);
  return NextResponse.redirect(u);
}
