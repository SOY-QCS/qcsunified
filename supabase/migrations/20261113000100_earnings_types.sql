-- New wallet kinds and payment purpose for Phase 8 (enum values must be committed before they are used).
alter type public.wallet_owner add value if not exists 'rider_cash';   -- cash a rider is holding for QCS (negative = owes)
alter type public.wallet_owner add value if not exists 'vendor_cod';   -- COD money QCS owes a vendor (kept apart from their fees wallet)
alter type public.payment_purpose add value if not exists 'cod_remit'; -- a rider handing in COD cash by MoMo
