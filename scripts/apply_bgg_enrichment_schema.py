"""Apply the BGG on-demand enrichment schema to the configured Supabase project."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

STATEMENTS = [
    "alter table public.game add column if not exists bgg_last_checked_at timestamptz;",
    """create table if not exists public.bgg_request_gate (
      id smallint primary key check (id = 1),
      next_allowed_at timestamptz not null default '-infinity'
    );""",
    "insert into public.bgg_request_gate (id, next_allowed_at) values (1, '-infinity') on conflict (id) do nothing;",
    "alter table public.bgg_request_gate enable row level security;",
    "revoke all on table public.bgg_request_gate from anon, authenticated;",
    "grant all on table public.bgg_request_gate to service_role;",
    """create or replace function public.claim_bgg_request_slot()
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare request_at timestamptz;
begin
  update public.bgg_request_gate
  set next_allowed_at = greatest(next_allowed_at, clock_timestamp()) + interval '5 seconds'
  where id = 1
  returning next_allowed_at - interval '5 seconds' into request_at;
  return request_at;
end;
$$;""",
    "revoke all on function public.claim_bgg_request_slot() from public, anon, authenticated;",
    "grant execute on function public.claim_bgg_request_slot() to service_role;",
    "notify pgrst, 'reload schema';",
]


def main() -> None:
    with (ROOT / "config.secret.json").open("r", encoding="utf-8-sig") as file:
        secret = json.load(file)
    access_token = str(secret.get("SUPABASE_ACCESS_TOKEN", "")).strip()
    project_ref = str(secret.get("SUPABASE_PROJECT_REF", "")).strip()
    if not access_token or not project_ref:
        raise RuntimeError("Supabase access token or project ref is missing from config.secret.json.")

    url = f"https://api.supabase.com/v1/projects/{urllib.parse.quote(project_ref, safe='')}/database/query"
    for index, sql in enumerate(STATEMENTS, start=1):
        request = urllib.request.Request(
            url,
            data=json.dumps({"query": sql}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1200]
            raise RuntimeError(f"Schema statement {index} failed (HTTP {error.code}): {detail}") from error
        print(f"Applied schema statement {index}/{len(STATEMENTS)}.", flush=True)


if __name__ == "__main__":
    main()
