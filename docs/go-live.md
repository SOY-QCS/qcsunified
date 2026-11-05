# Going live: setting up QCS from zero

One runbook for the whole platform. Do it **twice**: first for **staging** (a full practice copy with fake payments), then for **live**. Everything you do on live, you have already done once on staging.

When an environment is done, this command checks it end to end:

```bash
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… PORTAL_URL=… OPS_URL=… SITE_URL=… pnpm check:deploy
```

It prints ✅ or ❌ for each piece, with what to do for every ❌.

## 0. Accounts and what they cost

| Service | Used for | Cost (check current prices) |
|---|---|---|
| Supabase | database, logins, files, Edge Functions | **Live: Pro plan** (about US$25 a month; daily backups, no pausing when quiet). Staging: free plan is enough. |
| Vercel | the three websites | Vercel's free *Hobby* plan is for personal, non-commercial use only. A company needs **Pro** (about US$20 per team member per month); one member is enough. |
| Expo (EAS) | building the apps, quick fixes | Free plan to start; it limits monthly builds and update users (expo.dev/pricing). |
| Google Play / Apple | app stores | US$25 once / US$99 a year (see `docs/release-mobile.md`) |
| Google Cloud | Maps, address search | pay per use, with a monthly free credit; set a budget alert |
| Hubtel | payments, payouts, SMS | per transaction / per SMS |
| Meta (WhatsApp Cloud API) | WhatsApp messages | per conversation; templates need approval |
| Resend | email | free up to a monthly limit |
| UptimeRobot (or similar) | "is the site up?" checks | free plan |
| A domain (e.g. qcsghana.com) | addresses | yearly |

The paid platform choices (Supabase Pro, Vercel Pro) cost about US$45 a month together. Everything else is pay-as-you-use.

Suggested addresses: `qcsghana.com` (website), `portal.qcsghana.com` (business portal and API), `ops.qcsghana.com` (dashboard). For staging, use the same names with `staging-` in front.

## 1. Supabase project

1. supabase.com → **New project**: name `qcs-live` (or `qcs-staging`), a strong database password (save it in your password manager), and the region closest to Ghana that Supabase offers.
2. **Database → Extensions:** turn on **postgis**, **pg_cron** and **pg_net**, *before* step 2.
3. **Authentication → Sign In / Providers → Phone:** turn on. **Authentication → Hooks → Send SMS hook:** point it at the `send-sms-hook` Edge Function (step 3) and copy the hook secret (used as `SEND_SMS_HOOK_SECRET` in step 3).
4. **Authentication → Rate Limits:** SMS sent per hour = **1000**.
5. **Authentication → URL Configuration:** Site URL = the portal address; add the dashboard address and `<dashboard>/auth/callback` to Redirect URLs.
6. **Staging only:** in Authentication → Phone → *Test phone numbers and OTPs*, add the test numbers (e.g. `233200000001=123456`).

## 2. Database

From your computer, in the project folder:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>        # the id in the project's address
npx supabase db push                                  # builds every table, rule and function
psql "<connection string>" -f supabase/seed.sql       # starting cities, zones, hubs, prices
```

The seed's zone shapes, hub locations and prices are **samples**. Before launch, Ops redraws the zones (Cities & zones) and Finance sets the real prices (Pricing). Supabase → Project settings → Database → Connection string gives you the address for `psql`; or paste `seed.sql` into the SQL editor instead.

## 3. Edge Functions (messages, webhooks, SMS codes)

```bash
npx supabase functions deploy send-notifications
npx supabase functions deploy send-webhooks
npx supabase functions deploy send-sms-hook --no-verify-jwt
npx supabase functions deploy whatsapp-webhook --no-verify-jwt
# optional, only with Google road-time ranking:  npx supabase functions deploy dispatch-rank
npx supabase secrets set NOTIFY_SECRET=<long random> SEND_SMS_HOOK_SECRET=<from step 1.3> \
  HUBTEL_SMS_CLIENT_ID=… HUBTEL_SMS_CLIENT_SECRET=… HUBTEL_SMS_SENDER_ID=QCS \
  WHATSAPP_TOKEN=… WHATSAPP_PHONE_NUMBER_ID=… WHATSAPP_APP_SECRET=… WHATSAPP_VERIFY_TOKEN=<long random> WHATSAPP_API_VERSION=v21.0 \
  RESEND_API_KEY=… EMAIL_FROM="QCS Ghana <no-reply@qcsghana.com>"
```

"Long random" means at least 32 random characters: `openssl rand -hex 32`. Never reuse a value between staging and live.

## 4. Scheduled jobs

1. **Project settings → Vault → New secret**, four of them (exact names):

| Name | Value |
|---|---|
| `project_url` | `https://<project-ref>.supabase.co` |
| `notify_secret` | the same value as `NOTIFY_SECRET` above |
| `portal_url` | the portal address, e.g. `https://portal.qcsghana.com` |
| `cron_secret` | a new long random value; also used as `CRON_SECRET` in step 5 |

2. **SQL editor:** paste and run `supabase/setup/schedule-jobs.sql`. It registers all 18 jobs and lists them at the end. Running it again is safe.

## 5. The three websites (Vercel)

Import the GitHub repository three times, once per app. Set **Root Directory** to `apps/client-portal`, `apps/ops-dashboard` and `apps/website`. Vercel finds Next.js and pnpm by itself. Then add the settings (Project → Settings → Environment Variables) and the domain (Settings → Domains).

| Setting | Portal | Ops dashboard | Website |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✔ | ✔ | ✔ |
| `SUPABASE_SERVICE_ROLE_KEY` (**secret**) | ✔ | ✔ | |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (restricted to your domains) | ✔ | ✔ | ✔ |
| `GOOGLE_MAPS_SERVER_KEY` | ✔ | | |
| `HUBTEL_API_ID`, `HUBTEL_API_KEY`, `HUBTEL_MERCHANT_ACCOUNT`, `HUBTEL_CALLBACK_TOKEN` | ✔ | ✔ (payouts) | |
| `CRON_SECRET` (same as the Vault `cron_secret`) | ✔ | | |
| `PUBLIC_API_URL` (the portal address) | ✔ | | |
| `OPS_DASHBOARD_URL` | | ✔ | |
| `NEXT_PUBLIC_API_URL` (the portal address) | | | ✔ |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` (when the Shopify app is ready) | ✔ | | |
| `DEV_FAKE_PAYMENTS=1` | **staging only** | | |

`.env.example` explains each one. **Never** set `DEV_FAKE_PAYMENTS` on live.

## 6. First people and settings

1. In Supabase → Authentication → Users → **Add user** (email + password): your own account.
2. SQL editor: `insert into user_roles (user_id, role) values ('<your user id>', 'super_admin');`
3. Sign in to the dashboard. In **Settings**, set `public_site_url` and `ops_dashboard_url` to the real addresses. Leave `app_min_version_…` at `1.0.0` for now. Turn on two-step sign-in (My account & 2FA).
4. Invite the team from **Staff & roles**.
5. Bring over existing clients and riders: `pnpm import:people …` (dry run first; see the README).

## 7. Outside services

- **Hubtel:** callback URL `https://portal.qcsghana.com/api/v1/payments/hubtel/callback?token=<HUBTEL_CALLBACK_TOKEN>`. Ask Hubtel to enable send-money (payouts) on the merchant account.
- **Meta (WhatsApp):** webhook `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to *messages*. Submit the message templates for approval.
- **Resend:** verify the `qcsghana.com` sending domain.
- **Google Cloud:** restrict each key (browser key → your domains; server key → Maps APIs only; Android key → `gh.qcs.client`). Set a monthly budget alert.

## 8. Watching it

- **System health** (Ops dashboard) shows whether anything is quietly broken: messages not sending, payments not confirmed, jobs not running, jobs without riders. Red problems are emailed to Super Admins every 10 minutes' check, at most every 3 hours per problem.
- **UptimeRobot** (free): add three HTTP monitors every 5 minutes:
  - `https://portal.qcsghana.com/api/health`. This one answers 503 both when the portal or database is down **and** when a System-health check is red, so an alert here means "open System health".
  - `https://ops.qcsghana.com/login`
  - `https://qcsghana.com/`

  Send the alerts to your email and phone.
- **Backups:** the Pro plan keeps daily backups (Database → Backups). Point-in-time recovery is a paid add-on; consider it once real money flows.

## 9. The apps

Follow `docs/release-mobile.md`. Per environment:

- the *preview* builds point at staging, the *production* builds at live (EAS environment variables);
- run `eas update:configure` once in each app folder, so quick fixes can be published.

**A quick fix** (JavaScript only, no new native module) reaches phones without a store review. Phones download it in the background and use it the next time the app opens:
```bash
cd apps/rider-mobile && eas update --channel production --message "Fix: delivery button on small screens"
```

**A forced update:** after a new store version is out, raise `app_min_version_rider` (or `_client`) in Settings. Older apps then show "Please update", with a link to the store. Set `app_latest_version_…` to show a gentle "update available" instead. Write the store links in `app_store_url_…` once the apps are live.

## 10. Launch day and bad days

- **Something outside our control breaks** (Hubtel down, flooding, hub closed): Ops → Cities & zones → **Pause bookings** in that city, with a message. It shows at the top of the apps and portal, and bookings already made carry on. A general message for everyone goes in Settings → `app_notice`.
- **A website change went wrong:** Vercel → Deployments → the previous one → **Instant rollback**.
- **An app quick fix went wrong:** publish the previous version again (`eas update:republish`), or roll back on expo.dev → Updates.
- **A database change went wrong:** never edit the live database by hand. Fix it with a new migration, tested on staging. Worst case, restore yesterday's backup (Database → Backups), which loses today's data, so it is the last resort.

## 11. Every change after launch

1. Make the change in the code. **GitHub runs all the tests automatically** on every push (`.github/workflows/ci.yml`). A red ✗ means don't ship.
2. Staging first:
   - `npx supabase db push` against staging if there are migrations;
   - Vercel builds the staging sites;
   - `eas update --channel preview` for app changes.
3. Click through the change on staging.
4. Then the same against live.
