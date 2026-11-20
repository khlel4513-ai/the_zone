-- Restore the event configuration columns written by the current admin form.
-- Forward-only and additive: existing event rows and settings are preserved.
-- Definitions below match the original feature migrations; no policies or grants change.

begin;

alter table public.events
  add column if not exists capacity_enabled boolean not null default false,
  add column if not exists total_seats integer,
  add column if not exists tickets_enabled boolean not null default false,
  add column if not exists qr_checkin_enabled boolean not null default false,
  add column if not exists registration_open boolean not null default true,
  add column if not exists show_ticket_to_attendee boolean not null default true;

-- IF NOT EXISTS does not verify an already-present column's definition. Stop
-- instead of silently accepting a conflicting production schema.
do $$
declare
  v_expected record;
  v_type text;
  v_not_null boolean;
  v_default text;
  v_named_constraint_exists boolean;
  v_named_constraint_matches boolean;
  v_matching_constraint_exists boolean;
begin
  for v_expected in
    select * from (values
      ('capacity_enabled', 'boolean', true, 'false'),
      ('total_seats', 'integer', false, ''),
      ('tickets_enabled', 'boolean', true, 'false'),
      ('qr_checkin_enabled', 'boolean', true, 'false'),
      ('registration_open', 'boolean', true, 'true'),
      ('show_ticket_to_attendee', 'boolean', true, 'true')
    ) as expected(column_name, data_type, is_not_null, default_value)
  loop
    select format_type(a.atttypid, a.atttypmod), a.attnotnull,
           coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      into v_type, v_not_null, v_default
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relname = 'events'
      and a.attname = v_expected.column_name and a.attnum > 0 and not a.attisdropped;

    -- Normalize harmless PostgreSQL casts/parentheses for default comparison.
    v_default := lower(regexp_replace(v_default, '::[a-zA-Z0-9_. ]+', '', 'g'));
    v_default := replace(replace(replace(v_default, '(', ''), ')', ''), '''', '');

    if v_type is distinct from v_expected.data_type
       or v_not_null is distinct from v_expected.is_not_null
       or v_default is distinct from v_expected.default_value then
      raise exception 'Incompatible public.events.% definition (type %, NOT NULL %, default %); expected type %, NOT NULL %, default %.',
        v_expected.column_name, v_type, v_not_null, v_default,
        v_expected.data_type, v_expected.is_not_null, v_expected.default_value;
    end if;
  end loop;

  -- Match the constraint established by the original ticket/capacity migration.
  select exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.events'::regclass and c.conname = 'events_total_seats_positive_chk'
  ) into v_named_constraint_exists;
  select exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.events'::regclass and c.conname = 'events_total_seats_positive_chk'
      and c.contype = 'c'
      and regexp_replace(lower(pg_get_constraintdef(c.oid)), '[()[:space:]]', '', 'g')
          = 'checktotal_seatsisnullortotal_seats>=1'
  ) into v_named_constraint_matches;
  select exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.events'::regclass and c.contype = 'c'
      and regexp_replace(lower(pg_get_constraintdef(c.oid)), '[()[:space:]]', '', 'g')
          = 'checktotal_seatsisnullortotal_seats>=1'
  ) into v_matching_constraint_exists;

  if v_named_constraint_exists and not v_named_constraint_matches then
    raise exception 'Constraint events_total_seats_positive_chk exists with an incompatible definition.';
  elsif not v_matching_constraint_exists then
    -- NOT VALID preserves pre-existing values while enforcing the rule for
    -- subsequent inserts/updates; historical rows are not rewritten or scanned.
    alter table public.events
      add constraint events_total_seats_positive_chk
      check (total_seats is null or total_seats >= 1) not valid;
  end if;
end
$$;

commit;
