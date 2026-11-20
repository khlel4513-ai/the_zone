-- 202611200002_restore_event_registration_rpc.sql
-- Forward-only restoration of the canonical register_for_event RPC,
-- Iraqi phone normalization, capacity gating, digital ticket issuance,
-- attendee ticket lookup, and admin check-in functions for THE ZONE.
--
-- Safety and backward-compatibility guarantees:
--   * Idempotent & non-destructive: no tables dropped, no data deleted or truncated.
--   * Preserves existing events, event_bookings, and tickets rows intact.
--   * Self-contained: provides required helper functions and ticket tables if absent.
--   * Enforces 5-column contract: (ok boolean, booking_id uuid, state text, message text, ticket jsonb).
--   * Prevents overbooking race conditions via row lock (FOR UPDATE) on public.events.
--   * Preserves admin policies (admins manage event bookings, etc.).
--   * Revokes direct public INSERT on event_bookings to force registration through the secure RPC.

begin;

-- ---------------------------------------------------------------------------
-- 0) Cryptographic extension (required for secure QR token generation)
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1) Event tickets table and booking references (if not already established)
-- ---------------------------------------------------------------------------
create table if not exists public.event_tickets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  booking_id uuid not null references public.event_bookings(id) on delete cascade,
  ticket_number text not null,
  qr_token text not null,
  status text not null default 'valid',
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
alter table public.event_tickets enable row level security;

-- Ensure strict admin-only RLS policy exists on public.event_tickets
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'event_tickets' and policyname = 'event_tickets_admin_all'
  ) then
    create policy "event_tickets_admin_all"
      on public.event_tickets for all
      using (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'));
  end if;
end $$;

-- Ensure required tracking columns exist on public.event_bookings
alter table public.event_bookings
  add column if not exists participant_email text,
  add column if not exists ticket_id uuid,
  add column if not exists cancelled_at timestamptz,
  add column if not exists attended_at timestamptz,
  add column if not exists checked_in_at timestamptz,
  add column if not exists checked_in_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

alter table public.event_bookings enable row level security;

-- Clean up any legacy permissive direct-insert policies on event_bookings
drop policy if exists "Public insert event bookings" on public.event_bookings;
drop policy if exists "event_bookings anon can insert" on public.event_bookings;
drop policy if exists "event_bookings_no_direct_anon_insert" on public.event_bookings;

-- Ensure strict admin management RLS policy exists on public.event_bookings
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'event_bookings' and policyname = 'Admins manage event bookings'
  ) then
    create policy "Admins manage event bookings"
      on public.event_bookings for all
      using (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'event_bookings_ticket_fk' and conrelid = 'public.event_bookings'::regclass
  ) then
    alter table public.event_bookings
      add constraint event_bookings_ticket_fk foreign key (ticket_id) references public.event_tickets(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Strict Iraqi Mobile Normalization helper
--    Canonical form: 9647XXXXXXXXX (country code + 9 national digits = 12 digits total)
--    Accepted input: 07XXXXXXXXX, 9647XXXXXXXXX, +9647XXXXXXXXX, 009647XXXXXXXXX
--    Permits optional spaces, hyphens, dots, parentheses; rejects invalid lengths/formats.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_event_phone(p_phone text)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $$
declare
  v_input text := btrim(coalesce(p_phone, ''));
  v_digits text;
  v_national text;
begin
  if v_input = '' or v_input !~ '^\+?[0-9[:space:]().-]+$' then return null; end if;
  v_digits := regexp_replace(v_input, '[[:space:]().-]', '', 'g');
  v_digits := regexp_replace(v_digits, '^\+', '');

  if v_digits ~ '^07[0-9]{9}$' then
    v_national := substr(v_digits, 2);
  elsif v_digits ~ '^9647[0-9]{9}$' then
    v_national := substr(v_digits, 4);
  elsif v_digits ~ '^009647[0-9]{9}$' then
    v_national := substr(v_digits, 6);
  else
    return null;
  end if;
  return '964' || v_national;
end;
$$;

revoke all on function public.normalize_event_phone(text) from public, anon, authenticated;

create index if not exists idx_event_bookings_event_phone_canonical
  on public.event_bookings(event_id, (public.normalize_event_phone(phone)));

-- ---------------------------------------------------------------------------
-- 3) Internal capacity helper
-- ---------------------------------------------------------------------------
create or replace function public.event_occupied_seats(p_event_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(greatest(coalesce(seats, 1), 1))::integer, 0)
  from public.event_bookings
  where event_id = p_event_id
    and coalesce(status, 'pending') not in ('rejected', 'cancelled');
$$;

revoke all on function public.event_occupied_seats(uuid) from public, anon, authenticated;
grant execute on function public.event_occupied_seats(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Public Event Status / Flags RPCs
-- ---------------------------------------------------------------------------
create or replace function public.get_published_events_ticket_flags()
returns table(
  event_id uuid,
  capacity_enabled boolean,
  is_full boolean,
  tickets_enabled boolean,
  qr_checkin_enabled boolean,
  registration_open boolean,
  show_ticket_to_attendee boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id,
    coalesce(e.capacity_enabled, false),
    case when coalesce(e.capacity_enabled, false) and e.total_seats is not null
      then public.event_occupied_seats(e.id) >= e.total_seats else false end,
    coalesce(e.tickets_enabled, false),
    coalesce(e.qr_checkin_enabled, false),
    coalesce(e.registration_open, true),
    coalesce(e.show_ticket_to_attendee, true)
  from public.events e
  where e.published = true;
$$;

revoke all on function public.get_published_events_ticket_flags() from public;
grant execute on function public.get_published_events_ticket_flags() to anon, authenticated;

create or replace function public.get_published_events_public_flags()
returns table(
  event_id uuid,
  capacity_enabled boolean,
  is_full boolean,
  tickets_enabled boolean,
  qr_checkin_enabled boolean,
  registration_open boolean,
  show_ticket_to_attendee boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select * from public.get_published_events_ticket_flags();
$$;

revoke all on function public.get_published_events_public_flags() from public;
grant execute on function public.get_published_events_public_flags() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) The Canonical Public Registration RPC: public.register_for_event
--    Contract: (p_event_id uuid, p_visitor_name text, p_phone text, p_seats integer default 1, p_participant_email text default null)
--    Returns: table(ok boolean, booking_id uuid, state text, message text, ticket jsonb)
-- ---------------------------------------------------------------------------
create or replace function public.register_for_event(
  p_event_id uuid,
  p_visitor_name text,
  p_phone text,
  p_seats integer default 1,
  p_participant_email text default null
)
returns table(ok boolean, booking_id uuid, state text, message text, ticket jsonb)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_event record;
  v_seats integer := greatest(coalesce(p_seats, 1), 1);
  v_taken integer;
  v_id uuid;
  v_norm_phone text;
  v_dup uuid;
  v_dup_count integer;
  v_ticket_id uuid;
  v_token text;
  v_num text;
  v_attempt integer;
  v_ticket jsonb := null;
begin
  if p_event_id is null then
    return query select false, null::uuid, 'error', 'معرّف الفعالية مطلوب', null::jsonb;
    return;
  end if;
  if coalesce(btrim(p_visitor_name), '') = '' then
    return query select false, null::uuid, 'error', 'الاسم مطلوب', null::jsonb;
    return;
  end if;
  if coalesce(btrim(p_phone), '') = '' then
    return query select false, null::uuid, 'error', 'رقم الهاتف مطلوب', null::jsonb;
    return;
  end if;
  v_seats := least(v_seats, 20);

  -- Atomic serialization: lock event row to serialize capacity and duplicate verification
  select * into v_event
  from public.events
  where id = p_event_id and published = true
  for update;

  if not found then
    return query select false, null::uuid, 'error', 'الفعالية غير متاحة حالياً', null::jsonb;
    return;
  end if;

  if not coalesce(v_event.registration_open, true) then
    return query select false, null::uuid, 'closed', 'التسجيل مغلق لهذه الفعالية حالياً', null::jsonb;
    return;
  end if;

  v_norm_phone := public.normalize_event_phone(p_phone);
  if v_norm_phone is null then
    return query select false, null::uuid, 'error', 'رقم الهاتف غير صالح', null::jsonb;
    return;
  end if;

  -- Duplicate registration detection using canonical Iraqi phone
  select count(*) into v_dup_count
  from public.event_bookings b
  where b.event_id = p_event_id
    and public.normalize_event_phone(b.phone) = v_norm_phone
    and coalesce(b.status, 'pending') not in ('rejected', 'cancelled');

  if v_dup_count > 1 then
    return query select false, null::uuid, 'duplicate', 'تعذر التحقق من التسجيل السابق. يرجى التواصل مع الفريق.', null::jsonb;
    return;
  end if;

  select b.id into v_dup
  from public.event_bookings b
  where b.event_id = p_event_id
    and public.normalize_event_phone(b.phone) = v_norm_phone
    and coalesce(b.status, 'pending') not in ('rejected', 'cancelled')
  order by b.created_at asc
  limit 1;

  if v_dup is not null then
    if coalesce(v_event.tickets_enabled, false) then
      select case when coalesce(v_event.show_ticket_to_attendee, true) then jsonb_build_object(
        'ticket_issued', t.id is not null,
        'ticket_id', t.id,
        'ticket_number', t.ticket_number,
        'qr_token', case when t.status = 'valid' then t.qr_token else null end,
        'ticket_status', t.status,
        'issued_at', t.issued_at,
        'used_at', t.used_at,
        'event_title', coalesce(v_event.title_ar, v_event.title_en, ''),
        'event_date', v_event.event_date,
        'event_time', v_event.event_time,
        'visitor_name', b.visitor_name,
        'phone', b.phone,
        'seats', greatest(coalesce(b.seats, 1), 1),
        'booking_id', b.id,
        'event_id', b.event_id,
        'booking_status', b.status,
        'show_ticket_to_attendee', true
      ) else jsonb_build_object(
        'ticket_issued', t.id is not null,
        'booking_id', b.id,
        'event_id', b.event_id,
        'booking_status', b.status,
        'visitor_name', b.visitor_name,
        'event_title', coalesce(v_event.title_ar, v_event.title_en, ''),
        'event_date', v_event.event_date,
        'event_time', v_event.event_time,
        'show_ticket_to_attendee', false
      ) end into v_ticket
      from public.event_bookings b
      left join public.event_tickets t on t.booking_id = b.id and t.event_id = b.event_id
      where b.id = v_dup
      limit 1;
    else
      select jsonb_build_object(
        'booking_id', b.id,
        'event_id', b.event_id,
        'booking_status', b.status,
        'visitor_name', b.visitor_name,
        'event_title', coalesce(v_event.title_ar, v_event.title_en, ''),
        'event_date', v_event.event_date,
        'event_time', v_event.event_time
      ) into v_ticket
      from public.event_bookings b
      where b.id = v_dup;
    end if;

    if coalesce((v_ticket->>'ticket_issued')::boolean, false) then
      return query select true, v_dup, 'ticket_exists', 'لديك تسجيل وتذكرة سابقة لهذه الفعالية', v_ticket;
      return;
    end if;
    return query select true, v_dup, 'already_registered', 'يوجد تسجيل سابق لهذه الفعالية بنفس رقم الهاتف', v_ticket;
    return;
  end if;

  -- Capacity check when capacity_enabled is on and total_seats is configured
  if coalesce(v_event.capacity_enabled, false) and v_event.total_seats is not null then
    v_taken := public.event_occupied_seats(p_event_id);
    if v_taken + v_seats > v_event.total_seats then
      return query select false, null::uuid, 'full', 'اكتمل التسجيل لهذه الفعالية حالياً', null::jsonb;
      return;
    end if;
  end if;

  -- Insert new booking record
  insert into public.event_bookings(
    event_id, visitor_name, phone, seats, status, participant_email
  ) values (
    p_event_id,
    btrim(p_visitor_name),
    btrim(p_phone),
    v_seats,
    'pending',
    nullif(btrim(coalesce(p_participant_email, '')), '')
  ) returning id into v_id;

  -- Digital ticket issuance when tickets_enabled
  if coalesce(v_event.tickets_enabled, false) then
    for v_attempt in 1..3 loop
      v_token := encode(gen_random_bytes(24), 'hex');
      v_num := 'TZ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
      begin
        insert into public.event_tickets(event_id, booking_id, ticket_number, qr_token, status)
        values (p_event_id, v_id, v_num, v_token, 'valid')
        returning id into v_ticket_id;
      exception when unique_violation then
        select t.id into v_ticket_id
        from public.event_tickets t
        where t.booking_id = v_id and t.event_id = p_event_id
        limit 1;
        if v_ticket_id is null and v_attempt = 3 then raise; end if;
      end;
      exit when v_ticket_id is not null;
    end loop;

    if v_ticket_id is null then
      raise exception 'ticket issuance failed';
    end if;

    update public.event_bookings
    set ticket_id = v_ticket_id, updated_at = now()
    where id = v_id;

    select case when coalesce(v_event.show_ticket_to_attendee, true) then jsonb_build_object(
      'ticket_issued', true,
      'ticket_id', t.id,
      'ticket_number', t.ticket_number,
      'qr_token', case when t.status = 'valid' then t.qr_token else null end,
      'ticket_status', t.status,
      'status', t.status,
      'issued_at', t.issued_at,
      'used_at', t.used_at,
      'event_title', coalesce(v_event.title_ar, v_event.title_en, ''),
      'event_date', v_event.event_date,
      'event_time', v_event.event_time,
      'visitor_name', btrim(p_visitor_name),
      'phone', btrim(p_phone),
      'seats', v_seats,
      'booking_id', v_id,
      'event_id', p_event_id,
      'show_ticket_to_attendee', true
    ) else jsonb_build_object(
      'ticket_issued', true,
      'booking_id', v_id,
      'event_id', p_event_id,
      'visitor_name', btrim(p_visitor_name),
      'event_title', coalesce(v_event.title_ar, v_event.title_en, ''),
      'event_date', v_event.event_date,
      'event_time', v_event.event_time,
      'show_ticket_to_attendee', false
    ) end into v_ticket
    from public.event_tickets t
    where t.id = v_ticket_id and t.booking_id = v_id and t.event_id = p_event_id;

    if v_ticket is null then
      raise exception 'ticket association failed';
    end if;

    return query select true, v_id, 'ticket_issued', 'تم التسجيل وإصدار التذكرة', v_ticket;
    return;
  end if;

  return query select true, v_id, 'pending', 'تم استلام التسجيل', null::jsonb;

exception
  when unique_violation then
    return query select false, null::uuid, 'duplicate', 'يوجد تسجيل سابق لهذه الفعالية', null::jsonb;
  when others then
    return query select false, null::uuid, 'error', 'تعذر إكمال التسجيل حالياً. يرجى المحاولة مرة أخرى.', null::jsonb;
end;
$$;

revoke all on function public.register_for_event(uuid, text, text, integer, text) from public;
grant execute on function public.register_for_event(uuid, text, text, integer, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Secure Attendee Ticket Lookup RPC: public.get_my_event_ticket
-- ---------------------------------------------------------------------------
create or replace function public.get_my_event_ticket(p_booking_id uuid, p_phone text)
returns table(ok boolean, state text, message text, payload jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm_phone text;
  v_b record;
  v_t record;
begin
  if p_booking_id is null then
    return query select false, 'invalid', 'بيانات التحقق مطلوبة', null::jsonb;
    return;
  end if;
  v_norm_phone := public.normalize_event_phone(p_phone);
  if v_norm_phone is null then
    return query select false, 'invalid', 'بيانات التحقق مطلوبة', null::jsonb;
    return;
  end if;

  select b.id as booking_id, b.event_id, b.visitor_name, b.phone, b.seats, b.status as booking_status,
    e.title_ar, e.title_en, e.event_date, e.event_time, e.tickets_enabled, e.show_ticket_to_attendee
  into v_b
  from public.event_bookings b
  join public.events e on e.id = b.event_id
  where b.id = p_booking_id and public.normalize_event_phone(b.phone) = v_norm_phone;

  if not found then
    return query select false, 'not_found', 'لم يتم العثور على تسجيل مطابق', null::jsonb;
    return;
  end if;

  if coalesce(v_b.booking_status, 'pending') in ('rejected', 'cancelled') then
    return query select false, 'ineligible', 'هذا التسجيل غير مؤهل لعرض تذكرة', null::jsonb;
    return;
  end if;

  if not coalesce(v_b.tickets_enabled, false) then
    return query select true, 'tickets_disabled', 'التذاكر الرقمية غير مفعلة لهذه الفعالية', jsonb_build_object(
      'booking_id', v_b.booking_id,
      'booking_status', v_b.booking_status,
      'event_title', coalesce(v_b.title_ar, v_b.title_en, ''),
      'event_date', v_b.event_date,
      'event_time', v_b.event_time,
      'visitor_name', v_b.visitor_name,
      'seats', greatest(coalesce(v_b.seats, 1), 1)
    );
    return;
  end if;

  if not coalesce(v_b.show_ticket_to_attendee, true) then
    return query select true, 'hidden_from_attendee', 'تم استلام تسجيلك. يرجى التواصل مع الفريق بشأن التذكرة.', jsonb_build_object(
      'booking_id', v_b.booking_id,
      'booking_status', v_b.booking_status,
      'event_id', v_b.event_id,
      'event_title', coalesce(v_b.title_ar, v_b.title_en, ''),
      'event_date', v_b.event_date,
      'event_time', v_b.event_time,
      'visitor_name', v_b.visitor_name,
      'seats', greatest(coalesce(v_b.seats, 1), 1),
      'show_ticket_to_attendee', false
    );
    return;
  end if;

  select t.id, t.booking_id, t.event_id, t.ticket_number, t.qr_token, t.status, t.issued_at, t.used_at
  into v_t
  from public.event_tickets t
  where t.booking_id = v_b.booking_id and t.event_id = v_b.event_id;

  if not found then
    return query select true, 'pending_ticket', 'تم استلام تسجيلك. التذكرة بانتظار الإصدار.', jsonb_build_object(
      'booking_id', v_b.booking_id,
      'booking_status', v_b.booking_status,
      'event_id', v_b.event_id,
      'event_title', coalesce(v_b.title_ar, v_b.title_en, ''),
      'event_date', v_b.event_date,
      'event_time', v_b.event_time,
      'visitor_name', v_b.visitor_name,
      'seats', greatest(coalesce(v_b.seats, 1), 1),
      'show_ticket_to_attendee', true
    );
    return;
  end if;

  return query select true, 'ok', 'تم العثور على التذكرة', jsonb_build_object(
    'booking_id', v_b.booking_id,
    'booking_status', v_b.booking_status,
    'event_id', v_b.event_id,
    'event_title', coalesce(v_b.title_ar, v_b.title_en, ''),
    'event_date', v_b.event_date,
    'event_time', v_b.event_time,
    'visitor_name', v_b.visitor_name,
    'phone', v_b.phone,
    'seats', greatest(coalesce(v_b.seats, 1), 1),
    'ticket_id', v_t.id,
    'ticket_number', v_t.ticket_number,
    'qr_token', case when v_t.status = 'valid' then v_t.qr_token else null end,
    'ticket_status', v_t.status,
    'issued_at', v_t.issued_at,
    'used_at', v_t.used_at,
    'show_ticket_to_attendee', true
  );
end;
$$;

revoke all on function public.get_my_event_ticket(uuid, text) from public;
grant execute on function public.get_my_event_ticket(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) Admin Check-in RPCs
-- ---------------------------------------------------------------------------
create or replace function public.admin_checkin_ticket_for_event(p_token text, p_event_id uuid default null)
returns table(ok boolean, state text, message text, payload jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_t record;
  v_changed integer;
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

  select t.event_id into v_t from public.event_tickets t where t.qr_token = btrim(p_token);
  if not found then
    return query select false, 'invalid', 'تذكرة غير صالحة', null::jsonb;
    return;
  end if;

  if p_event_id is not null and v_t.event_id <> p_event_id then
    return query select false, 'wrong_event', 'هذه التذكرة تخص فعالية أخرى', null::jsonb;
    return;
  end if;

  select t.id as ticket_id, t.ticket_number, t.status, t.used_at, t.event_id, t.booking_id,
    b.visitor_name, b.phone, b.seats, b.status as booking_status,
    e.title_ar, e.title_en, e.event_date, e.event_time, e.qr_checkin_enabled
  into v_t
  from public.event_tickets t
  join public.event_bookings b on b.id = t.booking_id
  join public.events e on e.id = t.event_id
  where t.qr_token = btrim(p_token) and (p_event_id is null or t.event_id = p_event_id)
  for update of t, b;

  if not found then
    return query select false, 'invalid', 'تذكرة غير صالحة', null::jsonb;
    return;
  end if;

  if coalesce(v_t.booking_status, 'pending') in ('rejected', 'cancelled') then
    return query select false, 'booking_ineligible', 'التسجيل المرتبط بهذه التذكرة غير مؤهل', to_jsonb(v_t);
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
    return query select false, 'invalid', 'التذكرة غير صالحة', to_jsonb(v_t);
    return;
  end if;

  update public.event_tickets
  set status = 'used', used_at = now(), checked_in_by = auth.uid(), updated_at = now()
  where id = v_t.ticket_id and status = 'valid';

  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    return query select false, 'conflict', 'تعذر تسجيل الحضور. تحقق من حالة التذكرة.', to_jsonb(v_t);
    return;
  end if;

  update public.event_bookings
  set attended_at = coalesce(attended_at, now()),
      checked_in_at = coalesce(checked_in_at, now()),
      updated_at = now(),
      updated_by = auth.uid()
  where id = v_t.booking_id;

  return query select true, 'checked_in', 'تم تأكيد الحضور', to_jsonb(v_t) || jsonb_build_object('checked_in_now', true);
end;
$$;

revoke all on function public.admin_checkin_ticket_for_event(text, uuid) from public, anon;
grant execute on function public.admin_checkin_ticket_for_event(text, uuid) to authenticated;

create or replace function public.admin_checkin_ticket(p_token text)
returns table(ok boolean, state text, message text, payload jsonb)
language sql
security definer
set search_path = public
as $$
  select * from public.admin_checkin_ticket_for_event(p_token, null::uuid);
$$;

revoke all on function public.admin_checkin_ticket(text) from public, anon;
grant execute on function public.admin_checkin_ticket(text) to authenticated;

create or replace function public.admin_manual_checkin(p_query text, p_event_id uuid default null)
returns table(ok boolean, state text, message text, payload jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_q text := btrim(coalesce(p_query, ''));
  v_norm text := public.normalize_event_phone(p_query);
  v_matches integer;
  v_t record;
  v_changed integer;
begin
  select exists(select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin') into v_is_admin;
  if not coalesce(v_is_admin, false) then
    return query select false, 'forbidden', 'غير مصرح', null::jsonb;
    return;
  end if;
  if v_q = '' then
    return query select false, 'invalid', 'أدخل رقم التذكرة أو رقم الهاتف أو معرّف الحجز', null::jsonb;
    return;
  end if;

  if v_norm is not null and upper(v_q) !~ '^TZ-[A-F0-9]+$' and v_q !~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then
    select count(*) into v_matches
    from public.event_tickets t
    join public.event_bookings b on b.id = t.booking_id
    where public.normalize_event_phone(b.phone) = v_norm
      and (p_event_id is null or t.event_id = p_event_id);
    if v_matches > 1 then
      return query select false, 'ambiguous', 'عُثر على أكثر من تذكرة لهذا الرقم. اختر الفعالية لتحديد التذكرة.', null::jsonb;
      return;
    end if;
  end if;

  select t.id as ticket_id, t.ticket_number, t.qr_token, t.status, t.used_at, t.event_id, t.booking_id,
    b.visitor_name, b.phone, b.seats, b.status as booking_status,
    e.title_ar, e.title_en, e.event_date, e.event_time, e.qr_checkin_enabled
  into v_t
  from public.event_tickets t
  join public.event_bookings b on b.id = t.booking_id
  join public.events e on e.id = t.event_id
  where (upper(t.ticket_number) = upper(v_q) or t.booking_id::text = v_q or (v_norm is not null and public.normalize_event_phone(b.phone) = v_norm))
    and (p_event_id is null or t.event_id = p_event_id)
  order by (upper(t.ticket_number) = upper(v_q)) desc, (t.booking_id::text = v_q) desc, t.issued_at desc
  limit 1
  for update of t, b;

  if not found then
    return query select false, 'not_found', 'لم يتم العثور على تذكرة مطابقة', null::jsonb;
    return;
  end if;

  if coalesce(v_t.booking_status, 'pending') in ('rejected', 'cancelled') then
    return query select false, 'booking_ineligible', 'التسجيل المرتبط بهذه التذكرة غير مؤهل', to_jsonb(v_t);
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
  where id = v_t.ticket_id and status = 'valid';

  get diagnostics v_changed = row_count;
  if v_changed <> 1 then
    return query select false, 'conflict', 'تعذر تسجيل الحضور. تحقق من حالة التذكرة.', to_jsonb(v_t);
    return;
  end if;

  update public.event_bookings
  set attended_at = coalesce(attended_at, now()),
      checked_in_at = coalesce(checked_in_at, now()),
      updated_at = now(),
      updated_by = auth.uid()
  where id = v_t.booking_id;

  return query select true, 'checked_in', 'تم تأكيد الحضور', to_jsonb(v_t) || jsonb_build_object('checked_in_now', true);
end;
$$;

revoke all on function public.admin_manual_checkin(text, uuid) from public, anon;
grant execute on function public.admin_manual_checkin(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Registration Security Gating & Administration Privilege Preservation
--    - Revoke direct public/client INSERT on event_bookings to enforce RPC registration.
--    - Explicitly preserve SELECT, UPDATE, and DELETE privileges for authenticated admin flows.
--    - Retain full permissions for service_role and leave admin RLS policies intact.
-- ---------------------------------------------------------------------------
revoke insert on table public.event_bookings from public, anon, authenticated;
grant select, update, delete on table public.event_bookings to authenticated;
grant all on table public.event_bookings to service_role;

grant select, update, delete on table public.event_tickets to authenticated;
grant all on table public.event_tickets to service_role;

commit;
