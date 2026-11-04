You are the lead engineer building the QCS Ghana Unified Delivery Platform. I am the founder, not a developer: explain decisions in plain language, keep the codebase simple, and never introduce a paid service or new dependency without telling me why.

### 1. What we are building
One delivery platform for QCS Ghana (Quality Courier Services) combining:
- On-demand / Express delivery (Uber Eats-style: instant dispatch to nearest rider)
- E-commerce & bulk delivery for online vendors (multi-stop trips, up to 25 stops)
- Inter-city parcel delivery between hubs (Accra, Kumasi, Takoradi, Tamale, then 20+ cities)
- Fulfilment services (goods storage at hubs + customer-service handling for vendors)
- A business API + webhooks + WooCommerce/Shopify plugin so vendors' online stores create deliveries automatically

It is QCS's own operations platform (not SaaS). QCS fleet riders AND independent third-party riders work on it; third-party riders earn commission.

### 2. Apps (one monorepo)
1. Client mobile app (Expo / React Native) — individuals AND vendors/corporate accounts in the same app, with a vendor mode.
2. Rider mobile app (Expo / React Native).
3. Operations dashboard (Next.js web app, responsive so it works on mobile browsers; installable as a PWA). Theme colour #df6518 (QCS orange).
4. Client web portal (Next.js) — vendors book, bulk-upload, track and see statements from a laptop.
5. Public website + tracking page (Next.js): track by tracking number, rate calculator, hub/station pages, rider sign-up.

### 3. Tech stack (fixed — do not change)
- Monorepo: Turborepo + pnpm. Shared packages: `ui`, `types`, `api-client`, `pricing`, `config`.
- Backend: Supabase (Postgres + PostGIS, Auth, Realtime, Storage, Edge Functions). Row Level Security ON for every table.
- Background jobs: Supabase pg_cron + Edge Functions first; only add a queue (Upstash/BullMQ) if a phase genuinely needs it.
- Maps: Google Maps Platform (Places autocomplete, Distance Matrix, Directions). Also accept Ghana Post GPS digital addresses (e.g. GA-123-4567).
- Payments: Hubtel ONLY — card, MTN MoMo, Telecel Cash, AirtelTigo Money for collections; Hubtel disbursement for rider and vendor payouts; Hubtel SMS for OTPs and notifications.
- Push: Expo Notifications (FCM/APNs).
- Messaging: WhatsApp Cloud API (Meta) for notifications and rider status backup.
- Email: Resend.
- Hosting: Vercel (web), EAS Build/Submit (mobile), Supabase cloud.
- Language: TypeScript everywhere. Validation with Zod. Tests with Vitest + Playwright (web) + Maestro (mobile smoke tests).

### 4. User roles
Client side: Individual customer; Vendor owner; Vendor staff (sub-users with permissions); Corporate account (monthly invoicing).
Rider side: QCS fleet rider; Independent/commission rider.
Ops side: Super Admin; Regional/City Admin (sees only their city); Dispatcher; Hub Manager; Hub Handler (scans parcels in/out using the Ops dashboard); Finance; Customer Support; Read-only Analyst.
Every action that changes money, status or permissions is written to an audit log (who, what, before, after, when).

Corporate invoicing rules:
- Corporate accounts are invoiced monthly.
- An automatic reminder (email + SMS/WhatsApp) is sent 7 days after an invoice is issued if it is still unpaid.
- Credit limit: unpaid invoices may not exceed 2 months. If an account has unpaid invoices older than 2 months, new bookings are blocked until it pays (Finance can override, logged in the audit log).
