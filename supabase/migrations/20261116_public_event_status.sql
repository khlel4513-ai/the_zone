-- Public-safe event capacity/ticket flags (no counts exposed). Additive.
-- Allows public site to know only whether registration is open/full/tickets-enabled without revealing seat numbers.

begin;

create or replace function public.get_event_public_flags(p_event_id uuid)
returns table(
  event_id uuid,
  capacity_enabled boolean,
  is_full boolean,
  tickets_enabled boolean,
  qr_checkin_enabled boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    e.id,
    coalesce(e.capacity_enabled,false),
    case
      when coalesce(e.capacity_enabled,false) = true and e.total_seats is not null
        then public.event_occupied_seats(e.id) >= e.total_seats
      else false
    end as is_full,
    coalesce(e.tickets_enabled,false),
    coalesce(e.qr_checkin_enabled,false)
  from public.events e
  where e.id = p_event_id and e.published = true;
$$;

grant execute on function public.get_event_public_flags(uuid) to anon, authenticated;

-- Batch version for listing
create or replace function public.get_published_events_public_flags()
returns table(
  event_id uuid,
  capacity_enabled boolean,
  is_full boolean,
  tickets_enabled boolean,
  qr_checkin_enabled boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    e.id,
    coalesce(e.capacity_enabled,false),
    case
      when coalesce(e.capacity_enabled,false) = true and e.total_seats is not null
        then public.event_occupied_seats(e.id) >= e.total_seats
      else false
    end as is_full,
    coalesce(e.tickets_enabled,false),
    coalesce(e.qr_checkin_enabled,false)
  from public.events e
  where e.published = true;
$$;

grant execute on function public.get_published_events_public_flags() to anon, authenticated;

commit;
