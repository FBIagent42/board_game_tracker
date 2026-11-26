"""Save detailed BGG XML API game records as resumable JSON Lines."""

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
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
RANKS_CSV = ROOT / "data" / "boardgames_ranks.csv"
DEFAULT_OUTPUT = ROOT / "data" / "bgg_game_details.jsonl"
BGG_THING_URL = "https://boardgamegeek.com/xmlapi2/thing"
MAX_IDS_PER_REQUEST = 20


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as file:
        return json.load(file)


def read_ids(args: argparse.Namespace) -> list[int]:
    if args.ids:
        return list(dict.fromkeys(game_id for game_id in args.ids if game_id > 0))
    if not RANKS_CSV.exists():
        raise RuntimeError(f"BGG ranks CSV not found: {RANKS_CSV}")

    ids: list[int] = []
    with RANKS_CSV.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            try:
                game_id = int(row["id"])
            except (KeyError, TypeError, ValueError):
                continue
            if game_id > 0:
                ids.append(game_id)
    ids = list(dict.fromkeys(ids))
    return ids[: args.limit] if args.limit else ids


def xml_to_data(element: ET.Element) -> Any:
    """Convert XML into JSON-friendly values without discarding BGG fields."""
    result: dict[str, Any] = {}
    if element.attrib:
        result["@attributes"] = dict(element.attrib)
    children = list(element)
    if children:
        for child in children:
            value = xml_to_data(child)
            if child.tag in result:
                if not isinstance(result[child.tag], list):
                    result[child.tag] = [result[child.tag]]
                result[child.tag].append(value)
            else:
                result[child.tag] = value
    text = (element.text or "").strip()
    if text:
        if result:
            result["#text"] = text
        else:
            return text
    return result


def fetch_batch(ids: list[int], token: str, include_versions: bool) -> ET.Element:
    query_args = {
        "id": ",".join(map(str, ids)),
        "type": "boardgame,boardgameexpansion",
        "stats": "1",
    }
    if include_versions:
        query_args["versions"] = "1"
    request = urllib.request.Request(
        f"{BGG_THING_URL}?{urllib.parse.urlencode(query_args)}",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "BoardGameTracker/1.0"},
    )

    for attempt in range(1, 7):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
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


def existing_ids(path: Path) -> set[int]:
    found: set[int] = set()
    if not path.exists():
        return found
    with path.open("r", encoding="utf-8") as file:
        for line in file:
            try:
                record = json.loads(line)
                game_id = int(record["id"])
            except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                continue
            found.add(game_id)
    return found


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch detailed BGG game data into a resumable JSONL file."
    )
    parser.add_argument("--ids", nargs="+", type=int, help="Fetch only these BGG game IDs")
    parser.add_argument("--limit", type=int, help="Fetch only the first N IDs from boardgames_ranks.csv")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output JSONL path")
    parser.add_argument("--throttle-seconds", type=float, default=5.0, help="Delay between API requests (default: 5)")
    parser.add_argument("--include-versions", action="store_true", help="Also request edition/version records")
    parser.add_argument("--no-resume", action="store_true", help="Do not skip IDs already in the output file")
    args = parser.parse_args()

    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1.")
    if args.throttle_seconds < 5:
        parser.error("--throttle-seconds must be at least 5 to respect BGG's guidance.")
    if args.ids and args.limit:
        parser.error("Use either --ids or --limit, not both.")

    secret_config = read_json(ROOT / "config.secret.json")
    token = os.environ.get("BGG_KEY", secret_config.get("BGG_KEY", "")).strip()
    if not token:
        parser.error("Set BGG_KEY in config.secret.json or the environment.")

    ids = read_ids(args)
    if not ids:
        parser.error("No positive BGG game IDs were found.")
    if not args.no_resume:
        already_saved = existing_ids(args.output)
        ids = [game_id for game_id in ids if game_id not in already_saved]
    if not ids:
        print("All selected games are already in the output file.")
        return

    args.output.parent.mkdir(parents=True, exist_ok=True)
    mode = "w" if args.no_resume else "a"
    written = 0
    with args.output.open(mode, encoding="utf-8", newline="\n") as output:
        batches = [ids[index : index + MAX_IDS_PER_REQUEST] for index in range(0, len(ids), MAX_IDS_PER_REQUEST)]
        for batch_index, batch in enumerate(batches):
            if batch_index:
                time.sleep(args.throttle_seconds)
            root = fetch_batch(batch, token, args.include_versions)
            retrieved_at = dt.datetime.now(dt.timezone.utc).isoformat()
            for item in root.findall("item"):
                record = {
                    "id": int(item.get("id", "0")),
                    "type": item.get("type"),
                    "retrieved_at_utc": retrieved_at,
                    "data": xml_to_data(item),
                }
                output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                written += 1
            output.flush()
            print(f"Fetched batch {batch_index + 1}/{len(batches)}; saved {written} game(s).", flush=True)

    print(f"Finished. Saved {written} game record(s) to {args.output}.")


if __name__ == "__main__":
    main()
