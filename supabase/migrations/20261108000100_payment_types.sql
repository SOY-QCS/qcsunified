-- New values used by the payments migration (enum values must be committed before use).
alter type public.wallet_owner add value if not exists 'customer_credit' after 'customer';  -- promo/referral credit: spend only, never cashed out
create type public.payment_purpose as enum ('order', 'wallet_topup');
create type public.payment_state as enum ('initiated', 'pending', 'paid', 'failed', 'cancelled', 'expired');
