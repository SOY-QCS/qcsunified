# QCS Unified

The QCS Ghana delivery platform: Express, e-commerce/bulk, inter-city and fulfilment in one system.
The full product brief and rules are in [`CLAUDE.md`](./CLAUDE.md).

## What's in the box

```
apps/
  client-mobile    Expo app — customers and vendors
  rider-mobile     Expo app — riders, plus Hub mode for hub handlers
  ops-dashboard    Next.js — operations, CRM, finance (QCS orange #df6518)
  client-portal    Next.js — vendors on a laptop: bulk upload, statements
  website          Next.js — public site, tracking, rate calculator
packages/
  mobile           shared phone-app pieces: login screen, buttons, photo upload
  config           shared constants + TypeScript settings
  types            shared types and validation (mirrors the database enums)
  pricing          the ONLY place prices are calculated
  api-client       one Supabase client for every app
  ui               colours and spacing shared by web and mobile
supabase/
  migrations/      the database, built step by step
  seed.sql         sample cities, zones, hubs and prices
  functions/       server functions (send-sms-hook: login codes via Hubtel)
  templates/       staff invite and password-reset emails
  tests/           database tests (roles, money, status rules, onboarding)
```

## Phase 1 — Foundations

### First-time setup (on your computer)
1. Install [Node.js 22](https://nodejs.org), then `corepack enable` (gives you pnpm).
2. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it — local Supabase runs inside it.
3. In this folder: `pnpm install`

### Run the database locally
```bash
pnpm db:start     # starts Supabase in Docker, applies migrations + seed data
pnpm db:test      # runs the database tests (119 checks)
pnpm db:reset     # wipe and rebuild the local database from migrations + seed
pnpm db:stop
```
`db:start` prints a **Studio URL** (a web page to browse the tables) and the local API keys.

### Run the code checks
```bash
pnpm test         # pricing engine + type tests
pnpm typecheck    # TypeScript across all apps
pnpm build        # builds the three web apps
```

### Run an app
```bash
pnpm --filter @qcs/ops-dashboard dev     # http://localhost:3000
pnpm --filter @qcs/rider-mobile dev      # scan the QR code with Expo Go
```
The apps are placeholders in Phase 1; screens arrive in later phases.

### Push the database to your Supabase cloud project
```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies migrations (NOT seed.sql)
```
The seed file is sample data for local testing. Real zones and prices are set in the Ops dashboard.

### Notes
- Sample zones are rough rectangles and sample prices are placeholders — redraw and re-price before launch.
- Database tests can also run on plain Postgres + PostGIS without Docker:
  `PLAIN_PG=1 DB_URL=postgresql://postgres@localhost/postgres pnpm db:test`

## Phase 2 — Sign-in and onboarding

| Who | How they sign in | After signing in |
|---|---|---|
| Customers & vendors (app, portal) | Phone number + 6-digit SMS code | New users choose **Personal** or **Business** (business name, category, pickup pin, ID photo) |
| Riders (rider app) | Phone number + SMS code | 7-step application → **Pending** → **Approved / Rejected** by a City/Super Admin |
| Hub handlers (rider app) | Phone number + SMS code | Hub mode only |
| Ops staff (dashboard) | Email or phone + password, optional 2FA app | Menu shows only what their role allows |

### Try it locally
1. `pnpm db:start` — local Supabase. Test phones **+233 20 000 0001/2/3** always get code **123456** (no SMS sent).
2. Copy `.env.example` to `.env.local` in each app and fill in the keys printed by `db:start`.
3. Run an app:
   - `pnpm --filter @qcs/ops-dashboard dev` → http://localhost:3000
   - `pnpm --filter @qcs/client-portal dev` → http://localhost:3001
   - `pnpm --filter @qcs/client-mobile dev` / `pnpm --filter @qcs/rider-mobile dev` → scan the QR code with Expo Go
4. First Super Admin: sign up any account, then in Supabase Studio run
   `insert into user_roles (user_id, role) values ('<their user id>', 'super_admin');`
   From then on, invite staff from **Staff & roles**. Invite emails are visible locally in Mailpit (URL printed by `db:start`).

### Going live: Hubtel SMS for login codes
1. In Hubtel, get **SMS API** client ID/secret and an approved **sender ID** (e.g. `QCS`).
2. Deploy the function: `npx supabase functions deploy send-sms-hook --no-verify-jwt`
3. Supabase dashboard → **Authentication → Hooks → Send SMS hook** → HTTPS → URL
   `https://<project-ref>.supabase.co/functions/v1/send-sms-hook` → generate the secret.
4. `npx supabase secrets set SEND_SMS_HOOK_SECRET='v1,whsec_…' HUBTEL_SMS_CLIENT_ID=… HUBTEL_SMS_CLIENT_SECRET=… HUBTEL_SMS_SENDER_ID=QCS`
5. Supabase → **Authentication → Providers → Phone**: enable. Turn on **Authenticator app (TOTP)** under MFA.
6. Supabase → **Authentication → SMTP**: use Resend (`smtp.resend.com`, port 465, user `resend`, password = Resend API key).
7. Supabase → **Authentication → Email templates**: paste `supabase/templates/invite.html` and `recovery.html`.
8. Supabase → **Authentication → URL configuration**: site URL = your ops dashboard URL; add the portal URL and `qcs-client://`, `qcs-rider://`.

### Tests
```bash
pnpm test             # role rules, pricing, types
pnpm functions:test   # SMS hook (needs Deno: npm i -g deno)
pnpm db:test          # 119 database checks
pnpm --filter @qcs/ops-dashboard build && pnpm --filter @qcs/ops-dashboard start &
pnpm --filter @qcs/ops-dashboard e2e   # browser smoke test of login pages
```

## Phase 3 — Pricing and booking

**Where prices come from:** `packages/pricing` (the only place prices are calculated) using the rules admins edit in
**Ops dashboard → Pricing**: Express fees, weight surcharges, fragile/night surcharges, surge and night hours,
e-commerce zone prices, inter-city lanes, flat-rate offers and the same-day cut-off per city.

**How a booking works**
1. The app or portal sends the booking details to `POST /api/v1/quotes` (business portal server).
2. The server checks them, finds each drop-off's zone, gets the motorbike road distance for Express (Google Routes API), prices it with `packages/pricing` and saves a **quote locked for 15 minutes**.
3. `POST /api/v1/bookings` with the quote id creates the orders (and a bulk trip with stops), tracking numbers (`ACC-202611041301-KUM`: pickup city, booking time, destination city), and saves every address to the address book.
4. Labels: `GET /api/v1/labels?orders=…&size=a6|4x6` → printable PDF with QR code.

**Bulk upload:** Business portal → Bulk upload. Template at `/api/v1/bulk-template`. CSV or .xlsx; every row is
checked, problems listed by row with a downloadable error report; more than 25 rows are split into trips of 25.

**Without Google keys** (local testing) the system still works: distances are estimated from a straight line
(× 1.35 at 22 km/h), address search shows saved addresses only, and bulk rows need latitude/longitude.

**Tests:** `pnpm test` (pricing 31, booking rules 39, quote + labels 11), `pnpm db:test` (157 checks).

### Tracking numbers, insurance and terms
- **Tracking number** = pickup city code - booking time (Accra, to the minute) - destination city code, e.g. `ACC-202611041301-KUM`.
  City codes are the first 3 letters of the name (Accra ACC, Kumasi KUM, Takoradi TAK, Tamale TAM) and can be changed in `cities.tracking_code` if two cities clash.
  A second parcel on the same route in the same minute gets `-02`, `-03`… so numbers never repeat.
- **Flat-rate offers** charge exactly the amount set.
- **Insurance**: items declared at GHS 1,000+ are offered insurance at 5% of the declared value (both editable in Pricing → Insurance by Finance).
  Insured parcels are refunded in full if damaged or missing. The premium is kept separate from the delivery fee (`orders.insurance_premium`) and promo codes never reduce it.
- **Terms & Conditions**: clients tick "I agree" at sign-up (app and portal); `accept_terms()` records the version and time. Set the real link in `app_settings.terms_url`.

## Phase 4 — Payments and wallets (Hubtel)

**How paying works**
| Who pays / how | When the order is CONFIRMED | When money moves |
|---|---|---|
| Card or MoMo (Hubtel checkout) | only after Hubtel's payment is verified | at payment |
| Customer wallet | at booking | at booking (promo credit first, then balance) |
| Business wallet | at booking | delivery fee per successful delivery; 50% if returned; insurance at booking |
| Corporate invoice / cash / recipient pays | at booking | later (invoicing / rider cash phases) |

**Hubtel callbacks aren't signed by Hubtel**, so the server never trusts one on its own:
1. our callback address carries a secret token (`HUBTEL_CALLBACK_TOKEN`),
2. the payment must match one we created — same reference, checkout id and exact amount,
3. if `HUBTEL_STATUS_URL` is set, we ask Hubtel directly before crediting,
4. every message is stored once; repeats change nothing.
A scheduled job (`/api/v1/payments/reconcile`, every 5 minutes) catches payments whose callback never arrived, and cancels card/MoMo orders unpaid after 60 minutes.

**Refunds:** cancelled paid orders → automatic refund to the wallet. Returned → 50% back. Finance can refund any amount up to what was charged (Ops → Finance).
**Withdrawals:** customers can send wallet cash back to the MoMo number they topped up with; Finance approves; Hubtel sends it.
**Referrals:** everyone has a code (e.g. `QCSAB12C`); a new customer enters a friend's code at sign-up; after their first delivery both get GHS 10 promo credit (editable). Credit is spend-only.
**Statements:** Business portal → Wallet → PDF or CSV for any date range.

**Testing without Hubtel:** set `DEV_FAKE_PAYMENTS=1` (local only) — checkout opens a test page with "Pay" / "Decline" buttons.

**Tests:** `pnpm db:test` (227 checks incl. 50+ money checks), `pnpm test` (Hubtel client 13, callback handling 7, statements 3, …).

## Phase 5 — Dispatch and the rider app

**How a job finds a rider.** When an Express order is confirmed, the database makes a trip and starts
dispatch. Every 5 seconds a scheduled database job (`dispatch_tick`) offers waiting jobs to the
nearest free, online, eligible rider (right city, vehicle, weight, documents valid, no unremitted cash from
yesterday). Riders have no cash-on-delivery limit unless Ops sets one for a particular rider.
The rider has 20 seconds. Reject or no answer → next nearest rider, and it counts against the rider's
score. After 5 misses (about 2 minutes) the job appears on **Ops dashboard → Dispatch** under
"Needs a dispatcher", where it can be assigned by hand or offered again. A rider can only hold one job.

**Rider app.** Go online (location sharing starts, with the "QCS is tracking your trip" notification) →
job card with a countdown → Accept → Navigate (opens Google Maps) → Arrived → confirm/scan each
parcel → Picked up → drop-offs listed nearest first (the rider can tap any) → at the door: 4-digit
code, signature, photo (if the vendor asked for one), cash collection for COD → Delivered.
"Delivery failed" asks for a reason. If the recipient has no code, the rider takes a photo and asks
for an override, which Dispatch or Support approve on the Dispatch page. With no signal, every step
is saved on the phone and sent automatically later, with the time it really happened.

**WhatsApp backup.** A rider with no data can WhatsApp `DELIVERED ACC-202611041301-KUM 1234` to the
QCS number. It only works from the rider's registered phone, for a parcel on their own job, with the
right code. Because there's no signature, these deliveries show on the Dispatch page under
"Deliveries to check" until someone confirms them.

### Try it locally
```bash
pnpm --filter @qcs/rider-mobile start     # Expo Go works for screens; background location needs a dev build
pnpm --filter @qcs/ops-dashboard dev      # http://localhost:3000/dispatch
```
Background location and the foreground notification need a development build
(`eas build --profile development --platform android`); Expo Go can't run them.

### Going live
1. **Scheduler.** `dispatch_tick` is scheduled by the migration with pg_cron (Supabase → Integrations → Cron must be on).
2. **WhatsApp webhook.** `supabase functions deploy whatsapp-webhook`, set the `WHATSAPP_*` secrets
   (see `.env.example`), then in Meta → WhatsApp → Configuration set the callback URL to
   `https://<project>.supabase.co/functions/v1/whatsapp-webhook`, the verify token, and subscribe to `messages`.
3. **Optional Google road-time ranking** (off by default; costs about one Routes API call per job):
   deploy `dispatch-rank`, set `GOOGLE_MAPS_SERVER_KEY` and `DISPATCH_RANK_SECRET`, then in the SQL editor:
   ```sql
   select vault.create_secret('<DISPATCH_RANK_SECRET>', 'dispatch_rank_secret');
   select cron.schedule('dispatch-rank', '5 seconds', $$
     select net.http_post('https://<project>.supabase.co/functions/v1/dispatch-rank',
       headers := jsonb_build_object('x-qcs-secret',
         (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_rank_secret')))
     where exists (select 1 from public.trips_to_rank())$$);
   update public.app_settings set value = 'true' where key = 'dispatch_google_ranking' and city_id is null;
   ```
   If Google is slow or down, dispatch waits at most 4 seconds and then uses straight-line distance.
4. **App stores.** Google Play and Apple ask why the app uses background location. Suggested text:
   "QCS Rider shares the rider's location only while they are online or on a delivery, so we can send
   them nearby jobs and show customers where their parcel is. Tracking stops when they go offline."

### Tests
`supabase/tests/50_dispatch.sql` (nearest rider, cascade, escalation, one-job rule, codes, COD,
offline replay, WhatsApp, overrides), `packages/types/src/rider.test.ts` (stop ordering, offline
queue) and `supabase/functions/tests/` (WhatsApp signature check, Google ranking).

## Phase 6 — Live tracking and notifications

**Tracking.** Anyone with a tracking number sees the status and history at `/track/<number>` on the
website. The map, rider (first name, photo, plate, rating, Call / WhatsApp) and arrival estimate
appear after typing the **last 4 digits of the recipient's phone** — or straight away for the signed-in
sender (client app, business portal → Orders → tracking number). 10 wrong guesses lock the details
for an hour. The rider's number is shown only while they are on the way. Screens refresh every
10 seconds, which matches how often riders send their position. Arrival times are estimated for free
(straight-line distance × 1.4 at 20 km/h, editable).

**Recipient confirms the address.** On booking, the recipient gets an SMS link to `/c/<code>` on the
website (no login). They tap "Yes, this is correct" or drag the pin / use their location and add a
landmark. Express pins moved more than 1 km are re-priced by the pricing engine; the sender is told the
extra, collected on delivery. The rider's route updates automatically. Bulk/inter-city stops still
unconfirmed are listed on Ops → Dispatch.

**Notifications.** Every status change queues messages automatically:
- *Sender:* app notification + WhatsApp by default; SMS and email if they switch them on (Client app → Notification settings).
- *Recipient:* SMS (or WhatsApp, or both — Ops → Messages).
- Delivery codes and price changes are always sent.
Ops → **Messages** shows every message's wording (Super Admin can edit), recipient channels, and what
was sent or failed recently. The `send-notifications` Edge Function delivers them (Expo push, Hubtel
SMS, WhatsApp template, Resend email), retries failures 3 times, and wipes delivery codes once sent.

**Ratings.** After delivery the sender rates the rider (1–5 stars + quick tags); the rider's rating is the
average of their last 100. 1–2 stars alert Support. Riders rate the pickup right after collecting.

### Going live
1. **Sender schedule** (SQL editor, after deploying `send-notifications` and setting `NOTIFY_SECRET`):
   ```sql
   select vault.create_secret('<NOTIFY_SECRET>', 'notify_secret');
   select cron.schedule('send-notifications', '10 seconds', $$
     select net.http_post('https://<project>.supabase.co/functions/v1/send-notifications',
       headers := jsonb_build_object('x-qcs-secret',
         (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret')))
     where exists (select 1 from public.notifications where status = 'queued' and next_attempt_at <= now())$$);
   update public.app_settings set value = '"https://<your website>"' where key = 'public_site_url';
   ```
2. **Push:** run `eas init` in each phone app once (gives the project id push needs). Push doesn't work in Expo Go.
3. **WhatsApp templates:** in Meta Business → WhatsApp → Message templates, create `qcs_rider_assigned`,
   `qcs_delivered`, `qcs_failed_attempt`, `qcs_address_confirm`, `qcs_on_the_way` (category *Utility*) with the
   wording shown on Ops → Messages, each `{{…}}` replaced by `{{1}}`, `{{2}}`… in order.
4. **Maps:** enable *Maps JavaScript API* and set `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (restrict to your sites).
   Without it, pages show an "Open in Google Maps" link instead of a map.

### Tests
`supabase/tests/60_tracking_notifications.sql` (fan-out, preferences, privacy of tracking, brute-force lock,
pin correction, sender worker, ratings), `supabase/functions/tests/send-notifications.test.ts`,
`apps/client-portal/src/server/tracking.test.ts` (re-pricing a moved pin), `packages/types/src/tracking.test.ts`.

## Phase 7 — Operations dashboard

Everything below respects cities: a City Admin, Dispatcher or Support agent sees and changes only their
own city (the database enforces it, not just the screens). Super Admin, Finance and Analysts see all.

| Page | What it's for |
|---|---|
| **Overview** | Today's numbers: booked, delivered, moving now, riders free / on a job, open exceptions. |
| **Live map** | Riders (green = free, orange = on a job, red = on a job with no signal, grey = offline) and parcels (purple = waiting for a rider, blue = with a rider, black = failed), hubs. Refreshes every 10 s. Click a dot to open it. |
| **Exceptions** | Jobs with no rider for 10+ min, late parcels (Express 90 min, e-commerce by 20:00 on pickup day, inter-city 72 h), failed attempts, unconfirmed addresses, riders over their cash limit or late remitting, riders on a job with no signal for 10 min. All limits are in Settings, per city. |
| **Orders** | Filter by stage, service, date; search tracking no., phone, name or vendor ref. "Needs a trip" lists single-drop e-commerce parcels: tick the ones from the same pickup → **Make a trip** sends them to riders. |
| **Trip page** | Assign; **reassign** (also after pickup, e.g. breakdown — reason required, both riders told); take the rider off; **split** parcels into a new trip; **merge** another trip in (same pickup within 300 m, max 25). |
| **Riders** | Status, online, rating, acceptance, cash held, documents expiring in 30 days. Rider page: performance for any dates, **earnings estimate**, suspend / reactivate / offboard (City/Super Admin, reason required), commission and cash limit (Admin/Finance), document review with expiry dates, ratings, trips. |
| **Vendors** | ID check, services, flags. Vendor page: volume vs 4-week average (churn risk), COD not yet paid out, wallet, pickup rating; controls — booking block / COD hold / payout schedule (**Finance only**), photo or pickup-code proof, customer service, fulfilment, account manager. Reason required, audit log. |
| **Hubs** | Address, map pin, opening hours, capacity, parcels in the hub now, staff. |
| **Cities & zones** | Draw zones on the map (click corners, drag to reshape, right-click a corner to remove). Super Admin adds cities. |
| **Settings** | Every operational setting: default + per-city value. |

**Rider pay** rates are in Settings → `rider_pay` (placeholders: fleet GHS 5 per trip pickup + GHS 8 per
delivered stop; independent 20% of delivery fees). Earnings and payouts: see Phase 8.

**Maps** need `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (Maps JavaScript API) in the dashboard's Vercel settings;
without it every page still works, just without the map.

### Tests
- `supabase/tests/70_ops_dashboard.sql`: city scoping, map states, exceptions, reassign/split/merge/plan, rider and vendor rules, zones, hubs, settings.
- `supabase/tests/api-check.sh`: runs every query and function call in the apps against the real Supabase API layer (PostgREST). It catches broken joins and misspelled columns.

## Phase 8 — Rider earnings, COD and payouts

Every cedi moves through the double-entry ledger (all wallets always add up to zero; the COD page warns if not).

**Rider earnings (automatic).**
- **QCS fleet:** a pickup fee once per trip, plus a fee per successful stop.
- **Independent riders:** their commission % of each delivery fee.

Paid at the moment of pickup or delivery, to whoever did it (after a reassignment the new rider is paid for
what they deliver). Each piece of work is paid once only. Finance adds **bonuses / deductions** with a reason on the rider's page.
Rates are in Settings → `rider_pay`, with per-city overrides.

**Rider app → My earnings & cash:** today and this week, job by job; cash being held for QCS, parcel by parcel;
**hand in by MoMo** (Hubtel checkout) or at the hub; MoMo number for payouts; **instant cash-out** (fee in Settings).

**COD cash path:** rider collects → hands in by MoMo (automatic) or at a hub (hub staff press "Received" on
Finance → COD cash) → Finance records the bank deposit → paid to the vendor in a payout batch. Vendors get
the full COD; their delivery fees stay in their separate fees wallet. Vendors with fees unpaid for 7+ days
have their COD payout put on hold automatically (and are notified).

**Payout batches (Finance → Payout batches).** Every morning at 06:00 the system *prepares* vendor COD
batches (daily vendors; weekly vendors on the payout day) and, on the rider payout day, the rider batch.
Preparing sets the money aside; **nothing is sent until a second Finance person approves** (the person who
prepared it can't approve it; Settings → `payout_two_person_rule`). Riders holding late COD cash are put on hold.
On approval each payout goes to Hubtel; Hubtel's callback marks it paid; a failed transfer puts the money
back in the wallet. If Hubtel isn't configured, approval is refused (nothing gets stuck).

**Exports (Finance → Export):** CSV ledger journal, payouts, COD and rider earnings for any dates.

### Tests
`supabase/tests/80_earnings_payouts.sql`: earnings, once-only pay, COD through the ledger, hand-in, banking,
two-person approval, holds, failed transfers, cash-out fees, reconciliation, exports, ledger balance.

## Phase 9 — Hubs, inter-city and fulfilment

**Inter-city booking is now live** (portal and API: service `intercity`, option `doorstep` or `hub_collection`).
Price = lane (origin hub → destination hub) by weight band, plus the doorstep fee if chosen.

**The journey of an inter-city parcel**
1. *First mile:* a rider collects from the sender and takes it to the origin hub ("Take to hub" on the job screen).
2. *Scan in* (Rider app → Hub mode): the hub prints the QR label (Ops → Hubs → hub desk → "Print labels").
3. *Bag:* open a bag for the destination, scan parcels into it, seal it, print the bag tag.
4. *Manifest:* add bags, fill in the bus details (company, vehicle reg, driver phone, waybill, seal) and
   press "Departed". The sender is notified.
5. *Arrival:* destination hub scans each bag; parcels inside are received. Closing the manifest checks
   that everything arrived — a note is required if anything is missing.
6. *Last mile:* hub desk → "Plan deliveries" creates a trip from the hub; handler scans parcels over to the
   rider ("Hand over"). Or, for hub collection, the recipient shows the code and signs in Hub mode.
Hub-stuck parcels (Settings `hub_stuck_hours`, 24 h) and late buses (`linehaul_expected_hours`, 12 h) show on the hub desk.

**Hub mode (Rider app).** Staff with the hub_handler role (linked to a hub on the Staff page) see only Hub
mode: scan in, bag, receive bus, hand over, collect, pick. Scanning is continuous (beeps/vibrates, ignores
double reads), works offline and syncs later; every scan is logged with who/when.

**Printing.** Labels, bag tags and manifests are PDFs sized for a 100×150 mm thermal printer (one per hub).

**Fulfilment (vendors with fulfilment turned on).**
- Vendor portal → **Stock**: add products, see what's at each hub (on shelf / reserved / available), movements and charges.
- Hub receives stock by scanning (Hub mode → Receive stock). Hub managers correct counts with a reason (audit log).
- Booking "Send from: My stock at hub" reserves the units; the hub picks (Hub mode → Pick) and packs
  (hub desk) — the pick-pack fee is charged then. Cancelled orders put the units back.
- Low stock: vendor gets a push + email when available stock reaches their "warn me at" level.
- Storage is billed on the 1st of each month (pg_cron) per unit in stock. Rates per hub on the hub desk
  (placeholders: pick & pack GHS 3.00 per order, storage GHS 0.50 per unit per month).

### Tests
`supabase/tests/90_hubs_fulfilment.sql`: full Accra → Kumasi journey (doorstep and hub collection),
bags, manifests, missing parcels, rider pay for both legs, stock receive/reserve/pick/pack, low-stock
alerts, cancellations, storage billing, vendor privacy.

## Phase 10 — CRM & support

Everything lives in **Ops dashboard → CRM & Support** (Support, City Admin, Super Admin; Analysts can look).

**Support tickets**
- Opened from: "Report a problem" on every delivery (client app, rider app, vendor portal), "Contact support" in Help,
  a WhatsApp message to the QCS number, or by staff logging a phone call / walk-in ("Log a call").
- Problem types set the priority: COD money and lost/damaged parcels are **urgent**; late, rider and address are high.
- SLA clock counts **working hours only** (Settings `support_hours`, Mon–Sat 8am–6pm): first reply within 1 hour,
  solved within 24 hours. Overdue tickets turn red and the agent (or the city's support team) gets a push.
- Agents reply (push to the customer, or WhatsApp/SMS for people without the app), write internal notes the customer
  never sees, use canned replies, assign, change status/priority (audited with a reason). The customer can reply and
  attach photos; replying reopens a solved ticket. Solved tickets close after 7 days.

**WhatsApp inbox.** Messages to the QCS number become tickets (photos/PDFs are kept privately); follow-up messages join
the same conversation; a tracking number in the text links the delivery; words like "damaged" or "COD" set the problem
type. Riders' `DELIVERED …` commands still work. **STOP** opts out of offers, **START** opts back in.
Agents answer in free text within 24 hours of the customer's last message; after that WhatsApp only allows our
approved template.

**360 profiles.** Customers (CRM → Customers) and vendors (Vendors → vendor) show orders, spend, COD, complaints,
wallet, rating, tags, account manager and a notes timeline.

**Leads pipeline** (New → Contacted → Trial → Active → Churn risk, plus Lost). A lead that signs up as a vendor with the
same phone is linked automatically and moves to Trial; Trial → Active after 5 deliveries.

**Churn alerts** (every morning, 05:30): vendor flagged when this week is 30%+ below their 4-week average
(only vendors averaging 5+ a week). Their account manager is notified; handling an alert needs a note.

**Campaigns.** Build a segment (customers or vendors; city, recent/inactive, order count, service, tags, stage), see how
many people it reaches per channel, write the message, choose push / SMS / WhatsApp / email. Support prepares;
**an Admin approves and sends**. Only people who ticked "send me offers" are ever included, and each message carries an
opt-out (link to `/u/<code>` on the website for SMS/email, STOP on WhatsApp). People who opt out after sending started are skipped.

**Customer service for vendors** (§11, vendors with the service switched on): agents see only those vendors' open orders,
log calls/chats, and message the vendor's customer as "QCS on behalf of <vendor>". The vendor sees every contact on the
order in the portal. Fee per delivered order: Settings `cs_fee_per_order` (placeholder GHS 2.00), billed to the vendor wallet.

**Help centre.** Articles edited in CRM → Help centre appear in both apps, the vendor portal (`/help`) and the website (`/help`).

**Before going live:** ask Meta to approve two WhatsApp templates — `qcs_support_reply` (support replies after 24 h) and
`qcs_on_behalf_of` (customer service messages) — plus any offer templates you want to use in campaigns.

### Tests
`supabase/tests/100_crm_support.sql` (116 checks): working-hours clock, reporting problems (own orders only, duplicates
merged), privacy, internal notes, reopen/close, SLA alerts, WhatsApp inbox (auto-reply, follow-ups, photos, retries,
STOP/START, rider commands), 360 profiles, leads + automatic linking, churn alerts + recovery, segments (opt-in only),
campaign approval and sending, unsubscribe, help articles, customer-service log and fee. Edge Function tests cover
WhatsApp photos/names and free-text replies (`pnpm functions:test`).

## Phase 11 — Business API & integrations

**Public REST API** for vendors at `https://<portal>/api/business/v1` (code: `apps/client-portal/src/app/api/business/v1`,
logic in `src/server/business/`). Docs: `/docs/api` (public) and `/api/business/v1/openapi.json` — both generated from
the same Zod schemas the server validates with (`packages/types/src/business-api.ts`), so docs and code can't drift.

| Call | What it does |
| --- | --- |
| `POST /rates` | Prices for a checkout page (every service that can deliver there). Nothing saved. |
| `POST /quotes` | Exact price for one delivery, held 15 minutes. |
| `POST /deliveries` | Book from `{quote_id}` or with the full details. `Idempotency-Key` header = never book twice. |
| `POST /deliveries/bulk` | Up to 100. Each succeeds/fails on its own (201 / 207 / 400). Same-city drop-offs share trips (≤ 25). |
| `GET /deliveries/{id}` | By tracking number or your own order number; includes history. |
| `GET /deliveries` | Newest first; filter by status, dates, reference; `before` for the next page. |
| `POST /deliveries/{id}/cancel` | Before pickup only (same rule as the app); refunds follow. |
| `POST /deliveries/{id}/simulate` | Test keys only: move a practice delivery and fire its webhook. |
| `GET /me` | Which business/mode the key belongs to ("Test connection"). |

- **Keys**: `qcs_test_…` (practice deliveries: real prices, but nothing is dispatched or charged; kept apart from real orders)
  and `qcs_live_…` (needs the business ID check). Shown once, stored only as a SHA-256 hash; revocable.
- Addresses may be **text** (Google geocoding, falls back to the town and says so) or `lat`/`lng`. Bookings use the same
  rules, pricing engine and `create_booking` as the app; the recipient still gets the confirm-your-location link.
- 120 requests/minute/key (Settings `api_rate_per_minute`). Every call is logged (30 days) and answers with `QCS-Request-Id`.
- Errors: `{"error": {"code", "message", "details"}}`.

**Webhooks**: every status change of a vendor's deliveries is queued for their endpoints (test events → test endpoints).
`QCS-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`. Retries after 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, 24 h;
an endpoint that keeps failing is turned off and the vendor is emailed. Sent by the `send-webhooks` Edge Function — schedule it
like `send-notifications`:
```sql
select cron.schedule('send-webhooks', '10 seconds', $$
  select net.http_post('https://<project>.supabase.co/functions/v1/send-webhooks',
    headers := jsonb_build_object('x-qcs-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret')))
  where exists (select 1 from public.webhook_deliveries where status = 'queued' and next_attempt_at <= now())$$);
```

**Portal → Developers**: create/revoke keys (live after ID check), webhook endpoints (secret, test event, turn on/off,
new secret), recent webhook messages with resend, API request log, and the integrations.

**WooCommerce plugin** (`integrations/woocommerce/qcs-ghana-shipping`, downloadable from the portal as a zip that the portal
build makes): "QCS Ghana" shipping method with live rates; books the delivery when an order is paid (Processing) — COD orders
send the order total as COD; tracking number on the order; status updates as order notes (signed webhook at
`/wp-json/qcs/v1/webhook`), completes delivered orders. Manual "Book QCS delivery" order action for retries.

**Shopify app** (routes in the portal under `/api/integrations/shopify/`, setup in `integrations/shopify/README.md`):
vendor connects from Developers → Shopify sign-in; live rates via CarrierService (needs carrier-calculated shipping on the
merchant's plan); paid orders (COD orders when placed) become deliveries; order tagged `QCS <tracking>`; uninstall and GDPR
webhooks handled. Needs `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` from a free Shopify Partner account.

**Fix**: the portal's sign-in guard didn't recognise `/api` as public, so signed-out callers (Hubtel callbacks, the phone
apps, the website's tracking lookups) were redirected to the login page. Now `/api`, `/pay` and `/docs` are public
(each API route checks its own caller).

### Tests
`supabase/tests/110_business_api.sql` (90 checks): keys, log, rate limit, idempotency, delivery object, get/list/cancel,
test mode, webhook queueing/retries/auto-off/SSRF guard, Shopify data privacy. `apps/client-portal/src/server/business/core.test.ts`
and `src/server/integrations/shopify.test.ts` (25), `supabase/functions/tests/send-webhooks.test.ts`,
`pnpm integrations:test` (WooCommerce helpers; same signature test vector as the sender, openssl and PHP).

## Phase 12 — Analytics & reports

**Ops dashboard → Analytics** (Super Admin, City Admin — own city only, Finance, Analyst, Hub Manager — own city).
Filters in one row: city, period (last 7/30/90 days, this/last month, or exact dates), service; they live in the address bar.
- **Overview**: orders, delivered, success rate (delivered ÷ delivered + returned), on-time %, revenue (fees earned),
  average Express pickup time and pickup→delivery time, failed attempts — each compared with the previous period;
  orders per day by service; revenue per day; why deliveries failed; COD money not yet with vendors (with riders,
  overdue, held by QCS); table by city and by service.
- **Riders**: deliveries, failed attempts, trips, online hours, hours on a job, utilisation (on a job ÷ online), earnings,
  offer acceptance, rating. Online time is recorded from this phase on (`rider_shifts`).
- **Vendors**: ranking by orders with change vs the previous period, success rate, revenue, COD.
- **Demand map**: drop-offs per ~550 m square over the zone outlines (no paid map service), plus orders per zone.
- **Email reports**: daily (yesterday), weekly (Mondays), monthly (the 1st) at 06:15 Accra, by email; Super Admins can
  set them up for other staff. Each report covers a period once only.

**Client portal → Analytics** (vendors): orders, delivered, success rate, on time, average booking→delivered time,
orders per day, failure reasons, where orders go, by service; spend, COD collected/paid out/on its way and other fees
only for the owner and staff with wallet access.

**How it works**: `order_facts` keeps one row per booked delivery (time of each step, outcome, on-time verdict), updated
by a trigger on every status change, so reports don't scan the full history (10,000+ deliveries a day). Existing orders
were back-filled. On time (Settings, editable): Express within 90 min of booking; e-commerce by 21:00 on its pickup day;
inter-city within 48 h (ready at the hub, for hub collection). Charts are plain SVG in `@qcs/ui/web` (no new dependency),
with hover tooltips, legends and a "Show as table" view; service colours were checked for colour-blind separation.

### Tests
`supabase/tests/120_analytics.sql` (49 checks, every number worked out by hand from 8 known deliveries): facts, on-time,
averages, success rate, revenue, previous period, per city/service, failure reasons, COD outstanding, rider utilisation,
vendor ranking, heatmap, who may see what, vendor money privacy, scheduled reports. `packages/types/src/period.test.ts`.
