-- BuildFromVision -- schema, row level security, and storage setup.
-- Apply with:  supabase db push      (or paste into the SQL editor)

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- projects --

do $$ begin
  create type project_status as enum ('queued', 'analyzing', 'ready', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.projects (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  title             text not null default 'Untitled robot',
  notes             text,
  image_path        text not null,
  status            project_status not null default 'queued',
  error             text,

  -- filled in by the analyze-device edge function
  device_name        text,
  device_summary     text,
  device_category    text,
  difficulty        text check (difficulty in ('beginner', 'intermediate', 'advanced')),
  est_build_minutes integer,
  skills            text[] default '{}',
  tools             text[] default '{}',
  total_cost_cents  integer,
  component_count   integer not null default 0,
  currency          text not null default 'USD',
  confidence        numeric(3, 2),
  analysis          jsonb,
  model             text,
  -- Axis the assembly stacks along, used by the exploded 3D view.
  assembly_axis     text not null default 'y' check (assembly_axis in ('x', 'y', 'z')),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists projects_user_created_idx
  on public.projects (user_id, created_at desc);

-- -------------------------------------------------------------- components --

create table if not exists public.components (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  name             text not null,
  category         text,
  description      text,
  quantity         integer not null default 1 check (quantity > 0),
  unit_price_cents integer,
  currency         text not null default 'USD',
  specs            jsonb default '{}'::jsonb,
  search_query     text,
  substitutes      text[] default '{}',
  -- Rough primitive for the exploded view: { shape, size_mm, rotation_deg, position_mm,
  -- layer, finish }. Null is fine -- the client falls back to a per-category default.
  geometry         jsonb,
  is_optional      boolean not null default false,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists components_project_idx on public.components (project_id, sort_order);

-- Purchase links the analyzer is confident about. Search links are generated client side.
create table if not exists public.component_links (
  id             uuid primary key default gen_random_uuid(),
  component_id   uuid not null references public.components (id) on delete cascade,
  project_id     uuid not null references public.projects (id) on delete cascade,
  retailer       text not null,
  retailer_label text,
  url            text not null,
  price_cents    integer,
  in_stock       boolean,
  created_at     timestamptz not null default now()
);

create index if not exists component_links_component_idx on public.component_links (component_id);

-- ---------------------------------------------------------- assembly steps --

create table if not exists public.assembly_steps (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  step_number      integer not null,
  title            text not null,
  instructions     text not null,
  component_names  text[] default '{}',
  tools            text[] default '{}',
  tips             text,
  warning          text,
  duration_minutes integer,
  video_prompt     text,
  created_at       timestamptz not null default now(),
  unique (project_id, step_number)
);

create index if not exists assembly_steps_project_idx
  on public.assembly_steps (project_id, step_number);

-- ------------------------------------------------------------------ videos --

do $$ begin
  create type video_kind as enum ('step', 'walkthrough');
exception when duplicate_object then null; end $$;

do $$ begin
  create type video_status as enum ('queued', 'generating', 'ready', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.videos (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  step_id          uuid references public.assembly_steps (id) on delete cascade,
  kind             video_kind not null default 'step',
  status           video_status not null default 'queued',
  provider         text,
  provider_job_id  text,
  prompt           text,
  video_url        text,
  thumbnail_url    text,
  duration_seconds numeric(6, 2),
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One clip per step, one walkthrough per project.
create unique index if not exists videos_step_unique
  on public.videos (step_id) where step_id is not null;
create unique index if not exists videos_walkthrough_unique
  on public.videos (project_id) where kind = 'walkthrough';

-- -------------------------------------------------------------- updated_at --

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

drop trigger if exists videos_touch on public.videos;
create trigger videos_touch before update on public.videos
  for each row execute function public.touch_updated_at();

-- Keep projects.component_count in sync so the dashboard needs no joins.
create or replace function public.sync_component_count()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  pid uuid := coalesce(new.project_id, old.project_id);
begin
  update public.projects p
     set component_count = (
           select coalesce(sum(quantity), 0) from public.components where project_id = pid
         )
   where p.id = pid;
  return null;
end;
$fn$;

drop trigger if exists components_count_sync on public.components;
create trigger components_count_sync after insert or update or delete on public.components
  for each row execute function public.sync_component_count();

-- --------------------------------------------------------------------- RLS --

alter table public.projects        enable row level security;
alter table public.components      enable row level security;
alter table public.component_links enable row level security;
alter table public.assembly_steps  enable row level security;
alter table public.videos          enable row level security;

-- Child rows inherit the parent project's ownership.
create or replace function public.owns_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.projects where id = pid and user_id = auth.uid());
$fn$;

drop policy if exists "projects_owner_select" on public.projects;
drop policy if exists "projects_owner_insert" on public.projects;
drop policy if exists "projects_owner_update" on public.projects;
drop policy if exists "projects_owner_delete" on public.projects;

create policy "projects_owner_select" on public.projects
  for select using (auth.uid() = user_id);
create policy "projects_owner_insert" on public.projects
  for insert with check (auth.uid() = user_id);
create policy "projects_owner_update" on public.projects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "projects_owner_delete" on public.projects
  for delete using (auth.uid() = user_id);

drop policy if exists "components_owner_all" on public.components;
create policy "components_owner_all" on public.components
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));

drop policy if exists "component_links_owner_all" on public.component_links;
create policy "component_links_owner_all" on public.component_links
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));

drop policy if exists "assembly_steps_owner_all" on public.assembly_steps;
create policy "assembly_steps_owner_all" on public.assembly_steps
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));

drop policy if exists "videos_owner_all" on public.videos;
create policy "videos_owner_all" on public.videos
  for all using (public.owns_project(project_id))
  with check (public.owns_project(project_id));

-- ----------------------------------------------------------------- storage --

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'device-images', 'device-images', false, 15728640,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do nothing;

-- Objects live at <user_id>/<uuid>.<ext>, so the first path segment is the owner.
drop policy if exists "robot_images_owner_select" on storage.objects;
create policy "robot_images_owner_select" on storage.objects
  for select using (
    bucket_id = 'device-images' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "robot_images_owner_insert" on storage.objects;
create policy "robot_images_owner_insert" on storage.objects
  for insert with check (
    bucket_id = 'device-images' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "robot_images_owner_delete" on storage.objects;
create policy "robot_images_owner_delete" on storage.objects
  for delete using (
    bucket_id = 'device-images' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------- realtime --

do $$ begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.components;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.assembly_steps;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.videos;
exception when duplicate_object then null; end $$;
