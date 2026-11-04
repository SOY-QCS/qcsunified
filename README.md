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
