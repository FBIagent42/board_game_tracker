"""Join the game and BGG ranks CSVs, then upsert schema-shaped game rows."""

from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
GAMES_CSV = DATA / "games.csv"
RANKS_CSV = DATA / "boardgames_ranks.csv"
OUTPUT_CSV = DATA / "games_merged.csv"
BATCH_SIZE = 500

FIELDS = [
    "game_id",
    "is_expansion",
    "name",
    "description",
    "year_published",
    "game_weight",
    "avg_rating",
    "bayes_avg_rating",
    "min_players",
    "max_players",
    "community_age_rec",
    "best_players",
    "manufacturer_playtime",
    "community_min_playtime",
    "community_max_playtime",
    "manufacturer_age_rec",
    "image_url",
]

GAME_SOURCE_FIELDS = {
    "name": "Name",
    "description": "Description",
    "year_published": "YearPublished",
    "game_weight": "GameWeight",
    "avg_rating": "AvgRating",
    "bayes_avg_rating": "BayesAvgRating",
    "min_players": "MinPlayers",
    "max_players": "MaxPlayers",
    "community_age_rec": "ComAgeRec",
    "best_players": "BestPlayers",
    "manufacturer_playtime": "MfgPlaytime",
    "community_min_playtime": "ComMinPlaytime",
    "community_max_playtime": "ComMaxPlaytime",
    "manufacturer_age_rec": "MfgAgeRec",
    "image_url": "ImagePath",
}

INT_FIELDS = {
    "game_id",
    "year_published",
    "min_players",
    "max_players",
    "manufacturer_playtime",
    "community_min_playtime",
    "community_max_playtime",
    "manufacturer_age_rec",
}
FLOAT_FIELDS = {"game_weight", "avg_rating", "bayes_avg_rating", "community_age_rec"}


def clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value if value else None


def parse_bool(value: str | None) -> bool | None:
    value = clean(value)
    if value is None:
        return None
    value = value.lower()
    if value in {"1", "1.0", "true", "t", "yes"}:
        return True
    if value in {"0", "0.0", "false", "f", "no"}:
        return False
    return None


def read_game_rows() -> dict[int, dict[str, str | None]]:
    by_id: dict[int, dict[str, str | None]] = {}
    with GAMES_CSV.open("r", encoding="utf-8-sig", newline="") as file:
        for source in csv.DictReader(file):
            raw_id = clean(source.get("BGGId"))
            if not raw_id:
                continue
            game_id = int(raw_id)
            if game_id in by_id:
                raise ValueError(f"Duplicate BGGId {game_id} in {GAMES_CSV.name}")
            record = {"game_id": str(game_id)}
            for destination, input_name in GAME_SOURCE_FIELDS.items():
                record[destination] = clean(source.get(input_name))
            record["is_expansion"] = clean(source.get("IsExpansion"))
            by_id[game_id] = record
    return by_id


def merge_csv(output_csv: Path) -> tuple[int, int, int]:
    game_by_id = read_game_rows()
    seen_ids: set[int] = set()
    rank_rows = 0
    game_only_rows = 0

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with output_csv.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()

        with RANKS_CSV.open("r", encoding="utf-8-sig", newline="") as ranks_file:
            for rank in csv.DictReader(ranks_file):
                raw_id = clean(rank.get("id"))
                if not raw_id:
                    continue
                game_id = int(raw_id)
                if game_id in seen_ids:
                    raise ValueError(f"Duplicate BGG id {game_id} in {RANKS_CSV.name}")
                seen_ids.add(game_id)
                rank_rows += 1

                record = game_by_id.get(game_id, {"game_id": str(game_id)})
                record["game_id"] = str(game_id)
                # Ranks CSV is the requested source of truth for expansion status.
                expansion = parse_bool(rank.get("is_expansion"))
                if expansion is None:
                    expansion = parse_bool(record.get("is_expansion"))
                record["is_expansion"] = (
                    "true" if expansion is True else "false" if expansion is False else None
                )

                # Fill any fields missing from games.csv with values available in ranks.
                record["name"] = record.get("name") or clean(rank.get("name"))
                record["year_published"] = record.get("year_published") or clean(
                    rank.get("yearpublished")
                )
                record["avg_rating"] = record.get("avg_rating") or clean(rank.get("average"))
                record["bayes_avg_rating"] = record.get("bayes_avg_rating") or clean(
                    rank.get("bayesaverage")
                )
                writer.writerow({field: record.get(field) or "" for field in FIELDS})

        for game_id, record in game_by_id.items():
            if game_id in seen_ids:
                continue
            game_only_rows += 1
            expansion = parse_bool(record.get("is_expansion"))
            record["is_expansion"] = (
                "true" if expansion is True else "false" if expansion is False else None
            )
            writer.writerow({field: record.get(field) or "" for field in FIELDS})

    return rank_rows, game_only_rows, rank_rows + game_only_rows


def read_config() -> tuple[dict[str, Any], dict[str, Any]]:
    with (ROOT / "config.public.json").open("r", encoding="utf-8-sig") as file:
        public = json.load(file)
    with (ROOT / "config.secret.json").open("r", encoding="utf-8-sig") as file:
        secret = json.load(file)
    return public, secret


def ensure_expansion_column(project_ref: str, access_token: str) -> None:
    url = f"https://api.supabase.com/v1/projects/{urllib.parse.quote(project_ref, safe='')}/database/query"
    for query in (
        "alter table public.game add column if not exists is_expansion boolean;",
        "notify pgrst, 'reload schema';",
    ):
        body = json.dumps({"query": query}).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
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
            raise RuntimeError(
                "Could not ensure public.game.is_expansion exists and reload Supabase's "
                f"REST schema cache through the Management API (HTTP {error.code}): {detail}"
            ) from error


def to_db_row(source: dict[str, str]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for field in FIELDS:
        value = clean(source.get(field))
        if value is None:
            result[field] = None
        elif field == "is_expansion":
            result[field] = parse_bool(value)
        elif field in INT_FIELDS:
            result[field] = int(float(value))
        elif field in FLOAT_FIELDS:
            result[field] = float(value)
        else:
            result[field] = value
    return result


def upload_csv(output_csv: Path) -> int:
    public, secret = read_config()
    supabase_url = str(public.get("SUPABASE_URL", "")).strip().rstrip("/")
    service_key = str(secret.get("SUPABASE_SERVICE_KEY", "")).strip()
    if not supabase_url or not service_key:
        raise RuntimeError("SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from local config.")

    access_token = str(secret.get("SUPABASE_ACCESS_TOKEN", "")).strip()
    project_ref = str(secret.get("SUPABASE_PROJECT_REF", "")).strip()
    if access_token and project_ref:
        ensure_expansion_column(project_ref, access_token)
    else:
        raise RuntimeError("SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF is missing from config.secret.json.")

    endpoint = f"{supabase_url}/rest/v1/game?on_conflict=game_id"
    uploaded = 0
    with output_csv.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        batch: list[dict[str, Any]] = []
        for row in reader:
            batch.append(to_db_row(row))
            if len(batch) >= BATCH_SIZE:
                send_batch(endpoint, service_key, batch)
                uploaded += len(batch)
                print(f"Games upserted: {uploaded}", flush=True)
                batch.clear()
        if batch:
            send_batch(endpoint, service_key, batch)
            uploaded += len(batch)
            print(f"Games upserted: {uploaded}", flush=True)
    return uploaded


def verify_remote_count() -> str:
    public, secret = read_config()
    supabase_url = str(public.get("SUPABASE_URL", "")).strip().rstrip("/")
    service_key = str(secret.get("SUPABASE_SERVICE_KEY", "")).strip()
    request = urllib.request.Request(
        f"{supabase_url}/rest/v1/game?select=game_id&limit=1",
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Prefer": "count=exact",
            "Range": "0-0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            response.read()
            return response.headers.get("Content-Range", "unknown")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1200]
        raise RuntimeError(
            f"Supabase row-count verification failed (HTTP {error.code}): {detail}"
        ) from error


def send_batch(endpoint: str, service_key: str, rows: list[dict[str, Any]]) -> None:
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    data = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(endpoint, data=data, headers=headers, method="POST")
    for attempt in range(1, 6):
        try:
            with urllib.request.urlopen(request, timeout=120):
                return
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1200]
            if error.code not in {429, 500, 502, 503, 504} or attempt == 5:
                raise RuntimeError(
                    f"Supabase game upsert failed (HTTP {error.code}): {detail}"
                ) from error
            retry_after = error.headers.get("Retry-After")
            delay = int(retry_after) if retry_after and retry_after.isdigit() else min(60, 3**attempt)
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 5:
                raise RuntimeError(f"Supabase request failed: {error}") from error
            time.sleep(min(60, 3**attempt))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--merge-only", action="store_true", help="Build CSV without uploading")
    parser.add_argument("--upload-only", action="store_true", help="Upload existing merged CSV only")
    parser.add_argument("--verify-only", action="store_true", help="Read and report the remote game row count")
    parser.add_argument("--output", type=Path, default=OUTPUT_CSV, help="Merged CSV output path")
    args = parser.parse_args()

    output_csv = args.output.resolve()
    selected_modes = sum((args.merge_only, args.upload_only, args.verify_only))
    if selected_modes > 1:
        parser.error("Use only one of --merge-only, --upload-only, or --verify-only.")

    if args.verify_only:
        print(f"Supabase game Content-Range: {verify_remote_count()}")
        return

    if not args.upload_only:
        rank_rows, game_only_rows, total_rows = merge_csv(output_csv)
        print(f"Rank CSV rows: {rank_rows}")
        print(f"Games-only rows: {game_only_rows}")
        print(f"Merged CSV rows: {total_rows}")
        print(f"Wrote: {output_csv}")
    if not args.merge_only:
        uploaded = upload_csv(output_csv)
        print(f"Supabase upsert complete: {uploaded} game rows.")


if __name__ == "__main__":
    main()
