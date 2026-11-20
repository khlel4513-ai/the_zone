-- THE ZONE: explicit event registration status and server-side enforcement.
-- Additive and non-destructive: existing events default to open; no records are deleted.
-- Review before applying. Deploy with the matching frontend/admin update.

begin;

alter table public.events
  add column if not exists registration_open boolean not null default true;

drop function if exists public.get_event_public_flags(uuid);
drop function if exists public.get_published_events_public_flags();

create function public.get_event_public_flags(p_event_id uuid)
returns table(event_id uuid, capacity_enabled boolean, is_full boolean, tickets_enabled boolean, qr_checkin_enabled boolean, registration_open boolean)
language sql security definer set search_path = public stable
as $$
  select e.id, coalesce(e.capacity_enabled,false),
    case when coalesce(e.capacity_enabled,false) and e.total_seats is not null
      then public.event_occupied_seats(e.id) >= e.total_seats else false end,
    coalesce(e.tickets_enabled,false), coalesce(e.qr_checkin_enabled,false),
    coalesce(e.registration_open,true)
  from public.events e where e.id = p_event_id and e.published = true;
$$;

create function public.get_published_events_public_flags()
returns table(event_id uuid, capacity_enabled boolean, is_full boolean, tickets_enabled boolean, qr_checkin_enabled boolean, registration_open boolean)
language sql security definer set search_path = public stable
as $$
  select e.id, coalesce(e.capacity_enabled,false),
    case when coalesce(e.capacity_enabled,false) and e.total_seats is not null
      then public.event_occupied_seats(e.id) >= e.total_seats else false end,
    coalesce(e.tickets_enabled,false), coalesce(e.qr_checkin_enabled,false),
    coalesce(e.registration_open,true)
  from public.events e where e.published = true;
$$;

revoke all on function public.get_event_public_flags(uuid) from public;
revoke all on function public.get_published_events_public_flags() from public;
grant execute on function public.get_event_public_flags(uuid) to anon, authenticated;
grant execute on function public.get_published_events_public_flags() to anon, authenticated;

-- Normalize Iraq local and international formats before duplicate checks.
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
  -- Permit only the optional leading plus, digits, whitespace, parentheses, dots and hyphens.
  -- Reject letters/extensions and arbitrary punctuation instead of stripping them into a match.
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
  on public.event_bookings (event_id, public.normalize_event_phone(phone))
  where coalesce(status, 'pending') not in ('rejected', 'cancelled')
    and public.normalize_event_phone(phone) is not null;

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
set search_path = public
as $$
declare
  v_event record;
  v_seats int := greatest(coalesce(p_seats,1),1);
  v_taken int;
  v_id uuid;
  v_norm_phone text;
  v_dup uuid;
  v_dup_count integer;
  v_ticket_id uuid;
  v_token text;
  v_num text;
  v_ticket jsonb := null;
begin
  if p_event_id is null then return query select false, null::uuid, 'error', 'معرّف الفعالية مطلوب', null::jsonb; return; end if;
  if coalesce(btrim(p_visitor_name), '') = '' then return query select false, null::uuid, 'error', 'الاسم مطلوب', null::jsonb; return; end if;
  if coalesce(btrim(p_phone), '') = '' then return query select false, null::uuid, 'error', 'رقم الهاتف مطلوب', null::jsonb; return; end if;
  if v_seats < 1 then v_seats := 1; end if;
  if v_seats > 20 then v_seats := 20; end if;

  select * into v_event from public.events where id = p_event_id and published = true for update;
  if not found then return query select false, null::uuid, 'error', 'الفعالية غير متاحة حالياً', null::jsonb; return; end if;
  if coalesce(v_event.registration_open, true) = false then
    return query select false, null::uuid, 'closed', 'التسجيل مغلق لهذه الفعالية حالياً', null::jsonb;
    return;
  end if;

  v_norm_phone := public.normalize_event_phone(p_phone);
  if v_norm_phone is null then
    return query select false, null::uuid, 'error', 'رقم الهاتف غير صالح', null::jsonb;
    return;
  end if;
  select id into v_dup from public.event_bookings
  where event_id = p_event_id
    and public.normalize_event_phone(phone) = v_norm_phone
    and coalesce(status, 'pending') not in ('rejected', 'cancelled')
  order by created_at asc
  limit 1;
  select count(*) into v_dup_count from public.event_bookings
  where event_id = p_event_id
    and public.normalize_event_phone(phone) = v_norm_phone
    and coalesce(status, 'pending') not in ('rejected', 'cancelled');
  if v_dup_count > 1 then
    -- Legacy collisions are ambiguous: never select and return one booking's ticket arbitrarily.
    return query select false, null::uuid, 'duplicate', 'تعذر التحقق من التسجيل السابق. يرجى التواصل مع الفريق.', null::jsonb;
    return;
  end if;
  if v_dup is not null then
    -- Idempotent UX: same claimant (same normalized phone) can retrieve their existing ticket/booking state
    select jsonb_build_object(
      'ticket_id', t.id, 'ticket_number', t.ticket_number, 'qr_token', t.qr_token, 'ticket_status', t.status,
      'issued_at', t.issued_at, 'used_at', t.used_at,
      'event_title', coalesce(v_event.title_ar, v_event.title_en, ''),
      'event_date', v_event.event_date, 'event_time', v_event.event_time,
      'visitor_name', b.visitor_name, 'phone', b.phone, 'seats', greatest(coalesce(b.seats,1),1),
      'booking_id', b.id, 'event_id', b.event_id, 'booking_status', b.status
    ) into v_ticket
    from public.event_bookings b
    left join public.event_tickets t on t.booking_id = b.id
    where b.id = v_dup
    limit 1;

    if v_ticket is not null and (v_ticket->>'ticket_number') is not null then
      return query select true, v_dup, 'ticket_exists', 'لديك تسجيل وتذكرة سابقة لهذه الفعالية', v_ticket; return;
    end if;
    return query select true, v_dup, 'already_registered', 'يوجد تسجيل سابق لهذه الفعالية بنفس رقم الهاتف', v_ticket; return;
  end if;

  if coalesce(v_event.capacity_enabled, false) = true and v_event.total_seats is not null then
    v_taken := public.event_occupied_seats(p_event_id);
    if (v_taken + v_seats) > v_event.total_seats then
      return query select false, null::uuid, 'full', 'اكتمل التسجيل', null::jsonb; return;
    end if;
  end if;

  insert into public.event_bookings (event_id, visitor_name, phone, seats, status, participant_email)
  values (p_event_id, btrim(p_visitor_name), btrim(p_phone), v_seats, 'pending', nullif(btrim(coalesce(p_participant_email,'')), ''))
  returning id into v_id;

  -- Auto-issue ticket only when explicitly enabled for this event and booking is a real successful registration
  if coalesce(v_event.tickets_enabled, false) = true then
    v_token := encode(gen_random_bytes(24), 'hex');
    v_num := 'TZ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    begin
      insert into public.event_tickets (event_id, booking_id, ticket_number, qr_token, status)
      values (p_event_id, v_id, v_num, v_token, 'valid') returning id into v_ticket_id;
      update public.event_bookings set ticket_id = v_ticket_id, updated_at = now() where id = v_id;
      select jsonb_build_object(
        'ticket_id', t.id, 'ticket_number', t.ticket_number, 'qr_token', t.qr_token, 'ticket_status', t.status,
        'issued_at', t.issued_at, 'event_title', coalesce(v_event.title_ar, v_event.title_en, ''),
        'event_date', v_event.event_date, 'event_time', v_event.event_time,
        'visitor_name', btrim(p_visitor_name), 'phone', btrim(p_phone), 'seats', v_seats, 'booking_id', v_id, 'event_id', p_event_id
      ) into v_ticket from public.event_tickets t where t.id = v_ticket_id;
      return query select true, v_id, 'ticket_issued', 'تم التسجيل وإصدار التذكرة', v_ticket; return;
    exception when unique_violation then
      select jsonb_build_object(
        'ticket_id', t.id, 'ticket_number', t.ticket_number, 'qr_token', t.qr_token, 'ticket_status', t.status,
        'issued_at', t.issued_at, 'event_title', coalesce(v_event.title_ar, v_event.title_en, ''),
        'event_date', v_event.event_date, 'event_time', v_event.event_time,
        'visitor_name', btrim(p_visitor_name), 'phone', btrim(p_phone), 'seats', v_seats, 'booking_id', v_id, 'event_id', p_event_id
      ) into v_ticket from public.event_tickets t where t.booking_id = v_id limit 1;
      if v_ticket is not null then
        update public.event_bookings set ticket_id = (v_ticket->>'ticket_id')::uuid, updated_at = now() where id = v_id;
        return query select true, v_id, 'ticket_issued', 'تم التسجيل وإصدار التذكرة', v_ticket; return;
      end if;
    end;
  end if;

  return query select true, v_id, 'pending', 'تم استلام التسجيل', null::jsonb;
exception
  when unique_violation then
    -- best-effort: return existing booking/ticket for same phone+event if identifiable
    begin
      v_norm_phone := public.normalize_event_phone(p_phone);
      if v_norm_phone is null then
        return query select false, null::uuid, 'duplicate', 'يوجد تسجيل سابق لهذه الفعالية', null::jsonb; return;
      end if;
      select count(*) into v_dup_count from public.event_bookings b
      where b.event_id = p_event_id
        and public.normalize_event_phone(b.phone) = v_norm_phone
        and coalesce(b.status,'pending') not in ('rejected','cancelled');
      if v_dup_count > 1 then
        return query select false, null::uuid, 'duplicate', 'تعذر التحقق من التسجيل السابق. يرجى التواصل مع الفريق.', null::jsonb; return;
      end if;
      select b.id into v_dup from public.event_bookings b
      where b.event_id = p_event_id
        and public.normalize_event_phone(b.phone) = v_norm_phone
        and coalesce(b.status,'pending') not in ('rejected','cancelled')
      order by b.created_at asc limit 1;
      if v_dup is not null then
        select jsonb_build_object(
          'ticket_id', t.id, 'ticket_number', t.ticket_number, 'qr_token', t.qr_token, 'ticket_status', t.status,
          'issued_at', t.issued_at, 'used_at', t.used_at,
          'event_title', coalesce(e.title_ar, e.title_en, ''), 'event_date', e.event_date, 'event_time', e.event_time,
          'visitor_name', b.visitor_name, 'phone', b.phone, 'seats', greatest(coalesce(b.seats,1),1),
          'booking_id', b.id, 'event_id', b.event_id, 'booking_status', b.status
        ) into v_ticket
        from public.event_bookings b
        join public.events e on e.id=b.event_id
        left join public.event_tickets t on t.booking_id=b.id
        where b.id=v_dup limit 1;
        if v_ticket is not null and (v_ticket->>'ticket_number') is not null then
          return query select true, v_dup, 'ticket_exists', 'لديك تسجيل وتذكرة سابقة لهذه الفعالية', v_ticket; return;
        end if;
        return query select true, v_dup, 'already_registered', 'يوجد تسجيل سابق لهذه الفعالية', v_ticket; return;
      end if;
    exception when others then null;
    end;
    return query select false, null::uuid, 'duplicate', 'يوجد تسجيل سابق لهذه الفعالية', null::jsonb;
  when others then return query select false, null::uuid, 'error', 'تعذر حفظ التسجيل حالياً', null::jsonb;
end;
$$;

revoke all on function public.register_for_event(uuid,text,text,integer,text) from public;
grant execute on function public.register_for_event(uuid,text,text,integer,text) to anon, authenticated;

commit;
