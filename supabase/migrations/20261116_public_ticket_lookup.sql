-- Secure public ticket lookup (no user accounts). Additive.
-- Allows a visitor to retrieve their own ticket details only when they provide
-- the booking_id (returned at registration time in a secure client flow) AND
-- the phone number that matches the booking. Returns minimal data for display/printing.
-- Does NOT expose other bookings, does NOT allow admin actions, does NOT expose seat counts.
-- IMPORTANT: for this to be safe, do not publicly enumerate booking_ids; only the
-- registrant receives booking_id in the success response. Keep response minimal.

begin;

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
  v_norm_phone := regexp_replace(p_phone, '[\s\-()+]', '', 'g');

  select b.id as booking_id, b.event_id, b.visitor_name, b.phone, b.seats, b.status as booking_status,
         b.ticket_id, b.created_at,
         e.title_ar, e.title_en, e.event_date, e.event_time, e.tickets_enabled
  into v_b
  from public.event_bookings b
  join public.events e on e.id = b.event_id
  where b.id = p_booking_id
    and regexp_replace(coalesce(b.phone,''), '[\s\-()+]', '', 'g') = v_norm_phone
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

-- Optional convenience: allow admin-verified auto-issue on successful registration can be done
-- separately via admin workflow/RPC; issuing automatically for public anon would require
-- careful policy. Kept manual/admin-controlled to respect "only after real successful registration/eligibility".

commit;
