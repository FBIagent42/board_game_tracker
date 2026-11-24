create table if not exists public.game (
  game_id bigint primary key,
  name text not null,
  description text,
  year_published integer,
  game_weight numeric,
  avg_rating numeric,
  bayes_avg_rating numeric,
  min_players integer,
  max_players integer,
  community_age_rec numeric,
  best_players text,
  manufacturer_playtime integer,
  community_min_playtime integer,
  community_max_playtime integer,
  manufacturer_age_rec integer,
  image_url text,
  bgg_url text generated always as ('https://boardgamegeek.com/boardgame/' || game_id::text) stored
);
create table if not exists public.mechanic (
  name text primary key
);
create table if not exists public.game_mechanic (
  game_id bigint not null references public.game(game_id) on delete cascade,
  mechanic_name text not null references public.mechanic(name) on delete cascade,
  primary key (game_id, mechanic_name)
);
create table if not exists public.subcategory (
  name text primary key
);
create table if not exists public.game_subcategory (
  game_id bigint not null references public.game(game_id) on delete cascade,
  subcategory_name text not null references public.subcategory(name) on delete cascade,
  primary key (game_id, subcategory_name)
);
create table if not exists public.theme (
  name text primary key
);
create table if not exists public.game_theme (
  game_id bigint not null references public.game(game_id) on delete cascade,
  theme_name text not null references public.theme(name) on delete cascade,
  primary key (game_id, theme_name)
);
create table if not exists public."user" (
  user_id bigint not null primary key,
  username text not null,
  email text
);
create table if not exists public.user_collection (
  user_id bigint not null references public."user"(user_id) on delete cascade,
  game_id bigint not null references public.game(game_id) on delete cascade,
  numplays integer not null default 0 check (numplays >= 0),
  own boolean not null default true,
  date_added date not null default current_date,
  primary key (user_id, game_id)
);
create index if not exists game_name_idx on public.game using gin (to_tsvector('simple', name));
create index if not exists game_mechanic_name_idx on public.game_mechanic(mechanic_name);
create index if not exists game_subcategory_name_idx on public.game_subcategory(subcategory_name);
create index if not exists game_theme_name_idx on public.game_theme(theme_name);
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage on schema public to anon;
grant select on table public.game, public."user", public.user_collection to anon;
alter table public.game enable row level security;
alter table public."user" enable row level security;
alter table public.user_collection enable row level security;
drop policy if exists website_read_games on public.game;
create policy website_read_games on public.game for select to anon using (true);
drop policy if exists website_read_users on public."user";
create policy website_read_users on public."user" for select to anon using (true);
drop policy if exists website_read_collection on public.user_collection;
create policy website_read_collection on public.user_collection for select to anon using (user_id = 1);
