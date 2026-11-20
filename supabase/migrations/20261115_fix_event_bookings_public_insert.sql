-- Safe/additive fix: ensure anonymous (public website) visitors can submit event registrations.
-- Apply in Supabase SQL Editor if event registration inserts fail with RLS/permission errors.
-- Does NOT delete or modify existing data.

-- Ensure table exists and RLS is enabled (no-op if already correct)
alter table if exists public.event_bookings enable row level security;

-- Recreate anon INSERT policy idempotently (schema may already define it)
drop policy if exists "event_bookings anon can insert" on public.event_bookings;
create policy "event_bookings anon can insert"
  on public.event_bookings
  for insert
  to anon
  with check (true);

-- Keep admin visibility/manage policies intact (defined in supabase-schema.sql).
-- If admins cannot read registrations, verify is_admin() and admins membership.

-- Verify
-- select policyname, roles, cmd from pg_policies where schemaname='public' and tablename='event_bookings';
