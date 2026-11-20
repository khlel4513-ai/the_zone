-- Admin helper RPCs for smart dashboard (additive, admin-only, security definer).
-- Provides ticket list/issue/cancel and activity logging helpers without exposing service role.

begin;

create or replace function public.admin_log_activity(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_email text;
  v_id uuid;
begin
  select exists(select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin') into v_is_admin;
  if not coalesce(v_is_admin, false) then
    raise exception 'forbidden';
  end if;
  select email into v_email from auth.users where id = auth.uid();
  insert into public.admin_activity_log(actor_user_id, actor_email, action, entity_type, entity_id, details)
  values (auth.uid(), v_email, coalesce(p_action,'action'), p_entity_type, p_entity_id, coalesce(p_details,'{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.admin_log_activity(text,text,text,jsonb) from public;
grant execute on function public.admin_log_activity(text,text,text,jsonb) to authenticated;

-- List tickets with booking/event context (admin only). RLS on event_tickets is admin-only; this is convenience.
create or replace function public.admin_list_tickets(p_event_id uuid default null, p_status text default null, p_limit int default 500)
returns table(
  ticket_id uuid,
  ticket_number text,
  qr_token text,
  ticket_status text,
  issued_at timestamptz,
  used_at timestamptz,
  booking_id uuid,
  booking_status text,
  visitor_name text,
  phone text,
  seats integer,
  event_id uuid,
  event_title text,
  event_date date,
  event_time time
)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.id, t.ticket_number, t.qr_token, t.status, t.issued_at, t.used_at,
    b.id, b.status, b.visitor_name, b.phone, coalesce(b.seats,1),
    e.id, coalesce(e.title_ar, e.title_en, ''), e.event_date, e.event_time
  from public.event_tickets t
  join public.event_bookings b on b.id = t.booking_id
  join public.events e on e.id = t.event_id
  where exists(select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin')
    and (p_event_id is null or t.event_id = p_event_id)
    and (p_status is null or p_status = '' or t.status = p_status)
  order by t.issued_at desc nulls last
  limit greatest(1, least(coalesce(p_limit,500), 2000));
$$;
revoke all on function public.admin_list_tickets(uuid,text,int) from public;
grant execute on function public.admin_list_tickets(uuid,text,int) to authenticated;

create or replace function public.admin_cancel_ticket(p_ticket_id uuid, p_reason text default null)
returns table(ok boolean, state text, message text)
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
    return query select false, 'forbidden', 'غير مصرح';
    return;
  end if;
  select * into v_t from public.event_tickets where id = p_ticket_id for update;
  if not found then return query select false, 'not_found', 'التذكرة غير موجودة'; return; end if;
  if v_t.status = 'used' then
    return query select false, 'used', 'لا يمكن إلغاء تذكرة تم استخدامها بالفعل';
    return;
  end if;
  update public.event_tickets set status = 'cancelled', notes = coalesce(notes,'') || case when p_reason is not null and btrim(p_reason)<>'' then (' | إلغاء: '||btrim(p_reason)) else '' end, updated_at = now() where id = p_ticket_id;
  update public.event_bookings set ticket_id = ticket_id, updated_at = now() where id = v_t.booking_id;
  return query select true, 'cancelled', 'تم إلغاء التذكرة';
end;
$$;
revoke all on function public.admin_cancel_ticket(uuid,text) from public;
grant execute on function public.admin_cancel_ticket(uuid,text) to authenticated;

commit;
