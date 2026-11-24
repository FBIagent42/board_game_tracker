"""Import data/collection.csv into public.user and public.user_collection."""

from __future__ import annotations

import argparse
import csv
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent


def read_csv() -> list[dict[str, str]]:
    with (ROOT / "data" / "collection.csv").open("r", encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def post(url: str, key: str, table: str, rows: list[dict[str, Any]], conflict: str) -> None:
    query = urllib.parse.urlencode({"on_conflict": conflict})
    request = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/{table}?{query}",
        data=json.dumps(rows, ensure_ascii=False).encode("utf-8"),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60):
            pass
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"Supabase insert into {table} failed (HTTP {error.code}): {detail}") from error


def number(value: str | None, integer: bool = False) -> int | float | None:
    if not value or not value.strip():
        return None
    try:
        return int(float(value)) if integer else float(value)
    except ValueError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Import your BGG collection CSV into Supabase.")
    parser.add_argument("--user-id", type=int, default=1, help="Local user ID (default: 1)")
    parser.add_argument(
        "--username",
        default="collection_owner",
        help="Username to associate with this imported collection (default: collection_owner)",
    )
    parser.add_argument("--email", default=None, help="Optional email for this local user row")
    args = parser.parse_args()

    with (ROOT / "config.public.json").open("r", encoding="utf-8-sig") as file:
        public_config = json.load(file)
    with (ROOT / "config.secret.json").open("r", encoding="utf-8-sig") as file:
        secret_config = json.load(file)
    url = public_config.get("SUPABASE_URL", "").strip()
    key = secret_config.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        raise RuntimeError("Supabase URL or service key is missing from the local config files.")

    source_rows = read_csv()
    catalog_ids = set()
    with (ROOT / "data" / "games.csv").open("r", encoding="utf-8-sig", newline="") as file:
        catalog_ids = {row["BGGId"] for row in csv.DictReader(file) if row.get("BGGId")}

    collection = []
    for row in source_rows:
        if not row.get("objectid"):
            continue
        if row["objectid"] not in catalog_ids:
            continue
        collection.append(
            {
                "user_id": args.user_id,
                "game_id": int(row["objectid"]),
                "numplays": max(0, int(float(row.get("numplays") or 0))),
                "own": row.get("own", "0").strip().lower() in {"1", "true", "t", "yes"},
            }
        )

    user = [{"user_id": args.user_id, "username": args.username, "email": args.email}]
    post(url, key, "user", user, "user_id")
    post(url, key, "user_collection", collection, "user_id,game_id")

    owned = sum(1 for row in collection if row["own"])
    print(f"Imported {len(collection)} collection records for user {args.user_id} ({owned} marked owned).")
    print(f"CSV numplays total (initial value): {sum(row['numplays'] for row in collection)}")


if __name__ == "__main__":
    main()
