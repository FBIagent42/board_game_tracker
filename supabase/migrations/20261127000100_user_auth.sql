-- Connect application profiles to Supabase Auth and scope collection access.

create sequence if not exists public.user_user_id_seq as bigint;
select setval(
  'public.user_user_id_seq',
  greatest(coalesce((select max(user_id) from public."user"), 1), 1),
  true
);
alter sequence public.user_user_id_seq owned by public."user".user_id;
alter table public."user"
  alter column user_id set default nextval('public.user_user_id_seq'::regclass);

alter table public."user"
  add column if not exists auth_user_id uuid references auth.users(id) on delete cascade;
alter table public."user"
  add column if not exists bgg_username text;
create unique index if not exists user_auth_user_id_uidx
  on public."user" (auth_user_id);
create unique index if not exists user_authenticated_username_lower_uidx
  on public."user" (lower(username))
  where auth_user_id is not null;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  profile_username text;
begin
  profile_username := nullif(btrim(new.raw_user_meta_data ->> 'username'), '');
  if profile_username is null then
    profile_username := 'player_' || left(new.id::text, 8);
  end if;
  if profile_username !~ '^[A-Za-z0-9_.-]{3,32}$' then
    raise exception 'Username must be 3-32 letters, numbers, dots, underscores, or hyphens.';
  end if;

  insert into public."user" (auth_user_id, username, email)
  values (new.id, profile_username, new.email)
  on conflict (auth_user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_create_profile on auth.users;
create trigger on_auth_user_created_create_profile
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Backfill profiles for any Auth accounts created before this migration runs.
insert into public."user" (auth_user_id, username, email)
select
  au.id,
  coalesce(
    case
      when btrim(coalesce(au.raw_user_meta_data ->> 'username', '')) ~ '^[A-Za-z0-9_.-]{3,32}$'
        then btrim(au.raw_user_meta_data ->> 'username')
    end,
    'player_' || left(au.id::text, 8)
  ),
  au.email
from auth.users as au
where not exists (
  select 1 from public."user" as u where u.auth_user_id = au.id
)
on conflict (auth_user_id) do nothing;

create or replace function public.current_app_user_id()
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select u.user_id
  from public."user" as u
  where u.auth_user_id = (select auth.uid())
  limit 1
$$;
revoke all on function public.current_app_user_id() from public, anon;
grant execute on function public.current_app_user_id() to authenticated;

create or replace function public.lookup_auth_email_by_username(p_username text)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select u.email
  from public."user" as u
  where u.auth_user_id is not null
    and lower(u.username) = lower(p_username)
  limit 1
$$;
revoke all on function public.lookup_auth_email_by_username(text) from public, anon, authenticated;
grant execute on function public.lookup_auth_email_by_username(text) to service_role;

create or replace function public.add_game_to_my_collection(p_game_id bigint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  app_user_id bigint;
begin
  app_user_id := public.current_app_user_id();
  if app_user_id is null then
    raise exception 'A signed-in application profile is required.';
  end if;

  insert into public.user_collection (user_id, game_id, numplays, own)
  values (app_user_id, p_game_id, 0, true)
  on conflict (user_id, game_id) do update
    set own = true;
end;
$$;
revoke all on function public.add_game_to_my_collection(bigint) from public, anon;
grant execute on function public.add_game_to_my_collection(bigint) to authenticated;

alter table public."user" enable row level security;
alter table public.user_collection enable row level security;
alter table public.game enable row level security;

drop policy if exists website_read_users on public."user";
drop policy if exists authenticated_read_own_user on public."user";
drop policy if exists authenticated_update_own_user on public."user";
create policy authenticated_read_own_user
  on public."user" for select to authenticated
  using (auth_user_id = (select auth.uid()));
create policy authenticated_update_own_user
  on public."user" for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

drop policy if exists website_read_collection on public.user_collection;
drop policy if exists authenticated_read_own_collection on public.user_collection;
drop policy if exists authenticated_insert_own_collection on public.user_collection;
drop policy if exists authenticated_update_own_collection on public.user_collection;
drop policy if exists authenticated_delete_own_collection on public.user_collection;
create policy authenticated_read_own_collection
  on public.user_collection for select to authenticated
  using (user_id = (select public.current_app_user_id()));
create policy authenticated_insert_own_collection
  on public.user_collection for insert to authenticated
  with check (user_id = (select public.current_app_user_id()));
create policy authenticated_update_own_collection
  on public.user_collection for update to authenticated
  using (user_id = (select public.current_app_user_id()))
  with check (user_id = (select public.current_app_user_id()));
create policy authenticated_delete_own_collection
  on public.user_collection for delete to authenticated
  using (user_id = (select public.current_app_user_id()));

drop policy if exists authenticated_read_games on public.game;
create policy authenticated_read_games
  on public.game for select to authenticated using (true);

grant usage on schema public to authenticated;
grant select on public.game to anon, authenticated;
revoke all on public."user" from anon;
grant select on public."user" to authenticated;
grant update (bgg_username) on public."user" to authenticated;
revoke all on public.user_collection from anon;
grant select, insert, update, delete on public.user_collection to authenticated;
grant all on public."user", public.user_collection, public.game to service_role;

notify pgrst, 'reload schema';
