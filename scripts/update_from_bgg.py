"""Update selected Supabase game records from BGG's XML API 2.

Set BGG_KEY in config.secret.json, then run, for example:

    python scripts/update_from_bgg.py 13 174430

Supabase URL and service key are read from the local config files. Do not commit
config.secret.json or expose its service key in client-side code.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
RANKS_CSV = ROOT / "data" / "boardgames_ranks.csv"
BGG_THING_URL = "https://boardgamegeek.com/xmlapi2/thing"


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as file:
        return json.load(file)


def nullable_int(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def nullable_decimal(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(Decimal(value))
    except (InvalidOperation, ValueError):
        return None


def child_value(element: ET.Element, tag: str) -> str | None:
    child = element.find(tag)
    return child.get("value") if child is not None else None


def bgg_request(ids: list[int], token: str) -> ET.Element:
    query = urllib.parse.urlencode(
        {"id": ",".join(map(str, ids)), "type": "boardgame,boardgameexpansion", "stats": "1"}
    )
    request = urllib.request.Request(
        f"{BGG_THING_URL}?{query}",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "BoardGameTracker/1.0"},
    )

    for attempt in range(1, 7):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status == 202:
                    if attempt == 6:
                        raise RuntimeError("BGG kept the request queued after six attempts.")
                    time.sleep(min(60, 5 * attempt))
                    continue
                return ET.fromstring(response.read())
        except urllib.error.HTTPError as error:
            if error.code not in {202, 429, 500, 503} or attempt == 6:
                detail = error.read().decode("utf-8", errors="replace")[:500]
                raise RuntimeError(f"BGG API returned HTTP {error.code}: {detail}") from error
            time.sleep(min(60, 5 * attempt))

    raise RuntimeError("BGG request failed after six attempts.")


class Supabase:
    def __init__(self, url: str, service_key: str) -> None:
        self.base_url = url.rstrip("/") + "/rest/v1"
        self.service_key = service_key

    def request(
        self,
        table: str,
        method: str,
        rows: list[dict[str, Any]] | None = None,
        query: str = "",
        upsert: bool = False,
    ) -> None:
        url = f"{self.base_url}/{table}{query}"
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Accept": "application/json",
        }
        data = None
        if rows is not None:
            data = json.dumps(rows, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if upsert:
            headers["Prefer"] = "resolution=merge-duplicates,return=minimal"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60):
                pass
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1000]
            raise RuntimeError(f"Supabase {method} {table} failed (HTTP {error.code}): {detail}") from error


def extract_game(item: ET.Element) -> tuple[dict[str, Any], list[str], list[str]] | None:
    game_id = nullable_int(item.get("id"))
    primary_name = next(
        (name.get("value") for name in item.findall("name") if name.get("type") == "primary"),
        None,
    )
    if game_id is None or not primary_name:
        return None

    ratings = item.find("./statistics/ratings")
    average = ratings.find("average") if ratings is not None else None
    weight = ratings.find("averageweight") if ratings is not None else None
    bayes_average = ratings.find("bayesaverage") if ratings is not None else None

    game = {
        "game_id": game_id,
        "is_expansion": item.get("type") == "boardgameexpansion",
        "name": primary_name,
        "description": item.findtext("description"),
        "year_published": nullable_int(child_value(item, "yearpublished")),
        "game_weight": nullable_decimal(weight.get("value") if weight is not None else None),
        "avg_rating": nullable_decimal(average.get("value") if average is not None else None),
        "bayes_avg_rating": nullable_decimal(
            bayes_average.get("value") if bayes_average is not None else None
        ),
        "min_players": nullable_int(child_value(item, "minplayers")),
        "max_players": nullable_int(child_value(item, "maxplayers")),
        "community_age_rec": None,
        "language_ease": None,
        "best_players": None,
        "good_players": None,
        "manufacturer_playtime": nullable_int(child_value(item, "playingtime")),
        "community_min_playtime": nullable_int(child_value(item, "minplaytime")),
        "community_max_playtime": nullable_int(child_value(item, "maxplaytime")),
        "manufacturer_age_rec": nullable_int(child_value(item, "minage")),
        "image_url": item.findtext("image"),
    }

    mechanics = sorted(
        {
            link.get("value", "")
            for link in item.findall("link")
            if link.get("type") == "boardgamemechanic" and link.get("value")
        }
    )
    categories = sorted(
        {
            link.get("value", "")
            for link in item.findall("link")
            if link.get("type") == "boardgamecategory" and link.get("value")
        }
    )
    return game, mechanics, categories


def update_game(db: Supabase, game: dict[str, Any], mechanics: list[str], categories: list[str]) -> None:
    game_id = game["game_id"]
    db.request("game", "POST", [game], query="?on_conflict=game_id", upsert=True)

    relations = (
        ("game_mechanic", f"?game_id=eq.{game_id}"),
        ("game_subcategory", f"?game_id=eq.{game_id}"),
    )
    for table, query in relations:
        db.request(table, "DELETE", query=query)

    if mechanics:
        db.request("mechanic", "POST", [{"name": name} for name in mechanics], query="?on_conflict=name", upsert=True)
        db.request(
            "game_mechanic",
            "POST",
            [{"game_id": game_id, "mechanic_name": name} for name in mechanics],
        )
    if categories:
        db.request("subcategory", "POST", [{"name": name} for name in categories], query="?on_conflict=name", upsert=True)
        db.request(
            "game_subcategory",
            "POST",
            [{"game_id": game_id, "subcategory_name": name} for name in categories],
        )


def recent_ranked_ids(years: int) -> list[int]:
    """Read recent publication years from the local BGG ranks snapshot."""
    if not RANKS_CSV.exists():
        raise RuntimeError(f"BGG ranks CSV not found: {RANKS_CSV}")
    first_year = dt.date.today().year - years + 1
    ids: list[int] = []
    with RANKS_CSV.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            try:
                game_id = int(row["id"])
                year = int(row["yearpublished"])
            except (KeyError, TypeError, ValueError):
                continue
            if game_id > 0 and first_year <= year <= dt.date.today().year:
                ids.append(game_id)
    return list(dict.fromkeys(ids))


def main() -> None:
    parser = argparse.ArgumentParser(description="Update selected Supabase games from BoardGameGeek.")
    parser.add_argument("game_ids", nargs="*", type=int, help="One or more BGG game IDs")
    parser.add_argument(
        "--recent-years",
        type=int,
        metavar="N",
        help="Update games published in the last N years from data/boardgames_ranks.csv",
    )
    parser.add_argument("--throttle-seconds", type=int, default=5, help="Delay between BGG requests (default: 5)")
    args = parser.parse_args()

    secret_config = read_json(ROOT / "config.secret.json")
    token = os.environ.get("BGG_KEY", secret_config.get("BGG_KEY", "")).strip()
    if not token:
        parser.error("Set BGG_KEY in config.secret.json or the environment.")
    if args.throttle_seconds < 0:
        parser.error("--throttle-seconds must be zero or greater.")
    if args.recent_years is not None and args.recent_years < 1:
        parser.error("--recent-years must be at least 1.")
    if args.recent_years is not None and args.game_ids:
        parser.error("Use either game IDs or --recent-years, not both.")
    if args.recent_years is None and not args.game_ids:
        parser.error("Provide game IDs or use --recent-years N.")

    public_config = read_json(ROOT / "config.public.json")
    supabase_url = public_config.get("SUPABASE_URL", "").strip()
    service_key = secret_config.get("SUPABASE_SERVICE_KEY", "").strip()
    if not supabase_url or not service_key:
        parser.error("Supabase URL or service key is missing from the local config files.")

    if args.recent_years is not None:
        ids = recent_ranked_ids(args.recent_years)
        print(f"Selected {len(ids)} ranked games published in the last {args.recent_years} year(s).")
    else:
        ids = list(dict.fromkeys(game_id for game_id in args.game_ids if game_id > 0))
    if not ids:
        parser.error("No eligible game IDs were found.")

    db = Supabase(supabase_url, service_key)
    batches = [ids[index : index + 20] for index in range(0, len(ids), 20)]
    for batch_index, batch in enumerate(batches):
        if batch_index:
            time.sleep(args.throttle_seconds)
        root = bgg_request(batch, token)
        for item in root.findall("item"):
            record = extract_game(item)
            if record is None:
                continue
            game, mechanics, categories = record
            update_game(db, game, mechanics, categories)
            print(f"Updated game {game['game_id']}: {game['name']}")

    print(f"Finished updating {len(ids)} requested BGG ID(s).")


if __name__ == "__main__":
    main()
