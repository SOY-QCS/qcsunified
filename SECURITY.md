# Security — QCS Unified

Phase 13 security review (November 2026): what was checked, what was fixed, and what protects the platform.
The automated test `supabase/tests/130_security.sql` repeats the structural checks on every test run, so a future change that reopens a hole fails the tests.

## How access works (one paragraph)

Phones and websites talk to the database through Supabase with a login token. **Row Level Security (RLS)** is on for every table: the database itself decides, row by row, what each person may see or change (a rider sees their jobs, a vendor their orders, a City Admin their city). Anything that moves money or changes status goes through database functions that check *who is calling* first and write the audit log. Server code holding the all-powerful "service role" key exists only in a few places, and each one checks a login, a signature or a secret before using it.

## What was reviewed

| Area | Result |
|---|---|
| RLS on every table | ✅ all tables (test: *every public table has row-level security*) |
| Tables readable without login | ✅ only cities, zones, hubs, prices, help articles, status names: nothing personal. Visitors can never write. |
| Database functions | ⚠️→✅ **Fixed.** Supabase's default let signed-out visitors run *every* function. All of them checked the caller inside, but one forgotten check would have been a hole. Now visitors can run only the 6 public-website functions (tracking, confirm-your-location, unsubscribe, and two "are you staff?" helpers). Internal helpers (`_name`) are server-only. New functions are closed to visitors by default. |
| Small leaks found | ✅ **Fixed.** Any signed-in user could see a hub's cash on hand, reserve tracking numbers, or build a notification preview for any order (revealing a rider's first name and plate). All closed. |
| Owner-rights functions | ✅ all pin their `search_path`; every one open to signed-in users checks the caller or returns only public information. |
| Storage (KYC documents, delivery photos, support files) | ✅ all private; uploads only into your own folder / your own order; links expire. |
| Edge Functions | ✅ each checks a signature (Supabase SMS hook, Meta WhatsApp) or a shared secret (schedules). **Tightened:** secrets are compared in constant time, and an empty/missing secret now means "locked" (before, `dispatch-rank` would have accepted an empty secret if the setting was forgotten). |
| Web API routes | ✅ every route checks login, API key, Hubtel token or Shopify signature before using the server key. The test-only "fake payment" route is off in production. **Tightened:** staff invite emails use the configured dashboard address, not the browser-supplied one. |
| Delivery codes | ⚠️→✅ **Fixed.** A rider could press "resend code" repeatedly, getting 5 fresh guesses each time. Riders may now resend 3 times per order per hour; dispatch is not limited. |
| Public tracking | ✅ address and recipient details need the last 4 digits of the phone; 10 wrong tries locks that parcel's details for an hour. |
| Business API | ✅ hashed keys, 120 requests/minute per key, live keys only after business verification, webhook URLs can't point at internal addresses. |

## Rate limits

One shared counter (`rate_hit` in the database) — no paid service needed.

| What | Limit | Why |
|---|---|---|
| Login codes (SMS) | 5 per phone per hour, 30 s apart | stop SMS bombing and Hubtel cost |
| Project-wide SMS cap (Supabase) | 1,000 per hour | the old 30/hour would block logins on a busy morning — **set the same on Supabase cloud: Authentication → Rate Limits** |
| Public tracking page | 30 per minute per IP | stop scraping |
| Confirm-your-location page | 30 per minute per IP; 10 pin moves per link per hour | each move may re-price the trip |
| Unsubscribe | 20 per minute per IP | |
| Address search (Google) | 120 autocomplete, 60 details, 30 geocode per minute per user | caps what a faulty app could cost on Google Maps |
| Quotes / bookings / payments | 60 / 20 / 10 per minute per user | |
| Delivery-code resend (rider) | 3 per order per hour | stops code guessing |
| Business API | 120 per minute per key | (Phase 11) |

If the counter itself is ever unreachable, requests are let through (a hiccup must not block customers); the error is logged.

## Fraud checks

An hourly scan (`fraud_scan`) lists suspicious patterns on the Ops dashboard → **Fraud checks**. A flag is a question for a person, never an automatic punishment. Super Admins and City Admins dismiss or confirm each one with a note (audit log); new high-priority flags are emailed to them. Every threshold is in Settings (`fraud_…`).

| Pattern | Default trigger |
|---|---|
| One phone, many accounts | 3+ accounts on one phone in 30 days (a vendor's shared shop phone and staff test phones are ignored) |
| Recipient keeps failing | 3+ failed/returned deliveries to one phone in 30 days |
| Rider fails a lot | 30%+ of 10+ attempts marked failed in 7 days |
| Vendor returns a lot | 40%+ of 20+ orders failed or returned in 7 days |
| Fake GPS | 3+ readings in 24 h from a fake-location app (Android reports this) or "jumps" faster than 150 km/h |
| Delivered away from the pin | 3+ deliveries in 7 days marked done beyond the geofence flag distance (500 m) |
| Cancels a lot | 5+ own cancellations in 24 h, or 50%+ of 10+ bookings in 7 days |

The apps send the phone's own app ID (Android ID / iOS identifier-for-vendor, via the free `expo-application` module) after sign-in. It survives reinstalling the app, which a random ID would not. It is not the phone number or IMEI.

## Before launch (checklist)

- [ ] Supabase cloud: Authentication → Rate Limits → SMS sent per hour = 1000; SMS OTP frequency 30 s.
- [ ] Set every secret listed in `.env.example` and in each Edge Function header (`NOTIFY_SECRET`, `DISPATCH_RANK_SECRET`, `SEND_SMS_HOOK_SECRET`, `WHATSAPP_APP_SECRET`, `HUBTEL_CALLBACK_TOKEN`, `CRON_SECRET` …): long random values, never reused.
- [ ] `DEV_FAKE_PAYMENTS` must NOT be set in production.
- [ ] Set `OPS_DASHBOARD_URL` (staff invite links) and add it to Supabase → Authentication → URL configuration → Redirect URLs.
- [ ] Turn on 2-factor sign-in for every Super Admin and Finance user (Ops dashboard → My account & 2FA).
- [ ] Restrict the Google Maps keys: browser key to the website domains, server key to the Supabase/Vercel servers, mobile keys to the app package names.
- [ ] Legal check of the wallets with a lawyer and Hubtel (Bank of Ghana e-money rules) — see CLAUDE.md §9.

## Reporting a problem

Email security@qcsghana.com. Please don't test against real customer data.
