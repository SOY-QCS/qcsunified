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
