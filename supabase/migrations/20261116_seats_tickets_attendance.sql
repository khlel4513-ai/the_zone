-- THE ZONE: optional per-event seat capacity, optional digital tickets/QR attendance, admin activity log
-- ADDITIVE & NON-DESTRUCTIVE. Apply in Supabase SQL Editor. Preserves all existing data/events/registrations/CMS.
-- Safe to re-run in parts (uses IF NOT EXISTS / drop-if-exists for policies/functions where appropriate).
-- After applying: update frontend/admin to use new columns and RPCs. Verify RLS and admin membership.

begin;

-- ---------------------------------------------------------------------------
-- 1) Events: optional capacity + optional digital tickets (independent toggles)
-- ---------------------------------------------------------------------------
alter table public.events
  add column if not exists capacity_enabled boolean not null default false,
  add column if not exists total_seats integer,
  add column if not exists tickets_enabled boolean not null default false,
  add column if not exists qr_checkin_enabled boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'events_total_seats_positive_chk') then
    alter table public.events
      add constraint events_total_seats_positive_chk check (total_seats is null or total_seats >= 1);
  end if;
end $$;

comment on column public.events.capacity_enabled is 'If true, enforce total_seats for registrations (server-side via RPC).';
comment on column public.events.total_seats is 'Total seats when capacity_enabled=true. Admin-only visibility of counts/remaining.';
comment on column public.events.tickets_enabled is 'If true, digital ticket/QR may be issued for confirmed bookings.';
comment on column public.events.qr_checkin_enabled is 'If true, QR attendance verification is enabled for this event.';

-- ---------------------------------------------------------------------------
-- 2) Event bookings: attendance/cancellation/ticket linkage (compatible with existing statuses)
-- ---------------------------------------------------------------------------
alter table public.event_bookings
  add column if not exists participant_email text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists attended_at timestamptz,
  add column if not exists checked_in_at timestamptz,
  add column if not exists checked_in_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

create index if not exists idx_event_bookings_event_status_created on public.event_bookings(event_id, status, created_at desc);
create index if not exists idx_event_bookings_phone_norm on public.event_bookings ((regexp_replace(coalesce(phone,''), '[\s\-()+]', '', 'g')));

-- ---------------------------------------------------------------------------
-- 3) Digital tickets (optional per event). QR token is unguessable; no sensitive personal data in QR.
-- ---------------------------------------------------------------------------
create table if not exists public.event_tickets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  booking_id uuid not null references public.event_bookings(id) on delete cascade,
  ticket_number text not null,
  qr_token text not null,
  status text not null default 'valid', -- valid, used, cancelled, invalid
  issued_at timestamptz not null default now(),
  used_at timestamptz,
  checked_in_by uuid references auth.users(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_tickets_booking_unique unique (booking_id),
  constraint event_tickets_number_unique unique (ticket_number),
  constraint event_tickets_token_unique unique (qr_token),
  constraint event_tickets_status_chk check (status in ('valid','used','cancelled','invalid'))
);

create index if not exists idx_event_tickets_event on public.event_tickets(event_id);
create index if not exists idx_event_tickets_status on public.event_tickets(status);
create index if not exists idx_event_tickets_token on public.event_tickets(qr_token);

alter table public.event_bookings
  add column if not exists ticket_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_bookings_ticket_fk') then
    alter table public.event_bookings
      add constraint event_bookings_ticket_fk foreign key (ticket_id) references public.event_tickets(id) on delete set null;
  end if;
end $$;

alter table public.event_tickets enable row level security;

-- Tickets: admin-only access. Public must not read tokens or verify client-side.
drop policy if exists "event_tickets_admin_all" on public.event_tickets;
create policy "event_tickets_admin_all" on public.event_tickets
  for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'));

-- ---------------------------------------------------------------------------
-- 4) Admin activity log (persisted audit trail)
-- ---------------------------------------------------------------------------
create table if not exists public.admin_activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id),
  actor_email text,
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_activity_log_created on public.admin_activity_log(created_at desc);
create index if not exists idx_admin_activity_log_action on public.admin_activity_log(action);

alter table public.admin_activity_log enable row level security;

drop policy if exists "admin_activity_log_admin_select" on public.admin_activity_log;
create policy "admin_activity_log_admin_select" on public.admin_activity_log
  for select using (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'));
drop policy if exists "admin_activity_log_admin_insert" on public.admin_activity_log;
create policy "admin_activity_log_admin_insert" on public.admin_activity_log
  for insert with check (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'));
drop policy if exists "admin_activity_log_admin_update" on public.admin_activity_log;
create policy "admin_activity_log_admin_update" on public.admin_activity_log
  for update using (false) with check (false); -- append-oriented; no updates/deletes from client
drop policy if exists "admin_activity_log_admin_delete" on public.admin_activity_log;
create policy "admin_activity_log_admin_delete" on public.admin_activity_log
  for delete using (false);

-- ---------------------------------------------------------------------------
-- 5) Capacity helpers
--    Occupying statuses are configurable by business rule. Conservative default:
--    count active (non-cancelled/non-rejected) bookings as occupying requested seats.
-- ---------------------------------------------------------------------------
create or replace function public.event_occupied_seats(p_event_id uuid)
returns integer
language sql
stable
as $$
  select coalesce(sum(greatest(coalesce(seats,1),1))::int, 0)
  from public.event_bookings
  where event_id = p_event_id
    and coalesce(status, 'pending') not in ('rejected', 'cancelled');
$$;

-- ---------------------------------------------------------------------------
-- 6) Public registration RPC (server-side, capacity-safe under concurrency)
--    - Locks the event row to serialize capacity checks.
--    - Prevents duplicate active registration for same normalized phone+event.
--    - When capacity disabled: behaves as open registration (no seat limit).
--    - Does NOT expose seat counts to caller; returns only success/full/error states.
--    - Does NOT issue tickets automatically (tickets are optional and can be issued by admin flow).
-- NOTE: Existing frontend direct-insert paths remain for backward compatibility unless hardened.
-- ---------------------------------------------------------------------------
create or replace function public.register_for_event(
  p_event_id uuid,
  p_visitor_name text,
  p_phone text,
  p_seats integer default 1,
  p_participant_email text default null
)
returns table(ok boolean, booking_id uuid, state text, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_seats int := greatest(coalesce(p_seats,1),1);
  v_taken int;
  v_id uuid;
  v_norm_phone text;
  v_dup uuid;
begin
  if p_event_id is null then
    return query select false, null::uuid, 'error', 'معرّف الفعالية مطلوب';
    return;
  end if;
  if coalesce(btrim(p_visitor_name), '') = '' then
    return query select false, null::uuid, 'error', 'الاسم مطلوب';
    return;
  end if;
  if coalesce(btrim(p_phone), '') = '' then
    return query select false, null::uuid, 'error', 'رقم الهاتف مطلوب';
    return;
  end if;
  if v_seats < 1 then v_seats := 1; end if;
  if v_seats > 20 then v_seats := 20; end if; -- sane cap; adjust if needed

  select * into v_event
  from public.events
  where id = p_event_id and published = true
  for update;

  if not found then
    return query select false, null::uuid, 'error', 'الفعالية غير متاحة حالياً';
    return;
  end if;

  v_norm_phone := regexp_replace(p_phone, '[\s\-()+]', '', 'g');

  select id into v_dup
  from public.event_bookings
  where event_id = p_event_id
    and regexp_replace(coalesce(phone,''), '[\s\-()+]', '', 'g') = v_norm_phone
    and coalesce(status, 'pending') not in ('rejected', 'cancelled')
  limit 1;

  if v_dup is not null then
    return query select false, v_dup, 'duplicate', 'يوجد تسجيل سابق لهذه الفعالية بنفس رقم الهاتف';
    return;
  end if;

  if coalesce(v_event.capacity_enabled, false) = true and v_event.total_seats is not null then
    v_taken := public.event_occupied_seats(p_event_id);
    if (v_taken + v_seats) > v_event.total_seats then
      return query select false, null::uuid, 'full', 'اكتمل التسجيل';
      return;
    end if;
  end if;

  insert into public.event_bookings (event_id, visitor_name, phone, seats, status, participant_email)
  values (p_event_id, btrim(p_visitor_name), btrim(p_phone), v_seats, 'pending', nullif(btrim(coalesce(p_participant_email,'')), ''))
  returning id into v_id;

  return query select true, v_id, 'pending', 'تم استلام التسجيل';
exception
  when unique_violation then
    return query select false, null::uuid, 'duplicate', 'يوجد تسجيل سابق لهذه الفعالية';
  when others then
    return query select false, null::uuid, 'error', 'تعذر حفظ التسجيل حالياً';
end;
$$;

grant execute on function public.register_for_event(uuid, text, text, integer, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) Admin: issue ticket for a booking (only when event.tickets_enabled)
-- ---------------------------------------------------------------------------
create or replace function public.admin_issue_ticket(p_booking_id uuid)
returns table(ok boolean, state text, message text, ticket jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_b record;
  v_existing record;
  v_ticket_id uuid;
  v_token text;
  v_num text;
begin
  select exists(select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin') into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return query select false, 'forbidden', 'غير مصرح', null::jsonb;
    return;
  end if;

  select b.id as booking_id, b.event_id, b.status, b.ticket_id, e.tickets_enabled, e.title_ar, e.title_en
  into v_b
  from public.event_bookings b
  join public.events e on e.id = b.event_id
  where b.id = p_booking_id
  for update of b;

  if not found then
    return query select false, 'not_found', 'التسجيل غير موجود', null::jsonb;
    return;
  end if;
  if not coalesce(v_b.tickets_enabled, false) then
    return query select false, 'disabled', 'التذاكر الرقمية غير مفعلة لهذه الفعالية', null::jsonb;
    return;
  end if;
  if coalesce(v_b.status, 'pending') in ('rejected', 'cancelled') then
    return query select false, 'invalid_booking', 'لا يمكن إصدار تذكرة لتسجيل مرفوض أو ملغى', null::jsonb;
    return;
  end if;

  select * into v_existing from public.event_tickets where booking_id = p_booking_id limit 1;
  if found then
    update public.event_bookings set ticket_id = v_existing.id, updated_at = now() where id = p_booking_id and ticket_id is distinct from v_existing.id;
    return query select true, 'exists', 'التذكرة موجودة مسبقاً', to_jsonb(v_existing);
    return;
  end if;

  v_token := encode(gen_random_bytes(24), 'hex');
  v_num := 'TZ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

  insert into public.event_tickets (event_id, booking_id, ticket_number, qr_token, status)
  values (v_b.event_id, p_booking_id, v_num, v_token, 'valid')
  returning id into v_ticket_id;

  update public.event_bookings set ticket_id = v_ticket_id, updated_at = now() where id = p_booking_id;

  return query select true, 'issued', 'تم إصدار التذكرة', (select to_jsonb(t) from public.event_tickets t where t.id = v_ticket_id);
exception when unique_violation then
  select * into v_existing from public.event_tickets where booking_id = p_booking_id limit 1;
  if found then
    return query select true, 'exists', 'التذكرة موجودة مسبقاً', to_jsonb(v_existing);
  else
    return query select false, 'error', 'تعذر إصدار التذكرة', null::jsonb;
  end if;
end;
$$;

revoke all on function public.admin_issue_ticket(uuid) from public;
grant execute on function public.admin_issue_ticket(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Admin: check-in by QR token (server-side verification)
-- ---------------------------------------------------------------------------
create or replace function public.admin_checkin_ticket(p_token text)
returns table(ok boolean, state text, message text, payload jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_t record;
begin
  select exists(select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin') into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return query select false, 'forbidden', 'غير مصرح', null::jsonb;
    return;
  end if;
  if coalesce(btrim(p_token), '') = '' then
    return query select false, 'invalid', 'رمز التذكرة مطلوب', null::jsonb;
    return;
  end if;

  select
    t.id as ticket_id, t.ticket_number, t.status, t.used_at, t.event_id, t.booking_id,
    b.visitor_name, b.phone, b.seats, b.status as booking_status,
    e.title_ar, e.title_en, e.event_date, e.event_time, e.qr_checkin_enabled
  into v_t
  from public.event_tickets t
  join public.event_bookings b on b.id = t.booking_id
  join public.events e on e.id = t.event_id
  where t.qr_token = btrim(p_token)
  for update of t;

  if not found then
    return query select false, 'invalid', 'تذكرة غير صالحة', null::jsonb;
    return;
  end if;

  if not coalesce(v_t.qr_checkin_enabled, false) then
    return query select false, 'disabled', 'التحقق من الحضور غير مفعّل لهذه الفعالية', to_jsonb(v_t);
    return;
  end if;

  if v_t.status = 'used' then
    return query select true, 'used', 'تم تسجيل الحضور مسبقاً', to_jsonb(v_t);
    return;
  end if;
  if v_t.status = 'cancelled' then
    return query select false, 'cancelled', 'التذكرة ملغاة', to_jsonb(v_t);
    return;
  end if;
  if v_t.status <> 'valid' then
    return query select false, v_t.status, 'التذكرة غير صالحة', to_jsonb(v_t);
    return;
  end if;

  update public.event_tickets
    set status = 'used', used_at = now(), checked_in_by = auth.uid(), updated_at = now()
  where id = v_t.ticket_id;

  update public.event_bookings
    set attended_at = coalesce(attended_at, now()),
        checked_in_at = coalesce(checked_in_at, now()),
        updated_at = now(),
        updated_by = auth.uid()
  where id = v_t.booking_id;

  return query select true, 'checked_in', 'تم تأكيد الحضور', to_jsonb(v_t) || jsonb_build_object('checked_in_now', true);
end;
$$;

revoke all on function public.admin_checkin_ticket(text) from public;
grant execute on function public.admin_checkin_ticket(text) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- ROLLOUT NOTES (manual, do not auto-apply destructive hardening):
-- 1) For strict server-side capacity enforcement on ALL clients, migrate public registration
--    to call public.register_for_event(...) and then (after verification) restrict direct anon
--    INSERT on event_bookings. See 20261116_harden_event_booking_capacity.sql (commented guidance).
-- 2) If you need public visitors to view/print their own ticket without accounts, implement a
--    separate secure tokenized retrieval Edge Function/RPC with minimal fields (no PII leakage).
--    Current schema keeps tickets admin-only by default.
-- 3) Tune event_occupied_seats() status set to match your definition of "confirmed/occupying".
-- ---------------------------------------------------------------------------
