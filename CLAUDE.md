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
2. Rider mobile app (Expo / React Native). Also used by Hub Handlers in a separate "Hub mode" (see section 4).
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
Rider side (Rider app): QCS fleet rider; Independent/commission rider; Hub Handler.
Ops side (Ops dashboard): Super Admin; Regional/City Admin (sees only their city); Dispatcher; Hub Manager; Finance; Customer Support; Read-only Analyst.

Scanning rules:
- All parcel scanning happens in the Rider app using the phone camera (native barcode/QR scanning, works offline and syncs when back online).
- Riders scan at pickup, at hub drop-off and at delivery (chain of custody).
- Hub Handlers log in to the Rider app and see only "Hub mode": scan in, scan out, sort to route, hand over to rider, with fast bulk scanning. They never see delivery jobs; riders never see Hub mode. The screen shown depends on the user's role.
- Hub Managers use the Ops dashboard for the hub overview: stock in hub, late/stuck parcels, and who scanned what and when.
Every action that changes money, status or permissions is written to an audit log (who, what, before, after, when).

Corporate invoicing rules:
- Corporate accounts are invoiced monthly.
- An automatic reminder (email + SMS/WhatsApp) is sent 7 days after an invoice is issued if it is still unpaid.
- Credit limit: unpaid invoices may not exceed 2 months. If an account has unpaid invoices older than 2 months, new bookings are blocked until it pays (Finance can override; every override is written to the audit log).

### 5. Service types & pricing (all values editable in admin, per city/zone)
- EXPRESS (on-demand, same-day): price = base fee + (per-km × distance) + (per-minute × est. duration) + surcharges (weight band, fragile, night, surge). Bike-only. 15 kg hard cap for Express Bulk. The client can update their trip after the rider has started it; the cost of the change is added to the original price and paid on delivery.
- E-COMMERCE / BULK: priced per weight band per destination zone. A vendor can put up to 25 orders in one trip, and each successful delivery is billed at a flat rate.
- INTER-CITY: priced by origin hub → destination hub lane + weight band; options: hub-to-hub pickup, or doorstep delivery at destination.
- SCHEDULED / NEXT-DAY: book a future pickup slot; configurable same-day cut-off time per city (e.g. book before 9:00am for same-day).
- FLAT-RATE PROMOS: admin can create a flat fee for a zone and date range (e.g. GHS 25 anywhere in Accra).
- Cash on Delivery (COD): rider collects item value; platform tracks it to settlement.
- Who pays: sender, recipient, or vendor wallet.
Pricing rules (confirmed):
- E-commerce/bulk: each stop is billed a fixed amount looked up from that stop's weight band + destination zone. No distance or time charge.
- Express: the quoted price is locked at booking. The client pays the quote even if traffic makes the trip longer. The price only changes if the client changes the trip.
- Express weight: parcels over 15 kg are refused at booking (bike-only service).
- Mid-trip changes when the client already paid upfront: the extra amount is collected on delivery, and the client chooses either a Hubtel MoMo/card prompt or cash to the rider.
- Failed and returned deliveries are charged 50% of the original delivery fee.
The pricing engine lives in `packages/pricing` and is the ONLY place prices are calculated. Always show the client an estimated quote before they confirm.

### 6. Dispatch rules
- Express: offer the job to the nearest available, online, eligible rider. Rider has 20 seconds to accept/reject; on reject/timeout offer the next nearest. After N rejections (configurable) escalate to a dispatcher.
- A rider can hold ONE active job (either an Express job or a Bulk trip) and must complete it before receiving another.
- Bulk trips: capped by stop count (max 25). Stop order is dynamic — the app always suggests the nearest undelivered stop next; rider can re-order.
- Dispatchers can manually assign, reassign, split or merge trips from the dashboard.
- Rider eligibility filters: city, vehicle type, max weight, cash float limit for COD, rider rating, documents valid.

Dispatch details (confirmed):
- Finding the nearest rider: shortlist the 5 closest eligible riders by straight-line distance (PostGIS, free), then rank that shortlist by road travel time with one Google Distance Matrix call.
- Bulk next-stop suggestion uses straight-line distance (no Google cost).
- Escalation default: N = 5 rejections/timeouts (about 2 minutes), then the job goes to a dispatcher. Editable in admin.
- Rejections and timeouts count against the rider's score, which is used for rewards. Rider acceptance rate is tracked and shown on the rider profile.

### 7. Order lifecycle (single status machine used everywhere)
DRAFT → PENDING_PAYMENT → CONFIRMED → SEARCHING_RIDER → ASSIGNED → RIDER_AT_PICKUP → PICKED_UP → IN_TRANSIT → (AT_HUB → DEPARTED_HUB → ARRIVED_DEST_HUB → OUT_FOR_DELIVERY for inter-city) → ARRIVED_AT_DROPOFF → DELIVERED
Exception branches: CANCELLED, FAILED_ATTEMPT (reason required), RESCHEDULED, RETURNING_TO_SENDER, RETURNED, LOST/DAMAGED (claim opened).
Every transition stores timestamp, actor, GPS point, and optional photo/note. Clients and vendors get notified on key transitions. Vendors' webhook URLs receive every transition.

Lifecycle details (confirmed):
- Hub collection (inter-city "hub-to-hub pickup"): ARRIVED_DEST_HUB → READY_FOR_COLLECTION → COLLECTED. The recipient is notified when the parcel is ready and shows the OTP at the hub to collect.
- Payment step: only orders paid upfront by card/MoMo go through PENDING_PAYMENT. Corporate (invoiced), COD, recipient-pays and vendor-wallet orders go straight from DRAFT to CONFIRMED.
- Bulk trips have two levels: the trip has its own status (ASSIGNED → IN_PROGRESS → COMPLETED), and each order in the trip keeps its own full status. One failed stop does not fail the trip.
- Proof of delivery: see section 8 (OTP + signature by default; also applies to hub collection).
- If the recipient cannot give the OTP (e.g. no phone), the rider requests an override; Customer Support or a Dispatcher approves it with a required photo + note. Every override is written to the audit log.

### 8. Proof of delivery
- Default for every order: the rider must enter the 4-digit delivery code sent to the recipient (SMS/WhatsApp) AND capture the recipient's signature on screen.
- Vendors can only make it stricter, never weaker: e.g. also require a photo, or turn on the pickup code. They cannot drop below OTP + signature.
- Separate pickup code for high-value items.
- Geofence check: rider must be within 3 km of the drop-off to mark delivered (radius editable in admin; admin override with reason, written to the audit log).

### 9. Money
- Client wallet (top-up via Hubtel) + pay per order.
- Vendor wallet with statements: deliveries charged, COD collected, COD remitted, fees, balance; downloadable PDF/CSV statement by date range.
- COD reconciliation: rider → cash collected → remitted to QCS (MoMo or cash at hub) → paid out to vendor on schedule (daily/weekly).
- Rider earnings: fixed pickup fee + fixed per-successful-delivery/stop fee (QCS fleet) OR commission % (independent riders); bonuses, deductions, cash-float tracking. Weekly payout via Hubtel; rider can request instant cash-out (fee configurable).
- Corporate accounts: monthly invoice with credit limit (see the corporate invoicing rules in section 4).
- Promo codes, referral credits, refunds — all through the wallet ledger. Ledger is double-entry; balances are never edited directly.

Money details (confirmed):
- COD payout: vendors receive the full COD amount collected. QCS delivery fees are billed separately (charged to the vendor wallet or invoiced), never deducted from COD.
- Unpaid vendor fees: if a vendor's fees are more than 7 days overdue, the system holds their next COD payout until the fees are settled. The vendor is notified; Finance can release the hold (written to the audit log).
- Rider COD remittance: riders must remit all COD cash by end of day. If they miss the deadline or reach their cash float limit, they receive no new COD jobs until they remit.
- Client wallet refunds: a client can request their wallet balance back; it is refunded to MoMo via Hubtel disbursement, to the same MoMo number used to top up (fraud protection).
- Legal check before launch: confirm with a lawyer and Hubtel that the wallets comply with Bank of Ghana e-money rules (Payment Systems and Services Act, 2019).

### 10. Addresses
- Google Places autocomplete + pin drop + Ghana Post GPS code + landmark/description field + recipient phone.
- Address confirmation flow: after booking, recipient gets a WhatsApp/SMS link to confirm or correct their pin before dispatch. Unconfirmed addresses are flagged to dispatch.
- Saved addresses and address book for vendors (repeat customers).

Address confirmation timing (confirmed):
- The confirmation link opens a simple page on the public website: no login, no app download.
- Express: dispatch immediately; the confirmation link is sent at the same time. If the recipient corrects the pin, the rider's route updates automatically.
- E-commerce/Bulk and Inter-city: wait for confirmation until the trip is planned (normally the city's same-day cut-off). Unconfirmed stops are flagged to dispatch, who can call the recipient or send anyway.
- Recipient pin corrections on Express: if the correction moves the drop-off more than 1 km, the price is recalculated and the sender is notified; the difference is collected like any mid-trip change (Hubtel MoMo/card prompt or cash to rider). Corrections of 1 km or less keep the quoted price.

### 11. Hubs, inter-city & fulfilment
- Hubs per city with staff, opening hours, address, capacity.
- Hub scanning: every parcel gets a QR label; hub handlers scan IN, sort to outbound bag/manifest, scan OUT (in the Rider app's Hub mode, see section 4).
- Manifests for inter-city line-haul (vehicle, driver, seal number, parcel list), with arrival scan at destination hub.
- Fulfilment: vendor inventory per hub (SKU, qty, location), stock in/out, low-stock alerts, pick-pack for orders.

Hub & inter-city details (confirmed):
- Inter-city line-haul uses VIP buses and mini buses (not QCS vehicles). Each manifest records: bus company/station, driver name + phone, vehicle registration, bus waybill number, seal number, departure time, parcel list. Tracking between hubs is by scan events only (handed to bus → arrival scan at destination hub), no live GPS.
- Labels: QR waybill labels are printed in the hub office when parcels arrive, not by vendors. Each hub needs a thermal label printer.
- Before a parcel has a label (at pickup), the rider confirms it in the Rider app by scanning or entering the order code; the hub then prints and attaches the QR label on scan-in. Express orders that never pass through a hub do not need a label.
- Fulfilment pricing (common model, all rates editable in admin per hub): monthly storage fee (per item or per shelf/bin space) + pick-pack fee per order, billed to the vendor wallet.
- Fulfilment customer service: QCS Customer Support staff call and chat (WhatsApp) the vendor's customers on the vendor's behalf (order confirmation, delivery updates, questions). Agents work from the Ops dashboard, see only the orders of the vendors who bought this service, and every call/chat is logged against the order and visible to the vendor.
  - Messages and calls come from the QCS number, worded "QCS on behalf of <vendor name>". No per-vendor WhatsApp numbers.
  - Charged as a flat fee per delivered order (rate editable in admin), billed to the vendor wallet.

### 12. CRM (inside ops dashboard)
- Customer & vendor 360 profile: orders, spend, COD, complaints, notes, tags, account manager.
- Leads pipeline for vendor acquisition (New → Contacted → Trial → Active → Churn risk).
- Support tickets linked to orders, with SLA timers, assignment, internal notes, canned replies; tickets can be opened from the client app, WhatsApp or by support staff.
- Segments + broadcast campaigns (SMS/WhatsApp/push) to vendor or customer groups.
- Churn alerts: vendor whose weekly volume drops > X%.

CRM details (confirmed, all editable in admin):
- Churn alert: flag a vendor when this week's volume is 30% or more below their 4-week average.
- Support SLA: first reply within 1 hour, resolved within 24 hours (working hours). Tickets about COD money or lost/damaged parcels are top priority.
- Broadcasts: marketing messages only go to users who opted in (tick box at sign-up); every message has an unsubscribe option. WhatsApp marketing uses Meta-approved templates.

### 13. Non-functional
- Target 10,000+ deliveries/day; design indexes and Realtime channels accordingly.
- Rider app must work on low-end Android (2 GB RAM), poor network: queue status updates offline and sync later; compress photos.
- Location pings every 10–15 s while on a job, every 60 s while online and idle, none while offline.
- All money stored as integer pesewas. All times stored UTC, displayed Africa/Accra.
- Seed data for Accra, Kumasi, Takoradi, Tamale zones.
- Every phase ends with: migrations, RLS policies, seed data, tests, and a short README section explaining how to run it.
