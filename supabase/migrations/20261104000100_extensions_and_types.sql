-- =====================================================================
-- QCS Unified — 001: extensions and shared types (enums)
-- Every list here is mirrored in packages/types/src/index.ts.
-- =====================================================================

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Who someone is on the platform (CLAUDE.md §4). One person can hold several roles.
create type public.app_role as enum (
  -- client side
  'customer', 'vendor_owner', 'vendor_staff', 'corporate',
  -- rider app
  'fleet_rider', 'commission_rider', 'hub_handler',
  -- ops dashboard
  'super_admin', 'city_admin', 'dispatcher', 'hub_manager', 'finance', 'support', 'analyst'
);

create type public.service_type as enum ('express', 'ecommerce', 'intercity', 'scheduled');

-- The single order status machine (CLAUDE.md §7).
create type public.order_status as enum (
  'DRAFT', 'PENDING_PAYMENT', 'CONFIRMED', 'SEARCHING_RIDER', 'ASSIGNED',
  'RIDER_AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT',
  'AT_HUB', 'DEPARTED_HUB', 'ARRIVED_DEST_HUB', 'READY_FOR_COLLECTION', 'COLLECTED', 'OUT_FOR_DELIVERY',
  'ARRIVED_AT_DROPOFF', 'DELIVERED',
  'CANCELLED', 'FAILED_ATTEMPT', 'RESCHEDULED', 'RETURNING_TO_SENDER', 'RETURNED', 'LOST', 'DAMAGED'
);

create type public.trip_status as enum ('PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
create type public.trip_type as enum ('express', 'bulk', 'intercity_first_mile', 'intercity_last_mile');
create type public.stop_kind as enum ('pickup', 'dropoff');
create type public.stop_status as enum ('PENDING', 'ARRIVED', 'DONE', 'FAILED', 'SKIPPED');

create type public.payer_type as enum ('sender', 'recipient', 'vendor_wallet', 'corporate_invoice');
create type public.payment_method as enum ('card', 'momo', 'wallet', 'cash', 'invoice');
create type public.payment_status as enum ('unpaid', 'pending', 'paid', 'refunded', 'failed');

create type public.intercity_option as enum ('hub_collection', 'doorstep');
create type public.address_confirmation as enum ('not_required', 'pending', 'confirmed', 'corrected', 'unconfirmed');

create type public.rider_type as enum ('fleet', 'commission');
create type public.rider_status as enum ('applicant', 'active', 'suspended', 'offboarded');
create type public.vehicle_type as enum ('bike', 'ebike', 'tricycle', 'car', 'van');
create type public.document_type as enum ('ghana_card', 'drivers_license', 'vehicle_registration', 'insurance', 'roadworthy', 'photo', 'other');
create type public.review_status as enum ('pending', 'approved', 'rejected', 'expired');

create type public.vendor_account_type as enum ('vendor', 'corporate');
create type public.crm_stage as enum ('new', 'contacted', 'trial', 'active', 'churn_risk', 'churned');
create type public.payout_schedule as enum ('daily', 'weekly');

create type public.wallet_owner as enum ('customer', 'vendor', 'rider', 'system');
create type public.payout_status as enum ('requested', 'held', 'processing', 'paid', 'failed', 'cancelled');
create type public.cod_status as enum ('collected', 'remitted', 'paid_out', 'disputed');
create type public.cod_remit_method as enum ('momo', 'cash_at_hub');

create type public.promo_kind as enum ('percent', 'fixed');

create type public.ticket_status as enum ('open', 'pending', 'resolved', 'closed');
create type public.ticket_priority as enum ('low', 'normal', 'high', 'urgent');
create type public.ticket_channel as enum ('app', 'whatsapp', 'staff', 'email', 'phone');

create type public.notification_channel as enum ('push', 'sms', 'whatsapp', 'email');
create type public.notification_status as enum ('queued', 'sent', 'failed');
