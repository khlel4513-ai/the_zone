-- Read-only preflight after 202611190001_event_registration_status.sql has installed
-- normalize_event_phone. Review results before relying on canonical phone matching.
-- This script only selects data; it does not alter bookings.

-- Invalid or legacy formats are reported separately and are never used as phone matches.
select id as booking_id, event_id, phone, status
from public.event_bookings
where public.normalize_event_phone(phone) is null
order by event_id, created_at;

-- More than one active booking for an event and canonical phone is ambiguous.
-- The registration RPC refuses to return a booking or QR payload for such a collision.
select
  event_id,
  public.normalize_event_phone(phone) as canonical_phone,
  count(*) as active_booking_count,
  array_agg(id order by created_at) as booking_ids
from public.event_bookings
where public.normalize_event_phone(phone) is not null
  and coalesce(status, 'pending') not in ('rejected', 'cancelled')
group by event_id, public.normalize_event_phone(phone)
having count(*) > 1
order by event_id, canonical_phone;
