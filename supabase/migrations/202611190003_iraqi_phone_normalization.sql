-- Keep all phone-gated ticket paths on the same strict Iraqi mobile canonicalization.
-- Safe forward patch for databases that already have the prior ticket RPCs installed.
-- This migration changes functions only; it does not rewrite or delete booking rows.

begin;

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

-- An expression index created with an earlier helper body must be rebuilt after replacing it.
reindex index public.idx_event_bookings_event_phone_canonical;

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

create or replace function public.get_my_event_ticket(p_booking_id uuid, p_phone text)
returns table(
  ok boolean,
  state text,
  message text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm_phone text;
  v_b record;
  v_t record;
  v_flags record;
begin
  if p_booking_id is null or coalesce(btrim(p_phone), '') = '' then
    return query select false, 'invalid', 'بيانات التحقق مطلوبة', null::jsonb;
    return;
  end if;
  v_norm_phone := public.normalize_event_phone(p_phone);
  if v_norm_phone is null then
    return query select false, 'invalid', 'بيانات التحقق مطلوبة', null::jsonb;
    return;
  end if;

  select b.id as booking_id, b.event_id, b.visitor_name, b.phone, b.seats, b.status as booking_status,
         b.ticket_id, b.created_at,
         e.title_ar, e.title_en, e.event_date, e.event_time, e.tickets_enabled
  into v_b
  from public.event_bookings b
  join public.events e on e.id = b.event_id
  where b.id = p_booking_id
    and public.normalize_event_phone(b.phone) = v_norm_phone
    and e.published = true;

  if not found then
    return query select false, 'not_found', 'لم يتم العثور على تسجيل مطابق', null::jsonb;
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
      'seats', greatest(coalesce(v_b.seats,1),1)
    );
    return;
  end if;

  if v_b.ticket_id is null then
    return query select true, 'pending_ticket', 'تم استلام تسجيلك. التذكرة ستظهر هنا بعد إصدارها من الإدارة (عند تفعيلها للتسجيلات المؤهلة).', jsonb_build_object(
      'booking_id', v_b.booking_id,
      'booking_status', v_b.booking_status,
      'event_title', coalesce(v_b.title_ar, v_b.title_en, ''),
      'event_date', v_b.event_date,
      'event_time', v_b.event_time,
      'visitor_name', v_b.visitor_name,
      'seats', greatest(coalesce(v_b.seats,1),1)
    );
    return;
  end if;

  select t.id, t.ticket_number, t.qr_token, t.status, t.issued_at, t.used_at
  into v_t
  from public.event_tickets t
  where t.id = v_b.ticket_id;

  if not found then
    return query select true, 'pending_ticket', 'التذكرة غير متاحة حالياً', jsonb_build_object('booking_id', v_b.booking_id);
    return;
  end if;

  -- Return minimal display payload including qr_token for QR rendering on user's device.
  -- Token must remain unguessable; access is gated by booking_id+phone match.
  return query select true, 'ok', 'تم العثور على التذكرة', jsonb_build_object(
    'booking_id', v_b.booking_id,
    'booking_status', v_b.booking_status,
    'event_id', v_b.event_id,
    'event_title', coalesce(v_b.title_ar, v_b.title_en, ''),
    'event_date', v_b.event_date,
    'event_time', v_b.event_time,
    'visitor_name', v_b.visitor_name,
    'phone', v_b.phone,
    'seats', greatest(coalesce(v_b.seats,1),1),
    'ticket_id', v_t.id,
    'ticket_number', v_t.ticket_number,
    'qr_token', v_t.qr_token,
    'ticket_status', v_t.status,
    'issued_at', v_t.issued_at,
    'used_at', v_t.used_at
  );
end;
$$;
revoke all on function public.get_my_event_ticket(uuid, text) from public;
grant execute on function public.get_my_event_ticket(uuid, text) to anon, authenticated;

create or replace function public.admin_manual_checkin(p_query text, p_event_id uuid default null)
returns table(ok boolean, state text, message text, payload jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_q text := btrim(coalesce(p_query,''));
  v_norm text := public.normalize_event_phone(v_q);
  v_t record;
begin
  select exists(select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin') into v_is_admin;
  if not coalesce(v_is_admin,false) then return query select false,'forbidden','غير مصرح',null::jsonb; return; end if;
  if v_q = '' then return query select false,'invalid','أدخل رقم التذكرة أو رقم الهاتف أو معرّف الحجز',null::jsonb; return; end if;

  select
    t.id as ticket_id, t.ticket_number, t.qr_token, t.status, t.used_at, t.event_id, t.booking_id,
    b.visitor_name, b.phone, b.seats, b.status as booking_status,
    e.title_ar, e.title_en, e.event_date, e.event_time, e.qr_checkin_enabled
  into v_t
  from public.event_tickets t
  join public.event_bookings b on b.id = t.booking_id
  join public.events e on e.id = t.event_id
  where (
      upper(t.ticket_number) = upper(v_q)
      or t.booking_id::text = v_q
      or (v_norm is not null and public.normalize_event_phone(b.phone) = v_norm)
    )
    and (p_event_id is null or t.event_id = p_event_id)
  order by (upper(t.ticket_number)=upper(v_q)) desc, (t.booking_id::text=v_q) desc, t.issued_at desc
  limit 1
  for update of t;

  if not found then return query select false,'not_found','لم يتم العثور على تذكرة مطابقة',null::jsonb; return; end if;
  if not coalesce(v_t.qr_checkin_enabled,false) then
    return query select false,'disabled','التحقق من الحضور غير مفعّل لهذه الفعالية',to_jsonb(v_t); return;
  end if;
  if v_t.status = 'used' then return query select true,'used','تم تسجيل الحضور مسبقاً',to_jsonb(v_t); return; end if;
  if v_t.status = 'cancelled' then return query select false,'cancelled','التذكرة ملغاة',to_jsonb(v_t); return; end if;
  if v_t.status <> 'valid' then return query select false,v_t.status,'التذكرة غير صالحة',to_jsonb(v_t); return; end if;

  update public.event_tickets set status='used', used_at=now(), checked_in_by=auth.uid(), updated_at=now() where id=v_t.ticket_id;
  update public.event_bookings set attended_at=coalesce(attended_at,now()), checked_in_at=coalesce(checked_in_at,now()), updated_at=now(), updated_by=auth.uid() where id=v_t.booking_id;

  return query select true,'checked_in','تم تأكيد الحضور',to_jsonb(v_t)||jsonb_build_object('checked_in_now',true);
end;
$$;
revoke all on function public.admin_manual_checkin(text, uuid) from public;
grant execute on function public.admin_manual_checkin(text, uuid) to authenticated;

commit;
