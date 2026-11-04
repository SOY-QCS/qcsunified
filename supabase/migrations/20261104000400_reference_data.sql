-- =====================================================================
-- QCS Unified — 004: reference data the system needs to work
-- (role list, status machine, system wallets, default settings)
-- Sample cities/zones/prices live in supabase/seed.sql instead.
-- =====================================================================

insert into public.roles (code, side, label, description) values
  ('customer',         'client',    'Individual customer',  'Books and pays for their own deliveries'),
  ('vendor_owner',     'client',    'Vendor owner',         'Owns a vendor account: wallet, staff, API keys'),
  ('vendor_staff',     'client',    'Vendor staff',         'Works for a vendor with limited permissions'),
  ('corporate',        'client',    'Corporate account',    'Business invoiced monthly'),
  ('fleet_rider',      'rider_app', 'QCS fleet rider',      'Paid a fixed pickup + per-stop fee'),
  ('commission_rider', 'rider_app', 'Independent rider',    'Earns a commission per delivery'),
  ('hub_handler',      'rider_app', 'Hub handler',          'Scans parcels in/out in Hub mode'),
  ('super_admin',      'ops',       'Super Admin',          'Everything, every city'),
  ('city_admin',       'ops',       'Regional/City Admin',  'Everything in their city only'),
  ('dispatcher',       'ops',       'Dispatcher',           'Assigns and manages jobs and riders'),
  ('hub_manager',      'ops',       'Hub Manager',          'Hub overview: stock, late parcels, scans'),
  ('finance',          'ops',       'Finance',              'Wallets, payouts, COD, invoices, prices'),
  ('support',          'ops',       'Customer Support',     'Tickets, calls and chats'),
  ('analyst',          'ops',       'Read-only Analyst',    'Can view, cannot change anything');

-- Allowed status moves (CLAUDE.md §7). Anything not listed is refused.
insert into public.order_status_transitions (from_status, to_status) values
  ('DRAFT','PENDING_PAYMENT'), ('DRAFT','CONFIRMED'), ('DRAFT','CANCELLED'),
  ('PENDING_PAYMENT','CONFIRMED'), ('PENDING_PAYMENT','CANCELLED'),
  ('CONFIRMED','SEARCHING_RIDER'), ('CONFIRMED','ASSIGNED'), ('CONFIRMED','RESCHEDULED'), ('CONFIRMED','CANCELLED'),
  ('SEARCHING_RIDER','ASSIGNED'), ('SEARCHING_RIDER','CANCELLED'),
  ('ASSIGNED','RIDER_AT_PICKUP'), ('ASSIGNED','SEARCHING_RIDER'), ('ASSIGNED','CANCELLED'),
  ('RIDER_AT_PICKUP','PICKED_UP'), ('RIDER_AT_PICKUP','FAILED_ATTEMPT'), ('RIDER_AT_PICKUP','CANCELLED'),
  ('PICKED_UP','IN_TRANSIT'), ('PICKED_UP','AT_HUB'),
  ('IN_TRANSIT','AT_HUB'), ('IN_TRANSIT','ARRIVED_AT_DROPOFF'), ('IN_TRANSIT','LOST'), ('IN_TRANSIT','DAMAGED'),
  -- inter-city and hub sorting
  ('AT_HUB','DEPARTED_HUB'), ('AT_HUB','OUT_FOR_DELIVERY'), ('AT_HUB','RETURNING_TO_SENDER'), ('AT_HUB','LOST'), ('AT_HUB','DAMAGED'),
  ('DEPARTED_HUB','ARRIVED_DEST_HUB'), ('DEPARTED_HUB','LOST'), ('DEPARTED_HUB','DAMAGED'),
  ('ARRIVED_DEST_HUB','OUT_FOR_DELIVERY'), ('ARRIVED_DEST_HUB','READY_FOR_COLLECTION'), ('ARRIVED_DEST_HUB','LOST'), ('ARRIVED_DEST_HUB','DAMAGED'),
  ('READY_FOR_COLLECTION','COLLECTED'), ('READY_FOR_COLLECTION','RETURNING_TO_SENDER'),
  ('OUT_FOR_DELIVERY','ARRIVED_AT_DROPOFF'), ('OUT_FOR_DELIVERY','FAILED_ATTEMPT'), ('OUT_FOR_DELIVERY','LOST'), ('OUT_FOR_DELIVERY','DAMAGED'),
  -- last metres
  ('ARRIVED_AT_DROPOFF','DELIVERED'), ('ARRIVED_AT_DROPOFF','FAILED_ATTEMPT'),
  -- exceptions
  ('FAILED_ATTEMPT','RESCHEDULED'), ('FAILED_ATTEMPT','RETURNING_TO_SENDER'), ('FAILED_ATTEMPT','OUT_FOR_DELIVERY'), ('FAILED_ATTEMPT','AT_HUB'),
  ('RESCHEDULED','CONFIRMED'), ('RESCHEDULED','SEARCHING_RIDER'), ('RESCHEDULED','OUT_FOR_DELIVERY'), ('RESCHEDULED','CANCELLED'),
  ('RETURNING_TO_SENDER','RETURNED'), ('RETURNING_TO_SENDER','AT_HUB'), ('RETURNING_TO_SENDER','LOST'), ('RETURNING_TO_SENDER','DAMAGED'),
  ('DAMAGED','DELIVERED'), ('DAMAGED','RETURNING_TO_SENDER'),
  ('LOST','AT_HUB');  -- found again

-- QCS's own accounts in the double-entry ledger.
insert into public.wallets (owner_type, system_code) values
  ('system', 'QCS_REVENUE'),        -- delivery, fulfilment and service fees earned
  ('system', 'HUBTEL_CLEARING'),    -- money received/sent through Hubtel
  ('system', 'COD_CASH'),           -- COD cash held by riders/hubs before vendor payout
  ('system', 'RIDER_EARNINGS_EXPENSE'),
  ('system', 'PROMO_EXPENSE'),      -- promo codes, referral credits
  ('system', 'PAYOUT_FEES');        -- instant cash-out fees earned

-- Admin-editable defaults (city rows can override any of these later).
insert into public.app_settings (key, value, description) values
  ('dispatch_accept_seconds',       '20',     'Seconds a rider has to accept an offer'),
  ('dispatch_max_rejections',       '5',      'Rejections/timeouts before a dispatcher is alerted'),
  ('dispatch_shortlist_size',       '5',      'Nearest riders checked by road travel time'),
  ('geofence_radius_m',             '3000',   'Max distance from drop-off to mark delivered'),
  ('geofence_flag_m',               '500',    'Deliveries further than this are flagged on the dashboard'),
  ('pin_correction_reprice_m',      '1000',   'Express re-priced if recipient moves pin further than this'),
  ('failed_return_fee_rate',        '0.5',    'Share of the fee charged for failed/returned deliveries'),
  ('bulk_max_stops',                '25',     'Max orders in one bulk trip'),
  ('express_max_weight_g',          '15000',  'Express (bike) weight cap'),
  ('location_ping_job_s',           '12',     'Rider location ping interval on a job'),
  ('location_ping_idle_s',          '60',     'Rider location ping interval while online and idle'),
  ('idle_ping_retention_days',      '7',      'Idle location pings deleted after this many days'),
  ('invoice_reminder_days',         '7',      'Reminder sent this many days after invoice if unpaid'),
  ('credit_limit_months',           '2',      'Bookings blocked when invoices are unpaid this long'),
  ('vendor_fee_overdue_hold_days',  '7',      'COD payout held when vendor fees are this overdue'),
  ('instant_cashout_fee',           '200',    'Rider instant cash-out fee in pesewas'),
  ('churn_drop_percent',            '30',     'Vendor flagged when weekly volume drops this much vs 4-week average'),
  ('sla_first_reply_minutes',       '60',     'Support: first reply target'),
  ('sla_resolve_minutes',           '1440',   'Support: resolution target');
