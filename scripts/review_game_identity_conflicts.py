"""Flag possible identity conflicts between the BGG game and rank CSVs."""

from __future__ import annotations

import csv
import unicodedata
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
GAMES_CSV = DATA / "games.csv"
RANKS_CSV = DATA / "boardgames_ranks.csv"
OUTPUT_CSV = DATA / "game_identity_conflicts.csv"


def normalize_name(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value).casefold()
    return "".join(
        char for char in decomposed
        if not unicodedata.combining(char) and char.isalnum()
    )


def read_unique_by_id(path: Path, id_field: str) -> dict[str, dict[str, str]]:
    records: dict[str, dict[str, str]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            game_id = (row.get(id_field) or "").strip()
            if not game_id:
                continue
            if game_id in records:
                raise ValueError(f"Duplicate BGG ID {game_id} in {path.name}")
            records[game_id] = row
    return records


def main() -> None:
    games = read_unique_by_id(GAMES_CSV, "BGGId")
    ranks = read_unique_by_id(RANKS_CSV, "id")
    conflicts: list[dict[str, str]] = []

    for game_id in sorted(games.keys() & ranks.keys(), key=int):
        game = games[game_id]
        rank = ranks[game_id]
        games_name = (game.get("Name") or "").strip()
        ranks_name = (rank.get("name") or "").strip()
        games_year = (game.get("YearPublished") or "").strip()
        ranks_year = (rank.get("yearpublished") or "").strip()

        if normalize_name(games_name) != normalize_name(ranks_name):
            conflicts.append({
                "issue_type": "same_id_name_mismatch",
                "game_id": game_id,
                "game_ids": game_id,
                "games_name": games_name,
                "ranks_name": ranks_name,
                "games_year": games_year,
                "ranks_year": ranks_year,
                "normalized_name": normalize_name(games_name),
                "publication_year": "",
            })
        if games_year != ranks_year:
            conflicts.append({
                "issue_type": "same_id_year_mismatch",
                "game_id": game_id,
                "game_ids": game_id,
                "games_name": games_name,
                "ranks_name": ranks_name,
                "games_year": games_year,
                "ranks_year": ranks_year,
                "normalized_name": normalize_name(games_name or ranks_name),
                "publication_year": "",
            })

    # Use the merged view to represent each BGG ID once, preferring the richer
    # games.csv values and filling missing names/years from the ranks source.
    candidates: dict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
    for game_id in sorted(games.keys() | ranks.keys(), key=int):
        game = games.get(game_id, {})
        rank = ranks.get(game_id, {})
        name = (game.get("Name") or rank.get("name") or "").strip()
        year = (game.get("YearPublished") or "").strip()
        if not year or year == "0":
            year = (rank.get("yearpublished") or "").strip()
        if not name or not year or year == "0":
            continue
        candidates[(normalize_name(name), year)].append((game_id, name))

    for (normalized_name, year), records in sorted(candidates.items()):
        ids = sorted({record[0] for record in records}, key=int)
        if len(ids) < 2:
            continue
        name_by_id = {game_id: name for game_id, name in records}
        conflicts.append({
            "issue_type": "different_ids_same_name_year",
            "game_id": "",
            "game_ids": ";".join(ids),
            "games_name": " | ".join(name_by_id[game_id] for game_id in ids),
            "ranks_name": "",
            "games_year": "",
            "ranks_year": "",
            "normalized_name": normalized_name,
            "publication_year": year,
        })

    fields = [
        "issue_type", "game_id", "game_ids", "games_name", "ranks_name",
        "games_year", "ranks_year", "normalized_name", "publication_year",
    ]
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerows(conflicts)

    print(f"Same-ID name/year mismatch flags: {sum(row['issue_type'].startswith('same_id_') for row in conflicts)}")
    print(f"Different-ID same-name/year groups: {sum(row['issue_type'] == 'different_ids_same_name_year' for row in conflicts)}")
    print(f"Wrote review flags to: {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
