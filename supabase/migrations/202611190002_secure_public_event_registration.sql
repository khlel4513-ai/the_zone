-- THE ZONE: require the public event registration RPC.
--
-- Removes direct INSERT access so callers cannot bypass the transaction that
-- enforces event capacity, duplicate registration checks, and ticket issuance.
-- The SECURITY DEFINER register_for_event(uuid,text,text,integer,text) RPC
-- remains callable by anon/authenticated and performs the insert server-side.
-- Existing rows are untouched. Review and apply to Supabase after deploying
-- the frontend version that uses register_for_event exclusively.

begin;

drop policy if exists "Public insert event bookings" on public.event_bookings;
drop policy if exists "event_bookings anon can insert" on public.event_bookings;
drop policy if exists "event_bookings_no_direct_anon_insert" on public.event_bookings;

-- PostgreSQL grants and RLS policies are independent. Remove INSERT table
-- privileges for public clients as well as any permissive INSERT policy.
revoke insert on table public.event_bookings from public, anon, authenticated;

commit;
