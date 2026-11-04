-- =====================================================================
-- QCS Unified — 002: core tables
-- Money = bigint pesewas. Times = timestamptz (stored UTC, shown Africa/Accra).
-- Locations = PostGIS geography (lng/lat, SRID 4326).
-- =====================================================================

-- ---------- helpers ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

-- ---------- places ----------
create table public.cities (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,                 -- ACC, KSI, TKD, TML
  name            text not null,
  timezone        text not null default 'Africa/Accra',
  same_day_cutoff time not null default '09:00',        -- book before this for same-day
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

create table public.zones (
  id         uuid primary key default gen_random_uuid(),
  city_id    uuid not null references public.cities(id),
  code       text not null,
  name       text not null,
  area       geography(MultiPolygon, 4326) not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (city_id, code)
);
create index zones_area_gix on public.zones using gist (area);

create table public.hubs (
  id            uuid primary key default gen_random_uuid(),
  city_id       uuid not null references public.cities(id),
  code          text not null unique,
  name          text not null,
  address       text not null,
  location      geography(Point, 4326) not null,
  phone         text,
  opening_hours jsonb not null default '{}'::jsonb,   -- {"mon":["08:00","18:00"], ...}
  capacity      integer not null default 0 check (capacity >= 0),  -- parcels
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------- people & roles ----------
-- One profile per login (auth.users). Contact details live here.
create table public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  full_name        text not null default '',
  phone            text unique,
  email            text,
  city_id          uuid references public.cities(id),
  marketing_opt_in boolean not null default false,     -- broadcasts only to opted-in users (§12)
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger profiles_updated before update on public.profiles for each row execute function public.set_updated_at();

-- The list of roles with a plain-English label (lookup table).
create table public.roles (
  code        public.app_role primary key,
  side        text not null check (side in ('client', 'rider_app', 'ops')),
  label       text not null,
  description text not null default ''
);

-- Who holds which role. city_id / hub_id narrow the role; NULL city = all cities.
create table public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       public.app_role not null references public.roles(code),
  city_id    uuid references public.cities(id),
  hub_id     uuid references public.hubs(id),
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique nulls not distinct (user_id, role, city_id, hub_id)
);
create index user_roles_user_idx on public.user_roles (user_id);

-- ---------- vendors / corporate ----------
create table public.vendors (
  id                       uuid primary key default gen_random_uuid(),
  owner_id                 uuid references public.profiles(id),   -- null while still a CRM lead
  account_type             public.vendor_account_type not null default 'vendor',
  business_name            text not null,
  contact_phone            text,
  contact_email            text,
  city_id                  uuid references public.cities(id),
  -- proof of delivery: vendors can only make it stricter (§8)
  pod_require_photo        boolean not null default false,
  pod_require_pickup_code  boolean not null default false,
  -- services
  cs_service_enabled       boolean not null default false,        -- QCS calls/chats their customers (§11)
  fulfilment_enabled       boolean not null default false,
  cod_payout_schedule      public.payout_schedule not null default 'weekly',
  payout_momo_number       text,
  payout_momo_network      text,
  -- money controls (set by finance / scheduled jobs, never by the vendor)
  booking_blocked          boolean not null default false,        -- corporate: unpaid > 2 months
  booking_block_reason     text,
  cod_payout_on_hold       boolean not null default false,        -- fees > 7 days overdue
  -- CRM
  crm_stage                public.crm_stage not null default 'new',
  account_manager_id       uuid references public.profiles(id),
  tags                     text[] not null default '{}',
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index vendors_owner_idx on public.vendors (owner_id);
create index vendors_city_stage_idx on public.vendors (city_id, crm_stage);
create trigger vendors_updated before update on public.vendors for each row execute function public.set_updated_at();

-- Sub-users of a vendor account with their own permissions.
create table public.vendor_staff (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  permissions text[] not null default '{book,track}',  -- book, track, cancel, wallet, statements, staff, api
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (vendor_id, user_id)
);
create index vendor_staff_user_idx on public.vendor_staff (user_id);

-- ---------- riders ----------
create table public.vehicles (
  id           uuid primary key default gen_random_uuid(),
  owned_by_qcs boolean not null default false,
  type         public.vehicle_type not null,
  plate_number text unique,
  make_model   text,
  max_weight_g integer not null default 15000 check (max_weight_g > 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.riders (
  id                    uuid primary key references public.profiles(id) on delete cascade,
  rider_type            public.rider_type not null,
  status                public.rider_status not null default 'applicant',
  city_id               uuid not null references public.cities(id),
  vehicle_id            uuid references public.vehicles(id),
  -- earnings setup (§9)
  commission_rate_bp    integer check (commission_rate_bp between 0 and 10000),  -- 2000 = 20% (commission riders)
  payout_momo_number    text,
  payout_momo_network   text,
  -- COD cash (§9)
  cod_float_limit       bigint not null default 50000,   -- pesewas (GHS 500)
  cod_float_balance     bigint not null default 0,       -- cash currently held, maintained by cod_collections
  cod_blocked           boolean not null default false,  -- missed remittance deadline / over limit
  -- performance (§6)
  rating                numeric(3,2) not null default 5.00 check (rating between 0 and 5),
  score                 integer not null default 100,
  offers_received       integer not null default 0,
  offers_accepted       integer not null default 0,
  -- live state
  is_online             boolean not null default false,
  last_location         geography(Point, 4326),
  last_location_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index riders_online_gix on public.riders using gist (last_location) where is_online and status = 'active';
create index riders_city_idx on public.riders (city_id, status);
create trigger riders_updated before update on public.riders for each row execute function public.set_updated_at();

create table public.rider_documents (
  id           uuid primary key default gen_random_uuid(),
  rider_id     uuid not null references public.riders(id) on delete cascade,
  doc_type     public.document_type not null,
  storage_path text not null,                     -- Supabase Storage path
  number       text,
  expires_on   date,
  status       public.review_status not null default 'pending',
  reviewed_by  uuid references public.profiles(id),
  reviewed_at  timestamptz,
  review_note  text,
  created_at   timestamptz not null default now()
);
create index rider_documents_rider_idx on public.rider_documents (rider_id);

-- Location history (§13): latest position lives on riders.last_location;
-- this table keeps pings (job pings kept as trip history, idle pings deleted after 7 days).
create table public.rider_location_pings (
  id          bigint generated always as identity primary key,
  rider_id    uuid not null references public.riders(id) on delete cascade,
  trip_id     uuid,                                   -- null = idle ping
  location    geography(Point, 4326) not null,
  accuracy_m  real,
  recorded_at timestamptz not null default now()
);
create index rider_pings_rider_time_idx on public.rider_location_pings (rider_id, recorded_at desc);
create index rider_pings_idle_cleanup_idx on public.rider_location_pings (recorded_at) where trip_id is null;

-- ---------- addresses ----------
create table public.addresses (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references public.profiles(id) on delete cascade,  -- personal saved address
  vendor_id         uuid references public.vendors(id) on delete cascade,   -- vendor address book
  label             text,                 -- "Home", "Shop", customer name...
  contact_name      text,
  contact_phone     text,
  formatted_address text not null,
  google_place_id   text,
  ghana_post_gps    text,                 -- e.g. GA-123-4567
  landmark          text,
  location          geography(Point, 4326) not null,
  city_id           uuid references public.cities(id),
  zone_id           uuid references public.zones(id),
  created_at        timestamptz not null default now()
);
create index addresses_user_idx on public.addresses (user_id);
create index addresses_vendor_idx on public.addresses (vendor_id);

-- ---------- trips (every rider job is a trip: 1 order for Express, up to 25 for Bulk) ----------
create table public.trips (
  id           uuid primary key default gen_random_uuid(),
  trip_type    public.trip_type not null,
  status       public.trip_status not null default 'PLANNED',
  city_id      uuid not null references public.cities(id),
  rider_id     uuid references public.riders(id),
  vendor_id    uuid references public.vendors(id),
  hub_id       uuid references public.hubs(id),
  created_by   uuid references public.profiles(id),
  assigned_at  timestamptz,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);
-- A rider can hold ONE active job at a time (§6).
create unique index trips_one_active_per_rider on public.trips (rider_id) where status in ('ASSIGNED', 'IN_PROGRESS');
create index trips_city_status_idx on public.trips (city_id, status);

-- ---------- orders ----------
create sequence public.tracking_seq start 100001;

create table public.orders (
  id                     uuid primary key default gen_random_uuid(),
  tracking_number        text not null unique default ('QCS' || lpad(nextval('public.tracking_seq')::text, 8, '0')),
  service_type           public.service_type not null,
  status                 public.order_status not null default 'DRAFT',
  city_id                uuid not null references public.cities(id),
  -- who
  customer_id            uuid references public.profiles(id),     -- who booked (individual or vendor user)
  vendor_id              uuid references public.vendors(id),      -- set for vendor/corporate orders
  external_ref           text,                                     -- vendor's own order number (API/plugins)
  -- where
  pickup_address_id      uuid references public.addresses(id),
  dropoff_address_id     uuid references public.addresses(id),
  pickup_location        geography(Point, 4326) not null,
  dropoff_location       geography(Point, 4326) not null,
  dropoff_zone_id        uuid references public.zones(id),
  recipient_name         text not null,
  recipient_phone        text not null,
  address_confirmation   public.address_confirmation not null default 'pending',
  -- inter-city
  origin_hub_id          uuid references public.hubs(id),
  dest_hub_id            uuid references public.hubs(id),
  intercity_option       public.intercity_option,
  -- parcel
  item_description       text,
  weight_g               integer not null check (weight_g > 0),
  is_fragile             boolean not null default false,
  is_high_value          boolean not null default false,
  item_value             bigint not null default 0 check (item_value >= 0),     -- pesewas
  cod_amount             bigint not null default 0 check (cod_amount >= 0),     -- pesewas to collect
  -- price (calculated ONLY by packages/pricing; stored here)
  quoted_fee             bigint not null check (quoted_fee >= 0),   -- locked at booking
  extra_fee              bigint not null default 0 check (extra_fee >= 0),  -- mid-trip changes / pin correction > 1 km
  failed_fee             bigint not null default 0 check (failed_fee >= 0), -- 50% on failed/returned
  price_breakdown        jsonb not null default '[]'::jsonb,
  promo_code_id          uuid,
  payer                  public.payer_type not null default 'sender',
  payment_method         public.payment_method not null,
  payment_status         public.payment_status not null default 'unpaid',
  -- scheduling
  scheduled_pickup_at    timestamptz,
  -- assignment
  trip_id                uuid references public.trips(id),
  rider_id               uuid references public.riders(id),
  offer_rejections       integer not null default 0,
  -- proof of delivery (§8) — codes are stored hashed, never in plain text
  delivery_otp_hash      text,
  pickup_otp_hash        text,
  pod_otp_verified_at    timestamptz,
  pod_signature_path     text,
  pod_photo_path         text,
  pod_override_by        uuid references public.profiles(id),
  pod_override_note      text,
  delivered_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint intercity_needs_hubs check (service_type <> 'intercity' or (origin_hub_id is not null and dest_hub_id is not null and intercity_option is not null)),
  constraint express_weight_cap check (service_type <> 'express' or weight_g <= 15000),
  constraint invoice_only_corporate check (payment_method <> 'invoice' or payer = 'corporate_invoice')
);
create index orders_city_status_idx    on public.orders (city_id, status);
create index orders_vendor_created_idx on public.orders (vendor_id, created_at desc);
create index orders_customer_created_idx on public.orders (customer_id, created_at desc);
create index orders_rider_active_idx   on public.orders (rider_id) where status not in ('DELIVERED','COLLECTED','CANCELLED','RETURNED','LOST');
create index orders_trip_idx           on public.orders (trip_id);
create index orders_hubs_idx           on public.orders (origin_hub_id, dest_hub_id);
create index orders_pickup_gix         on public.orders using gist (pickup_location);
create unique index orders_vendor_external_ref on public.orders (vendor_id, external_ref) where external_ref is not null;
create trigger orders_updated before update on public.orders for each row execute function public.set_updated_at();

-- Stops inside a trip. Order of stops is dynamic: suggested_seq is a hint, rider can re-order.
create table public.order_stops (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  order_id      uuid not null references public.orders(id) on delete cascade,
  kind          public.stop_kind not null,
  location      geography(Point, 4326) not null,
  suggested_seq integer,
  status        public.stop_status not null default 'PENDING',
  arrived_at    timestamptz,
  completed_at  timestamptz,
  unique (trip_id, order_id, kind)
);
create index order_stops_trip_idx on public.order_stops (trip_id, status);

-- Status history: one row per status change, with who/where/photo/note (§7).
create table public.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  from_status public.order_status,
  to_status   public.order_status not null,
  actor_id    uuid references public.profiles(id),
  location    geography(Point, 4326),
  photo_path  text,
  note        text,
  reason      text,
  created_at  timestamptz not null default now()
);
create index order_events_order_idx on public.order_events (order_id, created_at);

-- Which status may follow which. The single source of truth for the status machine.
create table public.order_status_transitions (
  from_status public.order_status not null,
  to_status   public.order_status not null,
  primary key (from_status, to_status)
);

-- ---------- pricing & settings (all editable in admin) ----------
-- rule_kind decides the shape of `config` (matches packages/pricing):
--   express        : {baseFee, perKm, perMinute, weightSurcharges[], fragileSurcharge, nightSurcharge, minimumFee}
--   ecommerce_zone : {bands:[{maxG, feePesewas}]}            (zone_id required)
--   intercity_lane : {bands:[...], doorstepFee}             (origin_hub_id + dest_hub_id required)
--   flat_promo     : {flatFee}                              (zone_id or city_id + valid dates)
--   fulfilment     : {storagePerItemMonthly, storagePerBinMonthly, pickPackPerOrder}
--   cs_service     : {feePerDeliveredOrder}
--   rider_pay      : {pickupFee, perStopFee} (fleet)
create table public.pricing_rules (
  id             uuid primary key default gen_random_uuid(),
  rule_kind      text not null check (rule_kind in ('express','ecommerce_zone','intercity_lane','flat_promo','fulfilment','cs_service','rider_pay')),
  name           text not null,
  city_id        uuid references public.cities(id),
  zone_id        uuid references public.zones(id),
  origin_hub_id  uuid references public.hubs(id),
  dest_hub_id    uuid references public.hubs(id),
  config         jsonb not null,
  valid_from     timestamptz,
  valid_to       timestamptz,
  is_active      boolean not null default true,
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint lane_needs_hubs check (rule_kind <> 'intercity_lane' or (origin_hub_id is not null and dest_hub_id is not null)),
  constraint zone_rule_needs_zone check (rule_kind <> 'ecommerce_zone' or zone_id is not null)
);
create index pricing_rules_lookup_idx on public.pricing_rules (rule_kind, city_id, is_active);
create trigger pricing_rules_updated before update on public.pricing_rules for each row execute function public.set_updated_at();

-- Platform knobs: 20 s accept window, 5 rejections, 3 km geofence, etc. city_id NULL = default.
create table public.app_settings (
  key        text not null,
  city_id    uuid references public.cities(id),
  value      jsonb not null,
  description text not null default '',
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (key, city_id)
);

-- ---------- money: wallets + double-entry ledger ----------
create table public.wallets (
  id          uuid primary key default gen_random_uuid(),
  owner_type  public.wallet_owner not null,
  owner_id    uuid,                         -- profile id (customer/rider) or vendor id; null for system
  system_code text unique,                  -- e.g. QCS_REVENUE, HUBTEL_CLEARING, COD_CASH, PROMO_EXPENSE
  balance     bigint not null default 0,    -- pesewas; maintained ONLY by the ledger trigger
  created_at  timestamptz not null default now(),
  unique (owner_type, owner_id),
  check ((owner_type = 'system') = (system_code is not null))
);

-- One money movement (e.g. "wallet top-up", "delivery fee"). Its entries must add up to zero.
create table public.ledger_transactions (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,               -- topup, delivery_fee, cod_collected, cod_payout, rider_earning, refund, promo, payout, adjustment...
  description text not null default '',
  order_id    uuid references public.orders(id),
  payout_id   uuid,
  external_ref text,                       -- Hubtel transaction id
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

create table public.ledger_entries (
  id             bigint generated always as identity primary key,
  transaction_id uuid not null references public.ledger_transactions(id),
  wallet_id      uuid not null references public.wallets(id),
  amount         bigint not null check (amount <> 0),   -- + credit to wallet, − debit from wallet
  created_at     timestamptz not null default now()
);
create index ledger_entries_wallet_idx on public.ledger_entries (wallet_id, created_at desc);
create index ledger_entries_tx_idx on public.ledger_entries (transaction_id);

create table public.payouts (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references public.wallets(id),
  purpose         text not null check (purpose in ('rider_weekly','rider_instant','vendor_cod','customer_refund')),
  amount          bigint not null check (amount > 0),
  fee             bigint not null default 0 check (fee >= 0),       -- instant cash-out fee
  momo_number     text not null,
  momo_network    text,
  status          public.payout_status not null default 'requested',
  hold_reason     text,
  hubtel_reference text,
  requested_by    uuid references public.profiles(id),
  approved_by     uuid references public.profiles(id),
  requested_at    timestamptz not null default now(),
  paid_at         timestamptz,
  failure_reason  text
);
create index payouts_status_idx on public.payouts (status, requested_at);

-- Cash collected on delivery, tracked until the vendor is paid (§9).
create table public.cod_collections (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null unique references public.orders(id),
  rider_id      uuid not null references public.riders(id),
  vendor_id     uuid references public.vendors(id),
  city_id       uuid not null references public.cities(id),
  amount        bigint not null check (amount > 0),
  status        public.cod_status not null default 'collected',
  collected_at  timestamptz not null default now(),
  remit_due_by  timestamptz not null,               -- end of day, Accra time
  remitted_at   timestamptz,
  remit_method  public.cod_remit_method,
  remit_hub_id  uuid references public.hubs(id),
  received_by   uuid references public.profiles(id),
  payout_id     uuid references public.payouts(id)
);
create index cod_rider_status_idx on public.cod_collections (rider_id, status);
create index cod_vendor_status_idx on public.cod_collections (vendor_id, status);

create table public.promo_codes (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code = upper(code)),
  kind           public.promo_kind not null,
  value          integer not null check (value > 0),   -- percent (1–100) or pesewas
  max_discount   bigint,                               -- cap for percent codes
  city_id        uuid references public.cities(id),
  service_type   public.service_type,
  max_uses       integer,
  per_user_limit integer not null default 1,
  used_count     integer not null default 0,
  valid_from     timestamptz not null default now(),
  valid_to       timestamptz,
  is_active      boolean not null default true,
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  check (kind <> 'percent' or value <= 100)
);
alter table public.orders add constraint orders_promo_fk foreign key (promo_code_id) references public.promo_codes(id);

-- ---------- support ----------
create table public.tickets (
  id                 uuid primary key default gen_random_uuid(),
  number             bigint generated always as identity unique,
  order_id           uuid references public.orders(id),
  vendor_id          uuid references public.vendors(id),
  customer_id        uuid references public.profiles(id),
  city_id            uuid references public.cities(id),
  opened_by          uuid references public.profiles(id),
  channel            public.ticket_channel not null,
  category           text not null default 'general',   -- general, cod_money, lost_damaged, delay, billing...
  priority           public.ticket_priority not null default 'normal',
  status             public.ticket_status not null default 'open',
  subject            text not null,
  assigned_to        uuid references public.profiles(id),
  first_response_due timestamptz,
  resolution_due     timestamptz,
  first_responded_at timestamptz,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index tickets_queue_idx on public.tickets (status, priority, first_response_due);
create index tickets_order_idx on public.tickets (order_id);
create trigger tickets_updated before update on public.tickets for each row execute function public.set_updated_at();

create table public.ticket_messages (
  id          bigint generated always as identity primary key,
  ticket_id   uuid not null references public.tickets(id) on delete cascade,
  author_id   uuid references public.profiles(id),
  body        text not null,
  is_internal boolean not null default false,   -- internal notes: staff only
  created_at  timestamptz not null default now()
);
create index ticket_messages_ticket_idx on public.ticket_messages (ticket_id, created_at);

-- ---------- audit, notifications, integrations ----------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid,
  action     text not null,          -- INSERT / UPDATE / DELETE / or a named action
  table_name text not null,
  record_id  text,
  before     jsonb,
  after      jsonb,
  reason     text,
  created_at timestamptz not null default now()
);
create index audit_log_record_idx on public.audit_log (table_name, record_id, created_at desc);
create index audit_log_actor_idx on public.audit_log (actor_id, created_at desc);

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete cascade,
  to_address text,                         -- phone/email when the recipient has no account
  order_id   uuid references public.orders(id) on delete cascade,
  channel    public.notification_channel not null,
  template   text not null,
  payload    jsonb not null default '{}'::jsonb,
  status     public.notification_status not null default 'queued',
  error      text,
  read_at    timestamptz,
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_queue_idx on public.notifications (created_at) where status = 'queued';
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.webhooks (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors(id) on delete cascade,
  url         text not null check (url like 'https://%'),
  secret      text not null default encode(gen_random_bytes(24), 'hex'),  -- used to sign payloads
  events      text[] not null default '{order.status_changed}',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors(id) on delete cascade,
  name         text not null,
  key_prefix   text not null,               -- first characters, shown in the portal to identify the key
  key_hash     text not null unique,        -- the key itself is shown once and never stored
  scopes       text[] not null default '{orders:write,orders:read}',
  created_by   uuid references public.profiles(id),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
