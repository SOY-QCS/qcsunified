-- Found during the full test pass: the Phase 13 lockdown ("new functions are not open to everyone by default") is
-- global in Postgres, so it also applied to functions of any extension switched on LATER (e.g. a text-search extension
-- in the "extensions" schema): app users would get "permission denied" from inside normal queries.
-- Our own functions in "public" stay locked down (and supabase/tests/130_security.sql checks them); extension
-- functions behave normally again.
alter default privileges in schema extensions grant execute on functions to public;
