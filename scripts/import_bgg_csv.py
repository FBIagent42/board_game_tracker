"""Import the local BGG CSV catalog and its classification relationships."""

from __future__ import annotations

import csv
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BATCH_SIZE = 500


def batches(rows: Iterable[dict[str, Any]], size: int = BATCH_SIZE):
    batch: list[dict[str, Any]] = []
    for row in rows:
        batch.append(row)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def number(value: str | None, integer: bool = False) -> int | float | None:
    if value is None or not value.strip():
        return None
    try:
        return int(float(value)) if integer else float(value)
    except ValueError:
        return None


def nullable_bool(value: str | None) -> bool | None:
    if value is None or not value.strip():
        return None
    normalized = value.strip().lower()
    if normalized in {"1", "1.0", "true", "t", "yes"}:
        return True
    if normalized in {"0", "0.0", "false", "f", "no"}:
        return False
    return None


def csv_rows(filename: str):
    with (DATA / filename).open("r", encoding="utf-8-sig", newline="") as file:
        yield from csv.DictReader(file)


class SupabaseRest:
    def __init__(self, url: str, service_key: str) -> None:
        self.url = url.rstrip("/") + "/rest/v1"
        self.key = service_key

    def send(
        self,
        table: str,
        rows: list[dict[str, Any]],
        conflict: str | None = None,
        ignore_duplicates: bool = False,
    ) -> None:
        query = ""
        if conflict:
            query = "?on_conflict=" + urllib.parse.quote(conflict, safe=",")
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": (
                "resolution=ignore-duplicates,return=minimal"
                if ignore_duplicates
                else "resolution=merge-duplicates,return=minimal"
            ),
        }
        request = urllib.request.Request(
            f"{self.url}/{table}{query}",
            data=json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        for attempt in range(1, 6):
            try:
                with urllib.request.urlopen(request, timeout=90):
                    return
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")[:1200]
                if error.code not in {429, 500, 502, 503, 504} or attempt == 5:
                    raise RuntimeError(f"Supabase insert into {table} failed (HTTP {error.code}): {detail}") from error
                time.sleep(min(30, attempt * 2))
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt == 5:
                    raise RuntimeError(f"Supabase request to {table} failed: {error}") from error
                time.sleep(min(30, attempt * 2))


def import_games(db: SupabaseRest) -> int:
    fields: dict[str, tuple[str, bool]] = {
        "game_id": ("BGGId", True),
        "is_expansion": ("IsExpansion", True),
        "name": ("Name", False),
        "description": ("Description", False),
        "year_published": ("YearPublished", True),
        "game_weight": ("GameWeight", False),
        "avg_rating": ("AvgRating", False),
        "bayes_avg_rating": ("BayesAvgRating", False),
        "min_players": ("MinPlayers", True),
        "max_players": ("MaxPlayers", True),
        "community_age_rec": ("ComAgeRec", False),
        "best_players": ("BestPlayers", False),
        "manufacturer_playtime": ("MfgPlaytime", True),
        "community_min_playtime": ("ComMinPlaytime", True),
        "community_max_playtime": ("ComMaxPlaytime", True),
        "manufacturer_age_rec": ("MfgAgeRec", True),
        "image_url": ("ImagePath", False),
    }
    count = 0
    for batch in batches(
        (
            {
                column: (
                    nullable_bool(source.get(input_name))
                    if column == "is_expansion"
                    else number(source.get(input_name), integer)
                    if integer or column not in {"name", "description", "best_players", "image_url"}
                    else (source.get(input_name) or None)
                )
                for column, (input_name, integer) in fields.items()
            }
            for source in csv_rows("games.csv")
            if source.get("BGGId") and source.get("Name")
        )
    ):
        db.send("game", batch, conflict="game_id")
        count += len(batch)
        print(f"Games upserted: {count}", flush=True)
    return count


def import_classifications(db: SupabaseRest, filename: str, label_table: str, link_table: str, link_column: str) -> tuple[int, int]:
    labels: set[str] = set()
    links: list[dict[str, Any]] = []
    for row in csv_rows(filename):
        raw_id = row.get("BGGId")
        if not raw_id:
            continue
        try:
            game_id = int(raw_id)
        except ValueError:
            continue
        for label, value in row.items():
            if label == "BGGId" or value is None or value.strip() not in {"1", "1.0", "true", "True"}:
                continue
            labels.add(label)
            links.append({"game_id": game_id, link_column: label})

    for batch in batches(({"name": label} for label in sorted(labels))):
        db.send(label_table, batch, conflict="name")
    sent = 0
    for batch in batches(links, size=1000):
        db.send(
            link_table,
            batch,
            conflict=f"game_id,{link_column}",
            ignore_duplicates=True,
        )
        sent += len(batch)
        print(f"{link_table} links uploaded: {sent}", flush=True)
    return len(labels), sent


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] in {"-h", "--help"}:
        print("Usage: python scripts/import_bgg_csv.py")
        return

    with (ROOT / "config.public.json").open("r", encoding="utf-8-sig") as file:
        public_config = json.load(file)
    with (ROOT / "config.secret.json").open("r", encoding="utf-8-sig") as file:
        secret_config = json.load(file)

    url = public_config.get("SUPABASE_URL", "").strip()
    key = secret_config.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        raise RuntimeError("SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from the local config files.")

    db = SupabaseRest(url, key)
    game_count = import_games(db)
    mechanic_count = import_classifications(
        db, "mechanics.csv", "mechanic", "game_mechanic", "mechanic_name"
    )
    subcategory_count = import_classifications(
        db, "subcategories.csv", "subcategory", "game_subcategory", "subcategory_name"
    )
    theme_count = import_classifications(db, "themes.csv", "theme", "game_theme", "theme_name")

    print("\nCSV import complete.")
    print(f"Games: {game_count}")
    print(f"Mechanics: {mechanic_count[0]} labels, {mechanic_count[1]} links")
    print(f"Subcategories: {subcategory_count[0]} labels, {subcategory_count[1]} links")
    print(f"Themes: {theme_count[0]} labels, {theme_count[1]} links")


if __name__ == "__main__":
    main()
