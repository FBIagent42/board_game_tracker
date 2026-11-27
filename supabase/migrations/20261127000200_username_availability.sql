-- Return only whether a requested username is available, without exposing profiles.
create or replace function public.is_username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when btrim(coalesce(p_username, '')) !~ '^[A-Za-z0-9_.-]{3,32}$' then false
    else not exists (
      select 1
      from public."user" as u
      where lower(u.username) = lower(btrim(p_username))
    )
  end
$$;

revoke all on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;

notify pgrst, 'reload schema';
