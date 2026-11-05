# QCS Ghana — Shopify app

Lets a vendor connect their Shopify store to QCS from the business portal (Developers → WooCommerce & Shopify):

- **Live rates at checkout** (Shopify CarrierService): same-day / inter-city prices from the QCS pricing engine.
  Needs "carrier-calculated shipping" on the merchant's Shopify plan (Advanced plan, or the paid add-on).
- **Automatic booking**: paid orders (and Cash-on-Delivery orders when they are placed) become QCS deliveries.
  The order is tagged `QCS <tracking number>` with the tracking link in its notes.
- Disconnects itself when the app is uninstalled; answers Shopify's mandatory privacy (GDPR) webhooks.

There is no separate server: the app is a set of routes in the client portal.

## One-time setup (QCS)
1. Create a free Shopify Partner account → Apps → Create app → "Create app manually" (name: QCS Ghana Delivery).
2. App URL: `https://<portal>/developers?tab=integrations`; Allowed redirection URL: `https://<portal>/api/integrations/shopify/callback`.
3. Privacy webhooks (customers/data_request, customers/redact, shop/redact): `https://<portal>/api/integrations/shopify/webhooks`.
4. Copy the app's **Client ID** and **Client secret** into the portal's environment as `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`
   (and make sure `PUBLIC_API_URL` is the portal's public https address).
5. Distribution: "Custom distribution" per merchant is quickest. A public App Store listing needs Shopify's review.

`shopify.app.toml` holds the same settings for the Shopify CLI (`shopify app deploy`).

## What a vendor does
Portal → Developers → WooCommerce & Shopify → enter `my-shop.myshopify.com` → Connect → approve in Shopify.
Their business ID must be verified by QCS before orders are booked (same as live API keys).
