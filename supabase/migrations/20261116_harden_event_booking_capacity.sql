-- OPTIONAL HARDENING (apply ONLY after frontend/public flow uses public.register_for_event RPC and is verified)
-- Purpose: prevent bypass of server-side capacity/idempotency checks by removing direct anonymous INSERTs.
-- This is a policy change (not data-destructive) but CAN break older clients that still insert directly.
-- Review carefully in staging before production.

-- Example:
-- begin;
-- drop policy if exists "Public insert event bookings" on public.event_bookings;
-- drop policy if exists "event_bookings anon can insert" on public.event_bookings;
-- drop policy if exists "event_bookings anon can insert" on public.event_bookings; -- name variants
-- create policy "event_bookings_no_direct_anon_insert"
--   on public.event_bookings for insert to anon
--   with check (false);
-- commit;

-- Keep "Admins manage event bookings" policy intact.
