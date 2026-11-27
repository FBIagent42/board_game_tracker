"""Import a user's BGG collection directly into Supabase.

Example:
    python scripts/import_collection_csv.py --bgg-username my_bgg_name

The BGG application token and Supabase service key are read from environment
variables or config.secret.json. Never use or store a user's BGG password.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
BGG_COLLECTION_URL = "https://boardgamegeek.com/xmlapi2/collection"
BGG_THING_URL = "https://boardgamegeek.com/xmlapi2/thing"
DEFAULT_BATCH_SIZE = 500
BGG_IDS_PER_REQUEST = 20
MAX_BGG_ATTEMPTS = 12
BGG_RETRY_DELAY_SECONDS = 5
RETRYABLE_HTTP_CODES = {429, 500, 502, 503, 504}
GAME_DETAIL_FIELDS = (
    "is_expansion",
    "name",
    "description",
    "year_published",
    "game_weight",
    "avg_rating",
    "bayes_avg_rating",
    "min_players",
    "max_players",
    "manufacturer_playtime",
    "community_min_playtime",
    "community_max_playtime",
    "manufacturer_age_rec",
    "image_url",
)
GAME_ENRICHMENT_FIELDS = (
    "is_expansion",
    "description",
    "year_published",
    "game_weight",
    "avg_rating",
    "bayes_avg_rating",
    "min_players",
    "max_players",
    "manufacturer_playtime",
    "community_min_playtime",
    "community_max_playtime",
    "manufacturer_age_rec",
    "image_url",
)


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as source:
        return json.load(source)


def read_config() -> tuple[str, str, str, str]:
    public = read_json(ROOT / "config.public.json")
    secret = read_json(ROOT / "config.secret.json")
    supabase_url = str(public.get("SUPABASE_URL", "")).strip().rstrip("/")
    bgg_token = os.environ.get("BGG_KEY", str(secret.get("BGG_KEY", ""))).strip()
    service_key = os.environ.get(
        "SUPABASE_SERVICE_KEY", str(secret.get("SUPABASE_SERVICE_KEY", ""))
    ).strip()
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is missing from config.public.json.")
    if not bgg_token:
        raise RuntimeError("Set BGG_KEY in the environment or config.secret.json.")
    if not service_key:
        raise RuntimeError("Set SUPABASE_SERVICE_KEY in the environment or config.secret.json.")
    bgg_username = os.environ.get("BGG_USERNAME", str(secret.get("BGG_USERNAME", ""))).strip()
    return supabase_url, bgg_token, service_key, bgg_username


def parse_nonnegative_int(value: str | None, field: str, default: int = 0) -> int:
    if value is None or not value.strip():
        return default
    try:
        number = int(value)
    except ValueError as error:
        raise ValueError(f"BGG returned an invalid {field}: {value!r}") from error
    if number < 0:
        raise ValueError(f"BGG returned a negative {field}: {value!r}")
    return number


def fetch_collection(bgg_username: str, bgg_token: str) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({"username": bgg_username, "stats": "1"})
    request = urllib.request.Request(
        f"{BGG_COLLECTION_URL}?{query}",
        headers={
            "Authorization": f"Bearer {bgg_token}",
            "User-Agent": "BoardGameTracker/1.0",
            "Accept": "application/xml",
        },
    )

    for attempt in range(1, MAX_BGG_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                if response.status == 202:
                    if attempt == MAX_BGG_ATTEMPTS:
                        raise RuntimeError("BGG kept the collection request queued after 12 attempts.")
                    time.sleep(BGG_RETRY_DELAY_SECONDS)
                    continue
                xml_data = response.read()
            break
        except urllib.error.HTTPError as error:
            if error.code != 202 and error.code not in RETRYABLE_HTTP_CODES:
                detail = error.read().decode("utf-8", errors="replace")[:500]
                raise RuntimeError(f"BGG collection request failed (HTTP {error.code}): {detail}") from error
            if attempt == MAX_BGG_ATTEMPTS:
                raise RuntimeError(
                    f"BGG collection request remained unavailable after {attempt} attempts "
                    f"(HTTP {error.code})."
                ) from error
            retry_after = error.headers.get("Retry-After", "")
            delay = int(retry_after) if retry_after.isdigit() else BGG_RETRY_DELAY_SECONDS
            time.sleep(max(BGG_RETRY_DELAY_SECONDS, delay))
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == MAX_BGG_ATTEMPTS:
                raise RuntimeError("Could not reach BGG after 12 attempts.") from error
            time.sleep(BGG_RETRY_DELAY_SECONDS)
    else:
        raise RuntimeError("BGG collection request ended without a response.")

    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError as error:
        raise RuntimeError("BGG returned invalid collection XML.") from error
    if root.tag != "items":
        raise RuntimeError(f"BGG returned an unexpected collection response: <{root.tag}>.")

    collection_by_id: dict[int, dict[str, Any]] = {}
    for item in root.findall("item"):
        raw_id = item.get("objectid") or item.get("id")
        if not raw_id:
            continue
        try:
            game_id = int(raw_id)
        except ValueError as error:
            raise RuntimeError(f"BGG returned an invalid game ID: {raw_id!r}") from error
        if game_id <= 0:
            raise RuntimeError(f"BGG returned an invalid game ID: {raw_id!r}")

        name_node = item.find("name")
        game_name = (name_node.text or "").strip() if name_node is not None else ""
        if not game_name and name_node is not None:
            game_name = (name_node.get("value") or "").strip()
        year_node = item.find("yearpublished")
        year = None
        if year_node is not None:
            raw_year = year_node.get("value") or year_node.text
            if raw_year and raw_year.strip():
                year = parse_nonnegative_int(raw_year, "yearpublished")

        status = item.find("status")
        own_value = status.get("own", "0") if status is not None else "0"
        own = own_value.strip().lower() in {"1", "true", "t", "yes"}
        plays = parse_nonnegative_int(item.findtext("numplays"), "numplays")
        if game_id in collection_by_id:
            raise RuntimeError(f"BGG returned game ID {game_id} more than once.")

        collection_by_id[game_id] = {
            "game_id": game_id,
            "name": game_name,
            "year_published": year,
            "own": own,
            "numplays": plays,
        }

    return list(collection_by_id.values())


def xml_value(item: ET.Element, tag: str) -> str | None:
    node = item.find(tag)
    if node is None:
        return None
    return node.get("value") or node.text


def parse_bgg_game(item: ET.Element) -> dict[str, Any] | None:
    raw_id = item.get("id")
    names = item.findall("name")
    primary_name = next(
        (name.get("value") for name in names if name.get("type") == "primary"),
        names[0].get("value") if names else None,
    )
    if not raw_id or not primary_name:
        return None

    ratings = item.find("./statistics/ratings")

    def rating_value(tag: str) -> str | None:
        node = ratings.find(tag) if ratings is not None else None
        return node.get("value") if node is not None else None

    def nullable_number(raw: str | None, *, integer: bool = False) -> int | float | None:
        if not raw or not raw.strip():
            return None
        try:
            return int(float(raw)) if integer else float(raw)
        except ValueError:
            return None

    game_id = parse_nonnegative_int(raw_id, "game ID")
    if game_id == 0:
        return None
    image = (item.findtext("image") or "").strip() or (item.findtext("thumbnail") or "").strip()
    return {
        "game_id": game_id,
        "is_expansion": item.get("type") == "boardgameexpansion",
        "name": primary_name.strip(),
        "description": item.findtext("description"),
        "year_published": nullable_number(xml_value(item, "yearpublished"), integer=True),
        "game_weight": nullable_number(rating_value("averageweight")),
        "avg_rating": nullable_number(rating_value("average")),
        "bayes_avg_rating": nullable_number(rating_value("bayesaverage")),
        "min_players": nullable_number(xml_value(item, "minplayers"), integer=True),
        "max_players": nullable_number(xml_value(item, "maxplayers"), integer=True),
        "manufacturer_playtime": nullable_number(xml_value(item, "playingtime"), integer=True),
        "community_min_playtime": nullable_number(xml_value(item, "minplaytime"), integer=True),
        "community_max_playtime": nullable_number(xml_value(item, "maxplaytime"), integer=True),
        "manufacturer_age_rec": nullable_number(xml_value(item, "minage"), integer=True),
        "image_url": image or None,
    }


def fetch_game_details(game_ids: list[int], bgg_token: str, throttle_seconds: int = 5) -> list[dict[str, Any]]:
    """Fetch full BGG metadata only for IDs absent from the Supabase catalog."""
    details_by_id: dict[int, dict[str, Any]] = {}
    batches = [game_ids[start : start + BGG_IDS_PER_REQUEST] for start in range(0, len(game_ids), BGG_IDS_PER_REQUEST)]

    for batch in batches:
        # The collection endpoint was the preceding BGG request, so wait before
        # the first detail call too; subsequent calls stay at least this far apart.
        if throttle_seconds:
            time.sleep(throttle_seconds)
        query = urllib.parse.urlencode(
            {
                "id": ",".join(str(game_id) for game_id in batch),
                "type": "boardgame,boardgameexpansion",
                "stats": "1",
            }
        )
        request = urllib.request.Request(
            f"{BGG_THING_URL}?{query}",
            headers={
                "Authorization": f"Bearer {bgg_token}",
                "User-Agent": "BoardGameTracker/1.0",
                "Accept": "application/xml",
            },
        )

        for attempt in range(1, MAX_BGG_ATTEMPTS + 1):
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    if response.status == 202:
                        if attempt == MAX_BGG_ATTEMPTS:
                            raise RuntimeError("BGG kept a game detail request queued after 12 attempts.")
                        time.sleep(BGG_RETRY_DELAY_SECONDS)
                        continue
                    xml_data = response.read()
                break
            except urllib.error.HTTPError as error:
                if error.code != 202 and error.code not in RETRYABLE_HTTP_CODES:
                    detail = error.read().decode("utf-8", errors="replace")[:500]
                    raise RuntimeError(f"BGG game detail request failed (HTTP {error.code}): {detail}") from error
                if attempt == MAX_BGG_ATTEMPTS:
                    raise RuntimeError(
                        f"BGG game detail request remained unavailable after {attempt} attempts."
                    ) from error
                retry_after = error.headers.get("Retry-After", "")
                delay = int(retry_after) if retry_after.isdigit() else BGG_RETRY_DELAY_SECONDS
                time.sleep(max(BGG_RETRY_DELAY_SECONDS, delay))
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt == MAX_BGG_ATTEMPTS:
                    raise RuntimeError("Could not reach BGG for game details after 12 attempts.") from error
                time.sleep(BGG_RETRY_DELAY_SECONDS)
        else:
            raise RuntimeError("BGG game detail request ended without a response.")

        try:
            root = ET.fromstring(xml_data)
        except ET.ParseError as error:
            raise RuntimeError("BGG returned invalid game detail XML.") from error
        if root.tag != "items":
            raise RuntimeError(f"BGG returned an unexpected game detail response: <{root.tag}>.")
        for item in root.findall("item"):
            game = parse_bgg_game(item)
            if game:
                details_by_id[game["game_id"]] = game

    missing_detail_ids = sorted(set(game_ids) - details_by_id.keys())
    if missing_detail_ids:
        raise RuntimeError(
            "BGG did not return game details for catalog holes: "
            f"{missing_detail_ids[:20]}"
        )
    return [details_by_id[game_id] for game_id in game_ids]


class SupabaseRest:
    def __init__(self, url: str, service_key: str) -> None:
        self.base_url = url.rstrip("/") + "/rest/v1"
        self.service_key = service_key

    def request(
        self,
        table: str,
        method: str,
        rows: list[dict[str, Any]] | None = None,
        query: str = "",
        conflict: str | None = None,
    ) -> list[dict[str, Any]] | None:
        if conflict:
            separator = "&" if "?" in query else "?"
            query += separator + urllib.parse.urlencode({"on_conflict": conflict})
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Accept": "application/json",
        }
        data = None
        if rows is not None:
            payload: Any = rows[0] if method == "PATCH" and len(rows) == 1 else rows
            data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Prefer"] = "resolution=merge-duplicates,return=minimal" if conflict else "return=minimal"
        request = urllib.request.Request(
            f"{self.base_url}/{table}{query}", data=data, headers=headers, method=method
        )
        for attempt in range(1, 6):
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    body = response.read()
                if not body:
                    return None
                parsed = json.loads(body.decode("utf-8"))
                return parsed if isinstance(parsed, list) else None
            except urllib.error.HTTPError as error:
                if error.code not in RETRYABLE_HTTP_CODES or attempt == 5:
                    detail = error.read().decode("utf-8", errors="replace")[:700]
                    raise RuntimeError(
                        f"Supabase {method} {table} failed (HTTP {error.code}): {detail}"
                    ) from error
                retry_after = error.headers.get("Retry-After", "")
                delay = int(retry_after) if retry_after.isdigit() else min(30, 2**attempt)
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt == 5:
                    raise RuntimeError(f"Supabase {method} {table} request failed.") from error
                time.sleep(min(30, 2**attempt))
        return None

    def existing_game_rows(self, game_ids: list[int], batch_size: int) -> dict[int, dict[str, Any]]:
        existing: dict[int, dict[str, Any]] = {}
        for start in range(0, len(game_ids), batch_size):
            batch = game_ids[start : start + batch_size]
            values = ",".join(str(game_id) for game_id in batch)
            query = "?" + urllib.parse.urlencode(
                {"select": ",".join(("game_id", *GAME_DETAIL_FIELDS)), "game_id": f"in.({values})"}
            )
            rows = self.request("game", "GET", query=query) or []
            existing.update(
                (int(row["game_id"]), row)
                for row in rows
                if row.get("game_id") is not None
            )
        return existing

    def upsert_batches(
        self,
        table: str,
        rows: list[dict[str, Any]],
        conflict: str,
        batch_size: int,
    ) -> int:
        sent = 0
        # PostgREST expects rows in one bulk insert to have the same keys.
        # Group partial game updates by shape so omitted columns stay omitted
        # instead of becoming null for rows that do not patch those columns.
        batches_by_shape: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for row in rows:
            shape = tuple(sorted(row))
            batches_by_shape.setdefault(shape, []).append(row)
        for shaped_rows in batches_by_shape.values():
            for start in range(0, len(shaped_rows), batch_size):
                batch = shaped_rows[start : start + batch_size]
                self.request(table, "POST", rows=batch, conflict=conflict)
                sent += len(batch)
        return sent

    def patch_game_rows(self, rows: list[dict[str, Any]]) -> int:
        patched = 0
        for row in rows:
            game_id = int(row["game_id"])
            query = "?" + urllib.parse.urlencode({"game_id": f"eq.{game_id}"})
            self.request("game", "PATCH", rows=[row], query=query)
            patched += 1
        return patched


def main() -> None:
    parser = argparse.ArgumentParser(description="Pull a BGG collection into Supabase.")
    parser.add_argument(
        "--bgg-username",
        default=None,
        help="BoardGameGeek username to import (defaults to BGG_USERNAME in config.secret.json)",
    )
    parser.add_argument("--user-id", type=int, default=1, help="Local application user ID (default: 1)")
    parser.add_argument(
        "--username",
        default="collection_owner",
        help="Local application username to upsert (not the BGG username)",
    )
    parser.add_argument("--email", default=None, help="Optional local application email")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument(
        "--throttle-seconds",
        type=int,
        default=BGG_RETRY_DELAY_SECONDS,
        help="Minimum delay between BGG detail requests (default: 5)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Fetch and validate without writing to Supabase")
    args = parser.parse_args()
    if args.batch_size < 1 or args.batch_size > 1000:
        parser.error("--batch-size must be between 1 and 1000.")
    if args.user_id < 1:
        parser.error("--user-id must be a positive integer.")
    if args.throttle_seconds < 0:
        parser.error("--throttle-seconds must be zero or greater.")

    supabase_url, bgg_token, service_key, configured_username = read_config()
    bgg_username = (args.bgg_username or configured_username).strip()
    if not bgg_username:
        parser.error("Set BGG_USERNAME in config.secret.json or pass --bgg-username.")

    collection = fetch_collection(bgg_username, bgg_token)
    if not collection:
        print(f"BGG returned an empty collection for {bgg_username}.")
        return

    missing_names = [row["game_id"] for row in collection if not row["name"]]
    if missing_names:
        raise RuntimeError(f"BGG omitted names for game IDs: {missing_names[:10]}")

    owned_count = sum(1 for row in collection if row["own"])
    print(
        f"Fetched {len(collection)} collection rows for {bgg_username} "
        f"({owned_count} marked owned)."
    )

    db = SupabaseRest(supabase_url, service_key)
    game_ids = [row["game_id"] for row in collection]
    existing_games = db.existing_game_rows(game_ids, args.batch_size)
    existing_ids = set(existing_games)
    missing_ids = [game_id for game_id in game_ids if game_id not in existing_ids]
    incomplete_ids = [
        game_id
        for game_id in game_ids
        if game_id in existing_games
        and any(
            existing_games[game_id].get(field) is None
            or (
                isinstance(existing_games[game_id].get(field), str)
                and not existing_games[game_id][field].strip()
            )
            for field in GAME_ENRICHMENT_FIELDS
        )
    ]
    detail_ids = list(dict.fromkeys([*missing_ids, *incomplete_ids]))
    fetched_details = fetch_game_details(detail_ids, bgg_token, args.throttle_seconds)
    details_by_id = {row["game_id"]: row for row in fetched_details}
    missing_games = [details_by_id[game_id] for game_id in missing_ids]
    games_to_fill: list[dict[str, Any]] = []
    for game_id in incomplete_ids:
        existing = existing_games[game_id]
        details = details_by_id[game_id]
        patch = {"game_id": game_id}
        for field in GAME_DETAIL_FIELDS:
            existing_value = existing.get(field)
            is_missing = existing_value is None or (
                isinstance(existing_value, str) and not existing_value.strip()
            )
            detail_value = details.get(field)
            has_detail = detail_value is not None and not (
                isinstance(detail_value, str) and not detail_value.strip()
            )
            if is_missing and has_detail:
                patch[field] = detail_value
        if len(patch) > 1:
            games_to_fill.append(patch)
    collection_rows = [
        {
            "user_id": args.user_id,
            "game_id": row["game_id"],
            "numplays": row["numplays"],
            "own": row["own"],
        }
        for row in collection
    ]

    if args.dry_run:
        print(
            f"Supabase lookup: {len(existing_ids)} games already exist; "
            f"{len(missing_games)} missing games would be added and "
            f"{len(games_to_fill)} existing games would have null fields filled."
        )
        print(f"BGG detail fetch covered {len(detail_ids)} games.")
        print(f"Would upsert {len(collection_rows)} collection rows in batches of {args.batch_size}.")
        return

    user_row: dict[str, Any] = {"user_id": args.user_id, "username": args.username}
    if args.email:
        user_row["email"] = args.email
    user = [user_row]
    db.upsert_batches("user", user, "user_id", args.batch_size)
    games_added = db.upsert_batches("game", missing_games, "game_id", args.batch_size)
    games_filled = db.patch_game_rows(games_to_fill)
    collection_imported = db.upsert_batches(
        "user_collection", collection_rows, "user_id,game_id", args.batch_size
    )

    print(f"Added full BGG game detail rows missing from Supabase: {games_added}")
    print(f"Filled missing fields in existing game rows: {games_filled}")
    print(f"Upserted collection rows for local user {args.user_id}: {collection_imported}")
    print(
        "BGG play count total imported: "
        f"{sum(row['numplays'] for row in collection_rows)}. "
        "This is an initial snapshot; a future plays table should become the source of truth."
    )
    print("Existing collection rows absent from BGG's response were left unchanged.")


if __name__ == "__main__":
    main()
