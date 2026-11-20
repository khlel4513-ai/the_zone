-- THE ZONE production ticketing inventory. Strictly read-only; no migration is applied.
-- Run in the intended Supabase SQL Editor project. Confirm the project reference in the Dashboard;
-- PostgreSQL SQL Editor does not expose a reliable project-ref setting to this query.
-- Returns exactly one row and one JSON text column. No attendee PII, booking IDs, or ticket secrets.

with
user_schemas as (
  select n.oid, n.nspname
  from pg_namespace n
  where n.nspname <> 'information_schema'
    and left(n.nspname,3) <> 'pg_'
),
relation_catalog as (
  select c.oid, n.nspname as schema_name, c.relname as table_name,
    c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    coalesce((select array_agg(a.attname::text order by a.attnum)
      from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped), array[]::text[]) as columns,
    (select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      and a.attname = any(array['id','booking_id','registration_id','ticket_id','ticket_uuid'])
      order by case a.attname when 'id' then 1 when 'booking_id' then 2 when 'registration_id' then 3 else 4 end limit 1) as id_column,
    (select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      and a.attname = any(array['event_id','event_uuid']) order by case a.attname when 'event_id' then 1 else 2 end limit 1) as event_column,
    (select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      and a.attname = any(array['phone','phone_number','mobile','mobile_phone','contact_phone'])
      order by case a.attname when 'phone' then 1 when 'phone_number' then 2 when 'mobile_phone' then 3 when 'mobile' then 4 else 5 end limit 1) as phone_column,
    (select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      and a.attname = any(array['booking_id','registration_id','event_booking_id','booking_uuid'])
      order by case a.attname when 'booking_id' then 1 when 'event_booking_id' then 2 when 'registration_id' then 3 else 4 end limit 1) as booking_ref_column,
    (select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      and a.attname = any(array['ticket_id','ticket_uuid','ticket_number','ticket_code','qr_token'])
      order by case a.attname when 'ticket_id' then 1 when 'ticket_uuid' then 2 when 'ticket_number' then 3 when 'ticket_code' then 4 else 5 end limit 1) as ticket_ref_column,
    (coalesce(has_schema_privilege(current_user,n.oid,'USAGE'),false)
      and coalesce(has_table_privilege(current_user,c.oid,'SELECT'),false)) as select_access
  from pg_class c
  join user_schemas n on n.oid=c.relnamespace
  where c.relkind in ('r','p','v','m','f')
),
relevant_relations as (
  select r.*
  from relation_catalog r
  where r.table_name ~* '(event|ticket|booking|registration|attend|check.?in|qr|migration)'
     or exists (
       select 1 from unnest(r.columns) as cols(column_name)
       where cols.column_name ~* '(event_id|ticket|booking|registration|attend|check.?in|qr|phone|participant|attendee)'
     )
),
booking_candidates as (
  select r.* from relevant_relations r
  where r.table_name ~* '(booking|registration)'
    and r.relkind in ('r','p')
    and r.id_column is not null and r.event_column is not null and r.phone_column is not null
),
ticket_candidates as (
  select r.* from relevant_relations r
  where r.table_name ~* '(ticket|qr)'
     or r.columns && array['qr_token','qr_payload','ticket_number','ticket_code']::text[]
),
expected_tables(schema_name,table_name) as (
  values ('public','events'),('public','event_bookings'),('public','admins')
),
missing_tables_report as (
  select coalesce(jsonb_agg(format('%I.%I',e.schema_name,e.table_name) order by e.schema_name,e.table_name)
    filter (where c.oid is null),'[]'::jsonb) as value
  from expected_tables e
  left join pg_namespace n on n.nspname=e.schema_name
  left join pg_class c on c.relnamespace=n.oid and c.relname=e.table_name and c.relkind in ('r','p','v','m','f')
),
expected_columns(schema_name,table_name,column_name) as (
  values
    ('public','events','id'),('public','events','published'),('public','events','tickets_enabled'),
    ('public','events','qr_checkin_enabled'),('public','events','show_ticket_to_attendee'),
    ('public','event_bookings','id'),('public','event_bookings','event_id'),('public','event_bookings','phone'),
    ('public','event_bookings','status'),('public','event_bookings','ticket_id'),
    ('public','admins','user_id'),('public','admins','role')
),
missing_columns_report as (
  select coalesce(jsonb_agg(format('%I.%I.%I',e.schema_name,e.table_name,e.column_name)
    order by e.schema_name,e.table_name,e.column_name),'[]'::jsonb) as value
  from expected_columns e
  left join pg_namespace n on n.nspname=e.schema_name
  left join pg_class c on c.relnamespace=n.oid and c.relname=e.table_name and c.relkind in ('r','p','v','m','f')
  left join pg_attribute a on a.attrelid=c.oid and a.attname=e.column_name and a.attnum>0 and not a.attisdropped
  where c.oid is null or a.attname is null
),
expected_functions(function_name) as (
  values ('register_for_event'),('normalize_event_phone'),('get_my_event_ticket'),
    ('get_published_events_ticket_flags'),('admin_checkin_ticket'),
    ('admin_checkin_ticket_for_event'),('admin_manual_checkin')
),
missing_functions_report as (
  select coalesce(jsonb_agg(format('%I.%I','public',e.function_name) order by e.function_name),'[]'::jsonb) as value
  from expected_functions e
  left join pg_namespace n on n.nspname='public'
  where n.oid is null or not exists (select 1 from pg_proc p where p.pronamespace=n.oid and p.proname=e.function_name and p.prokind in ('f','p'))
),
function_report as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'name',p.proname,
    'signature',pg_get_function_identity_arguments(p.oid),
    'returns',pg_get_function_result(p.oid),
    'language',l.lanname,'owner',owner_role.rolname,
    'security_definer',p.prosecdef,
    'function_settings',p.proconfig,
    'execute_public',coalesce((select bool_or(x.grantee=0 and x.privilege_type='EXECUTE')
      from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),false),
    'execute_anon',case when exists(select 1 from pg_roles where rolname='anon') then has_function_privilege('anon',p.oid,'EXECUTE') else null end,
    'execute_authenticated',case when exists(select 1 from pg_roles where rolname='authenticated') then has_function_privilege('authenticated',p.oid,'EXECUTE') else null end,
    'execute_service_role',case when exists(select 1 from pg_roles where rolname='service_role') then has_function_privilege('service_role',p.oid,'EXECUTE') else null end,
    'definition_chars',length(pg_get_functiondef(p.oid)),
    'definition_md5',md5(pg_get_functiondef(p.oid)),
    'body_indicators',jsonb_build_object(
      'mentions_auth_uid',position('auth.uid' in lower(pg_get_functiondef(p.oid)))>0,
      'mentions_admin_check',position('admin' in lower(pg_get_functiondef(p.oid)))>0 or position('is_admin' in lower(pg_get_functiondef(p.oid)))>0,
      'mentions_phone_normalization',position('normalize_event_phone' in lower(pg_get_functiondef(p.oid)))>0,
      'mentions_booking_or_ticket_storage',position('booking' in lower(pg_get_functiondef(p.oid)))>0 or position('ticket' in lower(pg_get_functiondef(p.oid)))>0,
      'mentions_event_scope',position('event_id' in lower(pg_get_functiondef(p.oid)))>0 or position('p_event_id' in lower(pg_get_functiondef(p.oid)))>0,
      'mentions_qr_or_attendance',position('qr' in lower(pg_get_functiondef(p.oid)))>0 or position('checkin' in lower(pg_get_functiondef(p.oid)))>0 or position('attend' in lower(pg_get_functiondef(p.oid)))>0,
      'mentions_row_lock',position('for update' in lower(pg_get_functiondef(p.oid)))>0
    ),
    'catalog_tracked_relation_dependencies',coalesce((
      select jsonb_agg(jsonb_build_object('schema',dn.nspname,'relation',dc.relname) order by dn.nspname,dc.relname)
      from pg_depend d join pg_class dc on d.refclassid='pg_class'::regclass and dc.oid=d.refobjid
      join pg_namespace dn on dn.oid=dc.relnamespace
      where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype<>'i'
    ),'[]'::jsonb)
  ) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb) as value
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  join pg_language l on l.oid=p.prolang
  join pg_roles owner_role on owner_role.oid=p.proowner
  where p.prokind in ('f','p')
    and left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'
    and p.proname ~* '(register|normalize.*phone|phone.*normal|event_occupied_seats|ticket|check.?in|attendance|qr|admin.*|is_admin)'
),
relation_report as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema',r.schema_name,'name',r.table_name,'kind',r.relkind,
    'rls_enabled',r.relrowsecurity,'force_rls',r.relforcerowsecurity,
    'select_access',r.select_access,'columns',r.columns,
    'booking_id_like_column',r.id_column,'event_id_like_column',r.event_column,
    'phone_like_column',r.phone_column,'booking_reference_like_column',r.booking_ref_column,
    'ticket_reference_like_column',r.ticket_ref_column
  ) order by r.schema_name,r.table_name),'[]'::jsonb) as value
  from relevant_relations r
),
schema_report as (
  select coalesce(jsonb_agg(n.nspname order by n.nspname),'[]'::jsonb) as value from user_schemas n
),
information_schema_column_report as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema',c.table_schema,'table',c.table_name,'column',c.column_name,'type',c.data_type
  ) order by c.table_schema,c.table_name,c.ordinal_position),'[]'::jsonb) as value
  from information_schema.columns c
  where c.table_schema <> 'information_schema'
    and left(c.table_schema,3)<>'pg_'
    and (c.table_name ~* '(event|ticket|booking|registration|attend|check.?in|qr|migration)'
      or c.column_name ~* '(event_id|ticket|booking|registration|attend|check.?in|qr|phone|participant|attendee)')
),
extension_report as (
  select coalesce(jsonb_agg(jsonb_build_object('name',e.extname,'schema',n.nspname,'version',e.extversion)
    order by e.extname),'[]'::jsonb) as value
  from pg_extension e join pg_namespace n on n.oid=e.extnamespace
),
policy_report as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema',p.schemaname,'table',p.tablename,'name',p.policyname,'roles',p.roles,
    'command',p.cmd,'using',p.qual,'check',p.with_check
  ) order by p.schemaname,p.tablename,p.policyname),'[]'::jsonb) as value
  from pg_policies p
  join relevant_relations r on r.schema_name=p.schemaname and r.table_name=p.tablename
),
constraint_report as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'table',c.relname,'name',k.conname,'type',k.contype,
    'definition',pg_get_constraintdef(k.oid)
  ) order by n.nspname,c.relname,k.conname),'[]'::jsonb) as value
  from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
  join relevant_relations r on r.oid=c.oid
),
index_report as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'table',t.relname,'index',i.relname,
    'unique',x.indisunique,'valid',x.indisvalid,'definition',pg_get_indexdef(x.indexrelid)
  ) order by n.nspname,t.relname,i.relname),'[]'::jsonb) as value
  from pg_index x join pg_class t on t.oid=x.indrelid join pg_namespace n on n.oid=t.relnamespace
  join pg_class i on i.oid=x.indexrelid join relevant_relations r on r.oid=t.oid
),
trigger_report as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'table',t.relname,'trigger',g.tgname,
    'function_schema',fn.nspname,'function',fp.proname,
    'definition',pg_get_triggerdef(g.oid,true)
  ) order by n.nspname,t.relname,g.tgname),'[]'::jsonb) as value
  from pg_trigger g join pg_class t on t.oid=g.tgrelid join pg_namespace n on n.oid=t.relnamespace
  join relevant_relations r on r.oid=t.oid join pg_proc fp on fp.oid=g.tgfoid
  join pg_namespace fn on fn.oid=fp.pronamespace where not g.tgisinternal
),
migration_candidates as (
  select r.oid,r.schema_name,r.table_name,r.relkind,r.select_access,
    (select a.attname::text from pg_attribute a where a.attrelid=r.oid and a.attnum>0 and not a.attisdropped
      and a.attname='version' limit 1) as version_column
  from relation_catalog r
  where r.table_name ~* '(migration|schema_migrations)'
     or r.schema_name ~* 'migration'
),
migration_stats as (
  select count(*) filter(where version_column is not null) as candidate_count,
    count(*) as relation_count,
    coalesce(jsonb_agg(jsonb_build_object('schema',schema_name,'table',table_name,
      'version_column',version_column,'relation_kind',relkind,'select_access',select_access)
      order by schema_name,table_name),'[]'::jsonb) as candidates
  from migration_candidates
),
migration_report as (
  select case
    when s.relation_count=0 then jsonb_build_object('status','unavailable','reason','no_migration_history_relation_discovered')
    when s.candidate_count=0 then jsonb_build_object('status','unavailable','reason','migration_relation_version_column_missing','candidates',s.candidates)
    when s.candidate_count>1 then jsonb_build_object('status','ambiguous','candidates',s.candidates)
    when m.relkind not in ('r','p') then jsonb_build_object('status','unavailable','reason','migration_history_relation_not_a_base_table','candidates',s.candidates)
    when not m.select_access then jsonb_build_object('status','unavailable','reason','migration_history_not_selectable','candidates',s.candidates)
    else (
      select convert_from(decode(
        ((xpath('/table/row/result_b64/text()',query_to_xml(format(
          'select encode(convert_to(jsonb_build_object(''status'',''available'',''source'',%L,''latest_versions'',coalesce((select jsonb_agg(version_text order by version_text desc) from (select %I::text as version_text from %I.%I order by %I::text desc limit 50) v),''[]''::jsonb))::text,''UTF8''),''base64'') as result_b64',
          m.schema_name||'.'||m.table_name,m.version_column,m.schema_name,m.table_name,m.version_column
        ),false,false,'')))[1])::text,'base64'),'UTF8')::jsonb
      from migration_candidates m where m.version_column is not null limit 1
    )
  end as value
  from migration_stats s left join migration_candidates m on m.version_column is not null and s.candidate_count=1
  limit 1
),
integrity_report as (
  select case
    when (select count(*) from booking_candidates)=0 then jsonb_build_object('status','unavailable','reason','no_unambiguous_booking_table_candidate')
    when (select count(*) from booking_candidates)>1 then jsonb_build_object('status','ambiguous','booking_candidates',(select count(*) from booking_candidates))
    when (select count(*) from ticket_candidates)=0 then jsonb_build_object('status','unavailable','reason','no_ticket_storage_candidate_discovered')
    when (select count(*) from ticket_candidates)>1 then jsonb_build_object('status','ambiguous','ticket_storage_candidates',(select count(*) from ticket_candidates))
    when (select relkind from ticket_candidates limit 1) not in ('r','p') then jsonb_build_object('status','unavailable','reason','ticket_storage_candidate_not_a_base_table')
    when not (select select_access from booking_candidates limit 1) then jsonb_build_object('status','unavailable','reason','booking_table_not_selectable')
    when not (select select_access from ticket_candidates limit 1) then jsonb_build_object('status','unavailable','reason','ticket_storage_not_selectable')
    else (
      select convert_from(decode(
        ((xpath('/table/row/result_b64/text()',query_to_xml(
          format(
            'select encode(convert_to(jsonb_build_object(''status'',''available'',''booking_table'',%L,''ticket_table'',%L,''booking_rows'',(select count(*) from %I.%I),''ticket_rows'',(select count(*) from %I.%I),''orphan_ticket_booking_refs'',%s,''duplicate_ticket_booking_ref_groups'',%s,''cross_event_ticket_booking_refs'',%s,''booking_ticket_pointer_mismatches'',%s,''possible_iraqi_phone_collision_groups_all_statuses_common_formats_only'',%s)::text,''UTF8''),''base64'') as result_b64',
            b.schema_name||'.'||b.table_name,t.schema_name||'.'||t.table_name,
            b.schema_name,b.table_name,t.schema_name,t.table_name,
            case when t.booking_ref_column is not null and b.id_column is not null then
              format('(select count(*) from %I.%I t0 where t0.%I is not null and not exists (select 1 from %I.%I b0 where b0.%I::text=t0.%I::text))',
                t.schema_name,t.table_name,t.booking_ref_column,b.schema_name,b.table_name,b.id_column,t.booking_ref_column)
              else 'null::bigint' end,
            case when t.booking_ref_column is not null then
              format('(select count(*) from (select t0.%I from %I.%I t0 group by t0.%I having count(*)>1) d)',
                t.booking_ref_column,t.schema_name,t.table_name,t.booking_ref_column)
              else 'null::bigint' end,
            case when t.booking_ref_column is not null and t.event_column is not null and b.id_column is not null and b.event_column is not null then
              format('(select count(*) from %I.%I t0 join %I.%I b0 on b0.%I::text=t0.%I::text where t0.%I::text is distinct from b0.%I::text)',
                t.schema_name,t.table_name,b.schema_name,b.table_name,b.id_column,t.booking_ref_column,t.event_column,b.event_column)
              else 'null::bigint' end,
            case when b.ticket_ref_column is not null and t.id_column is not null then
              format('(select count(*) from %I.%I b0 where b0.%I is not null and not exists (select 1 from %I.%I t0 where t0.%I::text=b0.%I::text))',
                b.schema_name,b.table_name,b.ticket_ref_column,t.schema_name,t.table_name,t.id_column,b.ticket_ref_column)
              else 'null::bigint' end,
            case when b.phone_column is not null and b.event_column is not null then
              format($phone$
                (select count(*) from (
                  select event_key,phone_key from (
                    select b0.%I as event_key,
                      case
                        when regexp_replace(coalesce(b0.%I::text,''), '[^0-9]', '', 'g') ~ '^07[0-9]{9}$'
                          then substring(regexp_replace(coalesce(b0.%I::text,''), '[^0-9]', '', 'g') from 2)
                        when regexp_replace(coalesce(b0.%I::text,''), '[^0-9]', '', 'g') ~ '^9647[0-9]{9}$'
                          then substring(regexp_replace(coalesce(b0.%I::text,''), '[^0-9]', '', 'g') from 4)
                        when regexp_replace(coalesce(b0.%I::text,''), '[^0-9]', '', 'g') ~ '^009647[0-9]{9}$'
                          then substring(regexp_replace(coalesce(b0.%I::text,''), '[^0-9]', '', 'g') from 6)
                        when regexp_replace(coalesce(b0.%I::text,''), '[^0-9]', '', 'g') ~ '^7[0-9]{9}$'
                          then regexp_replace(coalesce(b0.%I::text,''), '[^0-9]', '', 'g')
                      end as phone_key
                    from %I.%I b0
                  ) normalized_candidates
                  where phone_key is not null
                  group by event_key,phone_key having count(*)>1
                ) collision_groups)
              $phone$,
              b.event_column,b.phone_column,b.phone_column,b.phone_column,b.phone_column,
              b.phone_column,b.phone_column,b.phone_column,b.phone_column,
              b.schema_name,b.table_name)
              else 'null::bigint' end
          ),false,false,'')))[1])::text,'base64'),'UTF8')::jsonb
      from booking_candidates b cross join ticket_candidates t
      limit 1
    )
  end as value
),
missing_functions_names as (
  select value from missing_functions_report
)
select jsonb_pretty(jsonb_build_object(
  'database_context',jsonb_build_object(
    'database',current_database(),'current_user',current_user,
    'postgres_version',current_setting('server_version'),
    'expected_project_ref','hdzeuvvnhqjbbzpishov','project_ref_confirmed_by_sql',false,
    'inspected_at',now()
  ),
  'schemas',(select value from schema_report),
  'information_schema_visible_related_columns',(select value from information_schema_column_report),
  'extensions',(select value from extension_report),
  'missing_expected_core_tables',(select value from missing_tables_report),
  'missing_expected_columns',(select value from missing_columns_report),
  'missing_expected_rpc_names',(select value from missing_functions_names),
  'discovered_relevant_relations',(select value from relation_report),
  'ticket_storage_candidates',(select coalesce(jsonb_agg(jsonb_build_object(
    'schema',schema_name,'table',table_name,'columns',columns,'select_access',select_access,
    'booking_reference_column',booking_ref_column,'event_column',event_column,'ticket_reference_column',ticket_ref_column
  ) order by schema_name,table_name),'[]'::jsonb) from ticket_candidates),
  'ticketing_functions',(select value from function_report),
  'policies',(select value from policy_report),
  'constraints',(select value from constraint_report),
  'indexes',(select value from index_report),
  'triggers',(select value from trigger_report),
  'migration_history',(select value from migration_report),
  'aggregate_booking_ticket_integrity',(select value from integrity_report),
  'unresolved_compatibility_issues',jsonb_build_array(
    'This inventory does not prove that migration 004 is compatible or safe to apply.',
    'Function body indicators and hashes are summaries; review full live definitions before deployment.',
    'The phone collision metric uses common Iraqi formats only and is not proof of equivalence with the discovered server normalizer.'
  )
)) as ticketing_readonly_diagnostic;
