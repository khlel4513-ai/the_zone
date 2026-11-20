-- Supabase Storage for THE ZONE event posters
-- Apply in Supabase SQL Editor (Dashboard). Additive and non-destructive.
-- Prerequisite: public.events and public.is_admin() exist (see supabase-schema.sql).
-- Purpose: durable image storage for event create/edit (no Base64, no temp/local links).

-- 1) Bucket (public read for published site display; writes restricted to admins below)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-posters',
  'event-posters',
  true,
  5242880,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2) Policies (storage.objects). Admin-only insert/update/delete; public read.
-- Note: "Public read" allows direct object access by URL. This is required for
-- displaying event posters on the public site. Do not store sensitive files here.
drop policy if exists "event posters public read" on storage.objects;
create policy "event posters public read"
  on storage.objects for select
  using (bucket_id = 'event-posters');

drop policy if exists "event posters admin insert" on storage.objects;
create policy "event posters admin insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'event-posters' and public.is_admin());

drop policy if exists "event posters admin update" on storage.objects;
create policy "event posters admin update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'event-posters' and public.is_admin())
  with check (bucket_id = 'event-posters' and public.is_admin());

drop policy if exists "event posters admin delete" on storage.objects;
create policy "event posters admin delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'event-posters' and public.is_admin());

-- 3) Verify after applying:
-- select id,name,public,file_size_limit,allowed_mime_types from storage.buckets where id='event-posters';
-- select policyname,cmd,roles from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'event posters%';
