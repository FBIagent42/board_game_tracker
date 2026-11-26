alter table public.game add column if not exists bgg_last_checked_at timestamptz;

create table if not exists public.bgg_request_gate (
  id smallint primary key check (id = 1),
  next_allowed_at timestamptz not null default '-infinity'
);

insert into public.bgg_request_gate (id, next_allowed_at)
values (1, '-infinity')
on conflict (id) do nothing;

alter table public.bgg_request_gate enable row level security;
revoke all on table public.bgg_request_gate from anon, authenticated;
grant all on table public.bgg_request_gate to service_role;

create or replace function public.claim_bgg_request_slot()
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  request_at timestamptz;
begin
  update public.bgg_request_gate
  set next_allowed_at = greatest(next_allowed_at, clock_timestamp()) + interval '5 seconds'
  where id = 1
  returning next_allowed_at - interval '5 seconds' into request_at;
  return request_at;
end;
$$;

revoke all on function public.claim_bgg_request_slot() from public, anon, authenticated;
grant execute on function public.claim_bgg_request_slot() to service_role;
