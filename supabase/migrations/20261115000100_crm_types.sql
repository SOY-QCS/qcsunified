-- Phase 10 — CRM & support: new enum values must be committed before they are used.
alter type public.crm_stage add value if not exists 'lost';   -- a lead that said no
