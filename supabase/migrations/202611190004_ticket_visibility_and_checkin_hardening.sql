-- Forward-only ticket lifecycle hardening.
-- Adds the event-level attendee visibility option used by the admin UI and
-- aligns public lookup, ticket issuance, and check-in with persisted state.
-- Existing event/booking/ticket rows are not deleted or rewritten.
-- Prerequisite to verify before applying: pgcrypto provides
-- extensions.gen_random_bytes(integer), as expected by THE_ZONE_FINAL_MIGRATION.sql.

begin;

-- Stop if the live schema is not the repository's expected RPC generation.
-- This prevents replacing a four-column/legacy overload or a differently
-- authorized implementation without an explicit live compatibility review.
do $$
declare
  v_def text;
  v_count integer;
begin
  if to_regclass('public.events') is null or to_regclass('public.event_bookings') is null
     or to_regclass('public.event_tickets') is null or to_regclass('public.admins') is null then
    raise exception 'Ticket migration stopped: expected public event/ticket tables are missing.';
  end if;
  if to_regprocedure('public.normalize_event_phone(text)') is null
     or to_regprocedure('public.event_occupied_seats(uuid)') is null
     or to_regprocedure('public.register_for_event(uuid,text,text,integer,text)') is null
     or to_regprocedure('public.get_my_event_ticket(uuid,text)') is null
     or to_regprocedure('public.admin_checkin_ticket(text)') is null
     or to_regprocedure('public.admin_manual_checkin(text,uuid)') is null then
    raise exception 'Ticket migration stopped: one or more expected ticket RPC signatures are missing.';
  end if;
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='register_for_event';
  if v_count <> 1 then raise exception 'Ticket migration stopped: unexpected register_for_event overload count (%).', v_count; end if;
  if pg_get_function_result('public.register_for_event(uuid,text,text,integer,text)'::regprocedure)
       <> 'TABLE(ok boolean, booking_id uuid, state text, message text, ticket jsonb)' then
    raise exception 'Ticket migration stopped: register_for_event return contract differs from the expected five-column contract.';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid='public.register_for_event(uuid,text,text,integer,text)'::regprocedure) then
    raise exception 'Ticket migration stopped: register_for_event is not SECURITY DEFINER.';
  end if;
  v_def := lower(pg_get_functiondef('public.register_for_event(uuid,text,text,integer,text)'::regprocedure));
  if position('normalize_event_phone' in v_def)=0 or position('event_tickets' in v_def)=0 then
    raise exception 'Ticket migration stopped: register_for_event body does not match the expected phone-normalized ticket flow.';
  end if;
end
$$;

alter table public.events
  add column if not exists show_ticket_to_attendee boolean not null default true;

do $$ begin
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'Prerequisite missing: extensions.gen_random_bytes(integer). Verify the installed pgcrypto extension schema before applying.';
  end if;
end $$;

-- New function name preserves the existing public flag RPC signatures and grants.
create or replace function public.get_published_events_ticket_flags()
returns table(event_id uuid, capacity_enabled boolean, is_full boolean, tickets_enabled boolean, qr_checkin_enabled boolean, registration_open boolean, show_ticket_to_attendee boolean)
language sql security definer set search_path = public stable
as $$
  select e.id, coalesce(e.capacity_enabled,false),
    case when coalesce(e.capacity_enabled,false) and e.total_seats is not null
      then public.event_occupied_seats(e.id) >= e.total_seats else false end,
    coalesce(e.tickets_enabled,false), coalesce(e.qr_checkin_enabled,false),
    coalesce(e.registration_open,true), coalesce(e.show_ticket_to_attendee,true)
  from public.events e where e.published = true;
$$;
revoke all on function public.get_published_events_ticket_flags() from public;
grant execute on function public.get_published_events_ticket_flags() to anon, authenticated;

-- The event row lock serializes capacity and duplicate checks. Ticket issuance
-- is in the same transaction; a persistent issuance failure rolls back booking.
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
  v_seats integer := greatest(coalesce(p_seats,1),1);
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
  if p_event_id is null then return query select false,null::uuid,'error','معرّف الفعالية مطلوب',null::jsonb; return; end if;
  if coalesce(btrim(p_visitor_name),'') = '' then return query select false,null::uuid,'error','الاسم مطلوب',null::jsonb; return; end if;
  if coalesce(btrim(p_phone),'') = '' then return query select false,null::uuid,'error','رقم الهاتف مطلوب',null::jsonb; return; end if;
  v_seats := least(v_seats,20);

  select * into v_event from public.events where id=p_event_id and published=true for update;
  if not found then return query select false,null::uuid,'error','الفعالية غير متاحة حالياً',null::jsonb; return; end if;
  if not coalesce(v_event.registration_open,true) then
    return query select false,null::uuid,'closed','التسجيل مغلق لهذه الفعالية حالياً',null::jsonb; return;
  end if;

  v_norm_phone := public.normalize_event_phone(p_phone);
  if v_norm_phone is null then return query select false,null::uuid,'error','رقم الهاتف غير صالح',null::jsonb; return; end if;

  select count(*) into v_dup_count from public.event_bookings b
  where b.event_id=p_event_id and public.normalize_event_phone(b.phone)=v_norm_phone
    and coalesce(b.status,'pending') not in ('rejected','cancelled');
  if v_dup_count > 1 then
    return query select false,null::uuid,'duplicate','تعذر التحقق من التسجيل السابق. يرجى التواصل مع الفريق.',null::jsonb; return;
  end if;
  select b.id into v_dup from public.event_bookings b
  where b.event_id=p_event_id and public.normalize_event_phone(b.phone)=v_norm_phone
    and coalesce(b.status,'pending') not in ('rejected','cancelled')
  order by b.created_at asc limit 1;
  if v_dup is not null then
    if coalesce(v_event.tickets_enabled,false) then
      select case when coalesce(v_event.show_ticket_to_attendee,true) then jsonb_build_object(
        'ticket_issued',t.id is not null,'ticket_id',t.id,'ticket_number',t.ticket_number,
        'qr_token',case when t.status='valid' then t.qr_token else null end,
        'ticket_status',t.status,'issued_at',t.issued_at,'used_at',t.used_at,
        'event_title',coalesce(v_event.title_ar,v_event.title_en,''),'event_date',v_event.event_date,'event_time',v_event.event_time,
        'visitor_name',b.visitor_name,'phone',b.phone,'seats',greatest(coalesce(b.seats,1),1),
        'booking_id',b.id,'event_id',b.event_id,'booking_status',b.status,'show_ticket_to_attendee',true
      ) else jsonb_build_object(
        'ticket_issued',t.id is not null,'booking_id',b.id,'event_id',b.event_id,'booking_status',b.status,
        'visitor_name',b.visitor_name,'event_title',coalesce(v_event.title_ar,v_event.title_en,''),
        'event_date',v_event.event_date,'event_time',v_event.event_time,'show_ticket_to_attendee',false
      ) end into v_ticket
      from public.event_bookings b
      left join public.event_tickets t on t.booking_id=b.id and t.event_id=b.event_id
      where b.id=v_dup limit 1;
    else
      select jsonb_build_object('booking_id',b.id,'event_id',b.event_id,'booking_status',b.status,
        'visitor_name',b.visitor_name,'event_title',coalesce(v_event.title_ar,v_event.title_en,''),
        'event_date',v_event.event_date,'event_time',v_event.event_time)
      into v_ticket from public.event_bookings b where b.id=v_dup;
    end if;
    if coalesce((v_ticket->>'ticket_issued')::boolean,false) then
      return query select true,v_dup,'ticket_exists','لديك تسجيل وتذكرة سابقة لهذه الفعالية',v_ticket; return;
    end if;
    return query select true,v_dup,'already_registered','يوجد تسجيل سابق لهذه الفعالية بنفس رقم الهاتف',v_ticket; return;
  end if;

  if coalesce(v_event.capacity_enabled,false) and v_event.total_seats is not null then
    v_taken := public.event_occupied_seats(p_event_id);
    if v_taken + v_seats > v_event.total_seats then return query select false,null::uuid,'full','اكتمل التسجيل',null::jsonb; return; end if;
  end if;

  insert into public.event_bookings(event_id,visitor_name,phone,seats,status,participant_email)
  values(p_event_id,btrim(p_visitor_name),btrim(p_phone),v_seats,'pending',nullif(btrim(coalesce(p_participant_email,'')),''))
  returning id into v_id;

  if coalesce(v_event.tickets_enabled,false) then
    for v_attempt in 1..3 loop
      v_token := encode(extensions.gen_random_bytes(24),'hex');
      v_num := 'TZ-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
      begin
        insert into public.event_tickets(event_id,booking_id,ticket_number,qr_token,status)
        values(p_event_id,v_id,v_num,v_token,'valid') returning id into v_ticket_id;
      exception when unique_violation then
        select t.id into v_ticket_id from public.event_tickets t
        where t.booking_id=v_id and t.event_id=p_event_id limit 1;
        if v_ticket_id is null and v_attempt=3 then raise; end if;
      end;
      exit when v_ticket_id is not null;
    end loop;
    if v_ticket_id is null then raise exception 'ticket issuance failed'; end if;
    update public.event_bookings set ticket_id=v_ticket_id,updated_at=now() where id=v_id;
    select case when coalesce(v_event.show_ticket_to_attendee,true) then jsonb_build_object(
      'ticket_issued',true,'ticket_id',t.id,'ticket_number',t.ticket_number,
      'qr_token',case when t.status='valid' then t.qr_token else null end,
      'ticket_status',t.status,'issued_at',t.issued_at,'event_title',coalesce(v_event.title_ar,v_event.title_en,''),
      'event_date',v_event.event_date,'event_time',v_event.event_time,
      'visitor_name',btrim(p_visitor_name),'phone',btrim(p_phone),'seats',v_seats,
      'booking_id',v_id,'event_id',p_event_id,'show_ticket_to_attendee',true
    ) else jsonb_build_object(
      'ticket_issued',true,'booking_id',v_id,'event_id',p_event_id,'visitor_name',btrim(p_visitor_name),
      'event_title',coalesce(v_event.title_ar,v_event.title_en,''),'event_date',v_event.event_date,
      'event_time',v_event.event_time,'show_ticket_to_attendee',false
    ) end into v_ticket from public.event_tickets t
    where t.id=v_ticket_id and t.booking_id=v_id and t.event_id=p_event_id;
    if v_ticket is null then raise exception 'ticket association failed'; end if;
    return query select true,v_id,'ticket_issued','تم التسجيل وإصدار التذكرة',v_ticket; return;
  end if;
  return query select true,v_id,'pending','تم استلام التسجيل',null::jsonb;
exception
  when unique_violation then return query select false,null::uuid,'duplicate','يوجد تسجيل سابق لهذه الفعالية',null::jsonb;
  when others then return query select false,null::uuid,'error','تعذر إكمال التسجيل حالياً. يرجى المحاولة مرة أخرى.',null::jsonb;
end;
$$;
revoke all on function public.register_for_event(uuid,text,text,integer,text) from public;
grant execute on function public.register_for_event(uuid,text,text,integer,text) to anon, authenticated;

-- Attendee lookup is gated by booking UUID + strict canonical phone match.
-- It also verifies the ticket belongs to this booking and event and enforces
-- the persisted attendee-visibility preference before returning any QR token.
create or replace function public.get_my_event_ticket(p_booking_id uuid,p_phone text)
returns table(ok boolean,state text,message text,payload jsonb)
language plpgsql security definer set search_path = public
as $$
declare
  v_norm_phone text;
  v_b record;
  v_t record;
begin
  if p_booking_id is null then return query select false,'invalid','بيانات التحقق مطلوبة',null::jsonb; return; end if;
  v_norm_phone := public.normalize_event_phone(p_phone);
  if v_norm_phone is null then return query select false,'invalid','بيانات التحقق مطلوبة',null::jsonb; return; end if;

  select b.id as booking_id,b.event_id,b.visitor_name,b.phone,b.seats,b.status as booking_status,
    e.title_ar,e.title_en,e.event_date,e.event_time,e.tickets_enabled,e.show_ticket_to_attendee
  into v_b from public.event_bookings b join public.events e on e.id=b.event_id
  -- An attendee's booking+phone pair remains usable after an event is unpublished.
  where b.id=p_booking_id and public.normalize_event_phone(b.phone)=v_norm_phone;
  if not found then return query select false,'not_found','لم يتم العثور على تسجيل مطابق',null::jsonb; return; end if;
  if coalesce(v_b.booking_status,'pending') in ('rejected','cancelled') then
    return query select false,'ineligible','هذا التسجيل غير مؤهل لعرض تذكرة',null::jsonb; return;
  end if;
  if not coalesce(v_b.tickets_enabled,false) then
    return query select true,'tickets_disabled','التذاكر الرقمية غير مفعلة لهذه الفعالية',jsonb_build_object(
      'booking_id',v_b.booking_id,'booking_status',v_b.booking_status,'event_title',coalesce(v_b.title_ar,v_b.title_en,''),
      'event_date',v_b.event_date,'event_time',v_b.event_time,'visitor_name',v_b.visitor_name,'seats',greatest(coalesce(v_b.seats,1),1)); return;
  end if;
  if not coalesce(v_b.show_ticket_to_attendee,true) then
    return query select true,'hidden_from_attendee','تم استلام تسجيلك. يرجى التواصل مع الفريق بشأن التذكرة.',jsonb_build_object(
      'booking_id',v_b.booking_id,'booking_status',v_b.booking_status,'event_id',v_b.event_id,
      'event_title',coalesce(v_b.title_ar,v_b.title_en,''),'event_date',v_b.event_date,'event_time',v_b.event_time,
      'visitor_name',v_b.visitor_name,'seats',greatest(coalesce(v_b.seats,1),1),'show_ticket_to_attendee',false); return;
  end if;
  select t.id,t.booking_id,t.event_id,t.ticket_number,t.qr_token,t.status,t.issued_at,t.used_at
  into v_t from public.event_tickets t
  where t.booking_id=v_b.booking_id and t.event_id=v_b.event_id;
  if not found then
    return query select true,'pending_ticket','تم استلام تسجيلك. التذكرة بانتظار الإصدار.',jsonb_build_object(
      'booking_id',v_b.booking_id,'booking_status',v_b.booking_status,'event_id',v_b.event_id,
      'event_title',coalesce(v_b.title_ar,v_b.title_en,''),'event_date',v_b.event_date,'event_time',v_b.event_time,
      'visitor_name',v_b.visitor_name,'seats',greatest(coalesce(v_b.seats,1),1),'show_ticket_to_attendee',true); return;
  end if;
  return query select true,'ok','تم العثور على التذكرة',jsonb_build_object(
    'booking_id',v_b.booking_id,'booking_status',v_b.booking_status,'event_id',v_b.event_id,
    'event_title',coalesce(v_b.title_ar,v_b.title_en,''),'event_date',v_b.event_date,'event_time',v_b.event_time,
    'visitor_name',v_b.visitor_name,'phone',v_b.phone,'seats',greatest(coalesce(v_b.seats,1),1),
    'ticket_id',v_t.id,'ticket_number',v_t.ticket_number,
    'qr_token',case when v_t.status='valid' then v_t.qr_token else null end,'ticket_status',v_t.status,
    'issued_at',v_t.issued_at,'used_at',v_t.used_at,'show_ticket_to_attendee',true);
end;
$$;
revoke all on function public.get_my_event_ticket(uuid,text) from public;
grant execute on function public.get_my_event_ticket(uuid,text) to anon, authenticated;

-- Single check-in implementation, optionally constrained to an event. Locking
-- both ticket and booking rows makes concurrent scans serialize before status changes.
create or replace function public.admin_checkin_ticket_for_event(p_token text,p_event_id uuid default null)
returns table(ok boolean,state text,message text,payload jsonb)
language plpgsql security definer set search_path = public
as $$
declare
  v_is_admin boolean;
  v_t record;
  v_changed integer;
begin
  select exists(select 1 from public.admins a where a.user_id=auth.uid() and a.role='admin') into v_is_admin;
  if not coalesce(v_is_admin,false) then return query select false,'forbidden','غير مصرح',null::jsonb; return; end if;
  if coalesce(btrim(p_token),'')='' then return query select false,'invalid','رمز التذكرة مطلوب',null::jsonb; return; end if;
  select t.event_id into v_t from public.event_tickets t where t.qr_token=btrim(p_token);
  if not found then return query select false,'invalid','تذكرة غير صالحة',null::jsonb; return; end if;
  if p_event_id is not null and v_t.event_id<>p_event_id then
    return query select false,'wrong_event','هذه التذكرة تخص فعالية أخرى',null::jsonb; return;
  end if;
  select t.id as ticket_id,t.ticket_number,t.status,t.used_at,t.event_id,t.booking_id,
    b.visitor_name,b.phone,b.seats,b.status as booking_status,
    e.title_ar,e.title_en,e.event_date,e.event_time,e.qr_checkin_enabled
  into v_t from public.event_tickets t
  join public.event_bookings b on b.id=t.booking_id
  join public.events e on e.id=t.event_id
  where t.qr_token=btrim(p_token) and (p_event_id is null or t.event_id=p_event_id)
  for update of t,b;
  if not found then return query select false,'invalid','تذكرة غير صالحة',null::jsonb; return; end if;
  if coalesce(v_t.booking_status,'pending') in ('rejected','cancelled') then
    return query select false,'booking_ineligible','التسجيل المرتبط بهذه التذكرة غير مؤهل',to_jsonb(v_t); return;
  end if;
  if not coalesce(v_t.qr_checkin_enabled,false) then return query select false,'disabled','التحقق من الحضور غير مفعّل لهذه الفعالية',to_jsonb(v_t); return; end if;
  if v_t.status='used' then return query select true,'used','تم تسجيل الحضور مسبقاً',to_jsonb(v_t); return; end if;
  if v_t.status='cancelled' then return query select false,'cancelled','التذكرة ملغاة',to_jsonb(v_t); return; end if;
  if v_t.status<>'valid' then return query select false,'invalid','التذكرة غير صالحة',to_jsonb(v_t); return; end if;
  update public.event_tickets set status='used',used_at=now(),checked_in_by=auth.uid(),updated_at=now()
    where id=v_t.ticket_id and status='valid';
  get diagnostics v_changed = row_count;
  if v_changed<>1 then return query select false,'conflict','تعذر تسجيل الحضور. تحقق من حالة التذكرة.',to_jsonb(v_t); return; end if;
  update public.event_bookings set attended_at=coalesce(attended_at,now()),checked_in_at=coalesce(checked_in_at,now()),
    updated_at=now(),updated_by=auth.uid() where id=v_t.booking_id;
  return query select true,'checked_in','تم تأكيد الحضور',to_jsonb(v_t)||jsonb_build_object('checked_in_now',true);
end;
$$;
revoke all on function public.admin_checkin_ticket_for_event(text,uuid) from public, anon;
grant execute on function public.admin_checkin_ticket_for_event(text,uuid) to authenticated;

-- Keep the original one-argument RPC contract for existing admin clients.
create or replace function public.admin_checkin_ticket(p_token text)
returns table(ok boolean,state text,message text,payload jsonb)
language sql security definer set search_path = public
as $$ select * from public.admin_checkin_ticket_for_event(p_token,null::uuid); $$;
revoke all on function public.admin_checkin_ticket(text) from public, anon;
grant execute on function public.admin_checkin_ticket(text) to authenticated;

-- Manual phone lookup refuses legacy phone collisions instead of checking in an
-- arbitrary latest ticket. Booking/ticket status and event constraints are rechecked
-- while the selected rows are locked.
create or replace function public.admin_manual_checkin(p_query text,p_event_id uuid default null)
returns table(ok boolean,state text,message text,payload jsonb)
language plpgsql security definer set search_path = public
as $$
declare
  v_is_admin boolean;
  v_q text := btrim(coalesce(p_query,''));
  v_norm text := public.normalize_event_phone(p_query);
  v_matches integer;
  v_t record;
  v_changed integer;
begin
  select exists(select 1 from public.admins a where a.user_id=auth.uid() and a.role='admin') into v_is_admin;
  if not coalesce(v_is_admin,false) then return query select false,'forbidden','غير مصرح',null::jsonb; return; end if;
  if v_q='' then return query select false,'invalid','أدخل رقم التذكرة أو رقم الهاتف أو معرّف الحجز',null::jsonb; return; end if;
  if v_norm is not null and upper(v_q) !~ '^TZ-[A-F0-9]+$' and v_q !~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then
    select count(*) into v_matches from public.event_tickets t
    join public.event_bookings b on b.id=t.booking_id
    where public.normalize_event_phone(b.phone)=v_norm and (p_event_id is null or t.event_id=p_event_id);
    if v_matches>1 then return query select false,'ambiguous','عُثر على أكثر من تذكرة لهذا الرقم. اختر الفعالية لتحديد التذكرة.',null::jsonb; return; end if;
  end if;
  select t.id as ticket_id,t.ticket_number,t.qr_token,t.status,t.used_at,t.event_id,t.booking_id,
    b.visitor_name,b.phone,b.seats,b.status as booking_status,
    e.title_ar,e.title_en,e.event_date,e.event_time,e.qr_checkin_enabled
  into v_t from public.event_tickets t
  join public.event_bookings b on b.id=t.booking_id
  join public.events e on e.id=t.event_id
  where (upper(t.ticket_number)=upper(v_q) or t.booking_id::text=v_q or (v_norm is not null and public.normalize_event_phone(b.phone)=v_norm))
    and (p_event_id is null or t.event_id=p_event_id)
  order by (upper(t.ticket_number)=upper(v_q)) desc,(t.booking_id::text=v_q) desc,t.issued_at desc
  limit 1 for update of t,b;
  if not found then return query select false,'not_found','لم يتم العثور على تذكرة مطابقة',null::jsonb; return; end if;
  if coalesce(v_t.booking_status,'pending') in ('rejected','cancelled') then
    return query select false,'booking_ineligible','التسجيل المرتبط بهذه التذكرة غير مؤهل',to_jsonb(v_t); return;
  end if;
  if not coalesce(v_t.qr_checkin_enabled,false) then return query select false,'disabled','التحقق من الحضور غير مفعّل لهذه الفعالية',to_jsonb(v_t); return; end if;
  if v_t.status='used' then return query select true,'used','تم تسجيل الحضور مسبقاً',to_jsonb(v_t); return; end if;
  if v_t.status='cancelled' then return query select false,'cancelled','التذكرة ملغاة',to_jsonb(v_t); return; end if;
  if v_t.status<>'valid' then return query select false,v_t.status,'التذكرة غير صالحة',to_jsonb(v_t); return; end if;
  update public.event_tickets set status='used',used_at=now(),checked_in_by=auth.uid(),updated_at=now()
    where id=v_t.ticket_id and status='valid';
  get diagnostics v_changed = row_count;
  if v_changed<>1 then return query select false,'conflict','تعذر تسجيل الحضور. تحقق من حالة التذكرة.',to_jsonb(v_t); return; end if;
  update public.event_bookings set attended_at=coalesce(attended_at,now()),checked_in_at=coalesce(checked_in_at,now()),
    updated_at=now(),updated_by=auth.uid() where id=v_t.booking_id;
  return query select true,'checked_in','تم تأكيد الحضور',to_jsonb(v_t)||jsonb_build_object('checked_in_now',true);
end;
$$;
revoke all on function public.admin_manual_checkin(text,uuid) from public, anon;
grant execute on function public.admin_manual_checkin(text,uuid) to authenticated;

commit;
