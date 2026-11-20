-- THE ZONE CMS: site content editor storage (admin-managed, public reads published)
create table if not exists public.site_content (
  key text primary key,
  page text not null default 'global',
  section text not null default 'general',
  label text not null default '',
  default_en text,
  default_ar text,
  draft_en text,
  draft_ar text,
  published_en text,
  published_ar text,
  last_published_en text,
  last_published_ar text,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.site_content enable row level security;

-- Admins: full access
drop policy if exists "site_content_admin_all" on public.site_content;
create policy "site_content_admin_all"
  on public.site_content
  for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin'));

-- Public/anon: read-only access to published-facing columns via view (base table restricted)
-- (No anon select policy on base table; use view below.)

create or replace view public.site_content_public as
select
  key,
  page,
  section,
  sort_order,
  coalesce(published_en, default_en) as value_en,
  coalesce(published_ar, default_ar) as value_ar
from public.site_content;

grant select on public.site_content_public to anon, authenticated;
-- Ensure admins can also use view
grant select on public.site_content_public to authenticated;

-- Revoke direct anon access to base table explicitly (RLS already blocks, but be clear)
revoke all on public.site_content from anon;
grant select, insert, update, delete on public.site_content to authenticated;
