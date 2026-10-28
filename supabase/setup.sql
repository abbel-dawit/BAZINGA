-- BAZINGA! accounts & sync — run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again.

-- 1) Profiles (username, picture, sync revision). One row per user, only readable/writable by that user.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text check (char_length(username) <= 40),
  avatar text check (char_length(avatar) <= 80000),
  terms_version text,
  library_rev bigint not null default 0,
  library_device text,
  library_file text,
  library_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: read own"   on public.profiles for select to authenticated using (auth.uid() = id);
create policy "profiles: insert own" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles: update own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Users may change their username/picture, but the sync revision only moves through bump_library_rev()
revoke update on public.profiles from authenticated, anon;
grant update (id, username, avatar, terms_version, updated_at) on public.profiles to authenticated;

-- 2) Create a profile automatically when someone signs up (email, Google or Discord)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, avatar)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'username', new.raw_user_meta_data ->> 'full_name',
                  new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)), 30),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3) Claim the next library revision — succeeds only if no other device saved in between
alter table public.profiles add column if not exists library_file text;
drop function if exists public.bump_library_rev(bigint, text);
create or replace function public.bump_library_rev(expected bigint, device text, file text)
returns bigint language plpgsql security definer set search_path = public as $$
declare r bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if file is null or split_part(file, '/', 1) <> auth.uid()::text then raise exception 'bad file'; end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  update public.profiles
     set library_rev = library_rev + 1, library_device = left(device, 60), library_file = file, library_updated_at = now()
   where id = auth.uid() and library_rev = expected
  returning library_rev into r;
  return r; -- null means "someone else saved first"
end; $$;
revoke all on function public.bump_library_rev(bigint, text, text) from public, anon;
grant execute on function public.bump_library_rev(bigint, text, text) to authenticated;

-- 4) Let users delete their own account (the app deletes their synced files first)
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end; $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- 5) Private storage for each user's synced library file: libraries/<user id>/lib-<rev>.bz
insert into storage.buckets (id, name, public, file_size_limit)
values ('libraries', 'libraries', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists "libraries: read own"   on storage.objects;
drop policy if exists "libraries: insert own" on storage.objects;
drop policy if exists "libraries: update own" on storage.objects;
drop policy if exists "libraries: delete own" on storage.objects;
create policy "libraries: read own"   on storage.objects for select to authenticated
  using (bucket_id = 'libraries' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "libraries: insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'libraries' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "libraries: update own" on storage.objects for update to authenticated
  using (bucket_id = 'libraries' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "libraries: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'libraries' and (storage.foldername(name))[1] = auth.uid()::text);
