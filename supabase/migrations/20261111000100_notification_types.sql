-- Phase 6 needs two more notification states. Enum values must be added in their own migration
-- (Postgres can't use a new enum value in the same transaction that adds it).
alter type public.notification_status add value if not exists 'sending';
alter type public.notification_status add value if not exists 'skipped';
