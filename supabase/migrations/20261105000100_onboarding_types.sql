-- =====================================================================
-- QCS Unified — Phase 2: new values for onboarding (kept in their own file:
-- Postgres needs new enum values committed before they are used).
-- =====================================================================
alter type public.rider_status add value if not exists 'pending' after 'applicant';   -- submitted, waiting for review
alter type public.rider_status add value if not exists 'rejected' after 'pending';
alter type public.document_type add value if not exists 'vehicle_photo';
alter type public.document_type add value if not exists 'guarantor_id';
alter type public.document_type add value if not exists 'business_id';
