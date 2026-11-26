"""Merge duplicate rows for the same BGG ID without collapsing distinct games."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SOURCE_CSV = DATA / "games_merged.csv"
OUTPUT_CSV = DATA / "games_merged_deduplicated.csv"
ID_MAP_CSV = DATA / "game_duplicate_id_map.csv"


def missing_count(row: dict[str, str], fields: list[str]) -> int:
    return sum(not (row.get(field) or "").strip() for field in fields if field != "game_id")


def check_database_references() -> None:
    with (ROOT / "config.public.json").open("r", encoding="utf-8-sig") as file:
        public = json.load(file)
    with (ROOT / "config.secret.json").open("r", encoding="utf-8-sig") as file:
        secret = json.load(file)
    supabase_url = str(public.get("SUPABASE_URL", "")).strip().rstrip("/")
    service_key = str(secret.get("SUPABASE_SERVICE_KEY", "")).strip()
    access_token = str(secret.get("SUPABASE_ACCESS_TOKEN", "")).strip()
    project_ref = str(secret.get("SUPABASE_PROJECT_REF", "")).strip()

    removed_to_keeper: dict[int, int] = {}
    with ID_MAP_CSV.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            removed_to_keeper[int(row["removed_game_id"])] = int(row["retained_game_id"])

    fk_sql = """select c.conrelid::regclass::text as table_name,
       a.attname as column_name,
       c.confdeltype as delete_rule
from pg_constraint c
join lateral unnest(c.conkey) with ordinality as key_col(attnum, ord) on true
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = key_col.attnum
where c.contype = 'f' and c.confrelid = 'public.game'::regclass
order by c.conrelid::regclass::text, a.attname;"""
    fk_url = f"https://api.supabase.com/v1/projects/{urllib.parse.quote(project_ref, safe='')}/database/query/read-only"
    fk_request = urllib.request.Request(
        fk_url,
        data=json.dumps({"query": fk_sql}).encode("utf-8"),
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(fk_request, timeout=90) as response:
            fk_rows = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"Could not inspect game foreign keys (HTTP {error.code}): {detail}") from error

    endpoint = f"{supabase_url}/rest/v1/user_collection?select=user_id,game_id,numplays,own,date_added&order=game_id.asc"
    collection_rows: list[dict[str, object]] = []
    start = 0
    page_size = 1000
    total: int | None = None
    while total is None or start < total:
        request = urllib.request.Request(
            endpoint,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Prefer": "count=exact",
                "Range": f"{start}-{start + page_size - 1}",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = json.loads(response.read().decode("utf-8"))
                content_range = response.headers.get("Content-Range", "")
                if total is None and "/" in content_range:
                    raw_total = content_range.rsplit("/", 1)[1]
                    total = int(raw_total) if raw_total.isdigit() else len(payload)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1000]
            raise RuntimeError(f"Could not inspect user_collection (HTTP {error.code}): {detail}") from error
        collection_rows.extend(payload)
        if len(payload) < page_size:
            break
        start += page_size

    removed_ids = set(removed_to_keeper)
    refs_by_removed: dict[int, set[int]] = defaultdict(set)
    for row in collection_rows:
        game_id = int(row["game_id"])
        if game_id in removed_ids:
            refs_by_removed[game_id].add(int(row["user_id"]))
    keeper_with_collection = {
        int(row["game_id"]): int(row["user_id"])
        for row in collection_rows
        if int(row["game_id"]) not in removed_ids
    }
    affected = set(refs_by_removed)
    collision_users = 0
    for removed_id, user_ids in refs_by_removed.items():
        keeper_id = removed_to_keeper[removed_id]
        for user_id in user_ids:
            if keeper_with_collection.get(keeper_id) == user_id:
                collision_users += 1

    print("Foreign keys referencing public.game:")
    for row in fk_rows:
        print(f"{row['table_name']}.{row['column_name']} (ON DELETE {row['delete_rule']})")
    print(f"user_collection rows: {len(collection_rows)}")
    print(f"Rows referencing removed IDs: {sum(map(len, refs_by_removed.values()))}")
    print(f"Distinct removed IDs referenced by collections: {len(affected)}")
    print(f"Collection user/game collisions during ID remap: {collision_users}")


def apply_database_deduplication() -> int:
    with (ROOT / "config.secret.json").open("r", encoding="utf-8-sig") as file:
        secret = json.load(file)
    access_token = str(secret.get("SUPABASE_ACCESS_TOKEN", "")).strip()
    project_ref = str(secret.get("SUPABASE_PROJECT_REF", "")).strip()
    if not access_token or not project_ref:
        raise RuntimeError("SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF is missing.")

    mapping: list[tuple[int, int]] = []
    with ID_MAP_CSV.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            mapping.append((int(row["removed_game_id"]), int(row["retained_game_id"])))
    if not mapping:
        print("No duplicate IDs to remove from Supabase.")
        return 0

    url = f"https://api.supabase.com/v1/projects/{urllib.parse.quote(project_ref, safe='')}/database/query"
    batch_size = 250
    deleted = 0
    for start in range(0, len(mapping), batch_size):
        batch = mapping[start : start + batch_size]
        values = ",".join(f"({old_id},{keep_id})" for old_id, keep_id in batch)
        old_ids = ",".join(str(old_id) for old_id, _ in batch)
        keep_ids = ",".join(str(keep_id) for _, keep_id in batch)
        sql = f"""with remap(removed_id, retained_id) as (values {values}),
copied_mechanics as (
  insert into public.game_mechanic (game_id, mechanic_name)
  select r.retained_id, gm.mechanic_name
  from public.game_mechanic gm join remap r on gm.game_id = r.removed_id
  on conflict (game_id, mechanic_name) do nothing returning 1
), copied_subcategories as (
  insert into public.game_subcategory (game_id, subcategory_name)
  select r.retained_id, gs.subcategory_name
  from public.game_subcategory gs join remap r on gs.game_id = r.removed_id
  on conflict (game_id, subcategory_name) do nothing returning 1
), copied_themes as (
  insert into public.game_theme (game_id, theme_name)
  select r.retained_id, gt.theme_name
  from public.game_theme gt join remap r on gt.game_id = r.removed_id
  on conflict (game_id, theme_name) do nothing returning 1
), collection_rollup as (
  select uc.user_id, coalesce(r.retained_id, uc.game_id) as game_id,
         sum(uc.numplays)::integer as numplays, bool_or(uc.own) as own,
         min(uc.date_added) as date_added
  from public.user_collection uc
  left join remap r on uc.game_id = r.removed_id
  where uc.game_id = any(array[{old_ids}]::bigint[])
     or uc.game_id = any(array[{keep_ids}]::bigint[])
  group by uc.user_id, coalesce(r.retained_id, uc.game_id)
), merged_collections as (
  insert into public.user_collection (user_id, game_id, numplays, own, date_added)
  select user_id, game_id, numplays, own, date_added from collection_rollup
  on conflict (user_id, game_id) do update set
    numplays = excluded.numplays,
    own = excluded.own,
    date_added = excluded.date_added
  returning 1
), deleted_games as (
  delete from public.game where game_id = any(array[{old_ids}]::bigint[]) returning game_id
)
select count(*) as deleted_games from deleted_games;"""
        request = urllib.request.Request(
            url,
            data=json.dumps({"query": sql}).encode("utf-8"),
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1500]
            raise RuntimeError(
                f"Supabase duplicate cleanup batch {start // batch_size + 1} failed "
                f"(HTTP {error.code}): {detail}"
            ) from error
        if isinstance(body, list) and body and "deleted_games" in body[0]:
            deleted += int(body[0]["deleted_games"])
        else:
            deleted += len(batch)
        print(f"Processed duplicate ID mappings: {min(start + len(batch), len(mapping))}/{len(mapping)}", flush=True)
    return deleted


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=SOURCE_CSV)
    parser.add_argument("--output", type=Path, default=OUTPUT_CSV)
    parser.add_argument("--id-map", type=Path, default=ID_MAP_CSV)
    parser.add_argument("--check-db-references", action="store_true")
    parser.add_argument("--apply-db-deduplication", action="store_true")
    args = parser.parse_args()

    if args.check_db_references:
        check_database_references()
        return
    if args.apply_db_deduplication:
        deleted = apply_database_deduplication()
        print(f"Supabase duplicate cleanup complete; deleted {deleted} game row(s).")
        return

    with args.input.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        fields = reader.fieldnames or []
        groups: dict[str, list[dict[str, str]]] = defaultdict(list)
        for row in reader:
            game_id = (row.get("game_id") or "").strip()
            if not game_id:
                raise ValueError("Every source row must have a game_id.")
            key = game_id
            groups[key].append(row)

    keeper_rows: list[dict[str, str]] = []
    id_map: list[dict[str, str]] = []
    conflict_count = 0
    for key, group in groups.items():
        ordered = sorted(
            group,
            key=lambda row: (
                missing_count(row, fields),
                int(row["game_id"]),
            ),
        )
        keeper = dict(ordered[0])
        for row in ordered[1:]:
            for field in fields:
                current = (keeper.get(field) or "").strip()
                candidate = (row.get(field) or "").strip()
                if not current and candidate:
                    keeper[field] = candidate
                elif current and candidate and current != candidate:
                    conflict_count += 1
        keeper_rows.append(keeper)
        # All rows in this group share the same primary key, so no database ID
        # needs to be deleted or remapped when their blank fields are merged.

    keeper_rows.sort(key=lambda row: int(row["game_id"]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.id_map.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(keeper_rows)
    with args.id_map.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "retained_game_id",
                "removed_game_id",
                "title",
                "retained_missing_before_merge",
                "removed_missing",
            ],
        )
        writer.writeheader()
        writer.writerows(id_map)

    print(f"Source rows: {sum(len(group) for group in groups.values())}")
    print(f"Retained rows: {len(keeper_rows)}")
    print(f"Removed duplicate rows: {len(id_map)}")
    print(f"Groups merged: {sum(1 for group in groups.values() if len(group) > 1)}")
    print(f"Conflicting populated field values retained from best row: {conflict_count}")
    print(f"Deduplicated CSV: {args.output}")
    print(f"Removed-ID mapping: {args.id_map}")


if __name__ == "__main__":
    main()
