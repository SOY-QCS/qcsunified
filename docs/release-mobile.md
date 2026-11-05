# Releasing the QCS apps (Android + iOS)

Two apps, built and sent to the stores with **EAS** (Expo's build service):

| App | Folder | Android package / iOS bundle id | Who uses it |
|---|---|---|---|
| **QCS** | `apps/client-mobile` | `gh.qcs.client` | customers, vendors, corporate accounts |
| **QCS Rider** | `apps/rider-mobile` | `gh.qcs.rider` | riders (and hub handlers in Hub mode) |

Everything technical is ready in the code (`eas.json` and `app.json` in each app). What's left needs **your** accounts and decisions. Expect 1–2 days of setup, then store review: usually 1–3 days for Google and 1–2 days for Apple. The first review is often slower.

## 1. Accounts (one-off)

| Account | Cost | Notes |
|---|---|---|
| Expo (expo.dev) | Free | Create an organisation "qcs-ghana". The free plan includes a limited number of cloud builds each month (in a slower queue); paid plans are optional (expo.dev/pricing). |
| Google Play Console | **US$25 once** | Register as an **Organisation**, not a personal account: new *personal* accounts must run a 14-day closed test with 12+ testers before they can publish. An organisation account needs a free **D-U-N-S number** for QCS Ghana (dnb.com, takes a few days). |
| Apple Developer Program | **US$99 per year** | Enrol as an **Organisation** (also needs the D-U-N-S number), so the store shows "QCS Ghana" as the seller. iOS builds and TestFlight need this. |

These are the only paid items, and both store fees are required by Google and Apple themselves.

## 2. Connect the code to Expo (once per app)

```bash
npm install -g eas-cli          # Expo's command-line tool
eas login
cd apps/rider-mobile  && eas init     # creates the project, writes its id into app.json (push notifications need it)
cd ../client-mobile   && eas init
```

Then set the app settings on expo.dev → each project → **Environment variables**, for the *preview* and *production* environments:

| Name | Value |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project settings → API → anon key (safe to ship in apps) |
| `EXPO_PUBLIC_API_URL` | the business portal address, e.g. `https://portal.qcsghana.com` |
| `GOOGLE_MAPS_ANDROID_KEY` | (QCS app only) Google Maps key restricted to Android app `gh.qcs.client` |

Never put the Supabase **service-role** key in an app.

**Push notifications:** Android needs a Firebase project (free). Upload its service-account key in expo.dev → project → Credentials → Android → FCM V1. For iOS, EAS creates the push key itself on the first build.

## 3. Test builds (before the stores)

```bash
cd apps/rider-mobile
eas build --profile preview --platform android    # an APK link: install it on riders' phones directly
eas build --profile preview --platform ios        # registered test iPhones (eas device:create), or use TestFlight below
```

Test on a **low-end Android** (2 GB RAM). Walk through:

- sign-in by SMS code;
- going online, with the "QCS is tracking your trip" notification showing;
- a job from offer to delivery, with code and signature;
- Hub mode with a hub handler account;
- the QCS app: booking, paying, tracking, and Settings → Delete my account.

## 4. Store builds and submission

```bash
eas build  --profile production --platform all     # version numbers go up automatically
eas submit --profile production --platform android  # goes to the Play "Internal testing" track as a draft
eas submit --profile production --platform ios      # goes to TestFlight
```

The first Android upload must be done by hand in Play Console: create the app, then upload the `.aab` from the build page. After that, `eas submit` works; it needs a Google service-account key (Play Console → Setup → API access). Move releases from *Internal testing* → *Production* in Play Console when you're happy. For iOS, pick the build in App Store Connect → submit for review.

## 5. Store listings

**Names:** "QCS – Deliveries in Ghana" and "QCS Rider".
**Category:** Business (QCS) / Maps & Navigation or Business (Rider).
**Privacy policy:** `https://qcsghana.com/privacy`.
**Account deletion page:** `https://qcsghana.com/delete-account`.

*QCS short description (80 characters):* Send parcels across Ghana: same-day Express, e-commerce and inter-city delivery.

*QCS full description (starting point):*
> Book a QCS rider in seconds. Express delivery anywhere in your city, e-commerce deliveries for your online shop with cash on delivery, and parcels between Accra, Kumasi, Takoradi and Tamale. See the price before you book, pay by MoMo, card or cash, follow your rider live, and get a delivery code so only the right person receives your parcel. Vendors: bulk-book up to 25 deliveries per trip, track COD, and download statements.

*QCS Rider short description:* For QCS riders: get nearby delivery jobs, navigate, collect proof of delivery and see your earnings.

**Screenshots:** at least 2 phone screenshots per app (Android: 1080×1920 or similar; iPhone: 6.7" and 6.5" sizes). Phones only: iPad is switched off, so no iPad screenshots are needed. Take them from a preview build on a real phone with demo data.

## 6. The questions the stores will ask

### Google Play → Data safety

| Data | QCS app | QCS Rider | Why (tick) |
|---|---|---|---|
| Name, phone, email | ✔ | ✔ | App functionality, account management |
| Precise location | ✔ (pickup pin, while using) | ✔ (**including background**) | App functionality |
| Photos | ✔ (ID for business accounts) | ✔ (documents, delivery photos) | App functionality |
| Purchase history | ✔ | – | App functionality |
| Device or other IDs | ✔ | ✔ | Fraud prevention, security |
| App interactions (messages with support) | ✔ | ✔ | App functionality, customer support |

Answer *Yes* to "data is encrypted in transit" and to "users can request deletion". Answer *No* to "data is shared with third parties" (service providers working for QCS don't count as sharing in Google's sense). Do not tick advertising.

### Google Play → Background location (QCS Rider only)

Play Console → App content → **Location permissions**. Paste:

> QCS Rider is used by delivery riders working for QCS Ghana. While a rider is **online for work**, the app shares their location in the background so we can offer them the nearest delivery jobs and show customers where their parcel is on the way. A permanent notification ("QCS is tracking your trip") shows whenever this is happening. When the rider goes offline, location sharing stops completely.

Google also asks for a **short video (under 30 s)** showing the in-app explanation, then going online and the notification appearing. Record it on a phone with a preview build and upload it to YouTube as *unlisted*.

### Apple → App Review notes

> Sign-in uses a one-time SMS code. Test accounts (the code is always 123456):
> • QCS app: +233 20 000 0001
> • QCS Rider: +233 20 000 0002 (an approved rider in Accra; jobs only appear when a customer books nearby)
> Background location (QCS Rider): used only while the rider is online for work, to offer nearby jobs and show customers live tracking. Going offline stops it.
> Account deletion: QCS → Settings → Delete my account; QCS Rider → Help & support → Delete my account.

Create those test numbers in Supabase → Authentication → Sign In / Providers → Phone → **Test phone numbers and OTPs** (`233200000001=123456`, …). Make the rider number an approved rider in Ops → Riders.

Apple's export-compliance question is answered in the code already: the apps use only standard encryption (HTTPS).

## 7. Updating the apps later

Change the code, then run `eas build --profile production` and `eas submit` again; version numbers go up by themselves. People get the update through the store. Database and website changes go live without a new app version.
