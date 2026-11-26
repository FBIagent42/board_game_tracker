"""Find exact and punctuation-normalized duplicate titles in the merged catalog."""

from __future__ import annotations

import argparse
import csv
import unicodedata
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
INPUT_CSV = ROOT / "data" / "games_merged.csv"
OUTPUT_CSV = ROOT / "data" / "duplicate_game_names.csv"


def normalize(title: str) -> str:
    decomposed = unicodedata.normalize("NFKD", title).casefold()
    return "".join(char for char in decomposed if not unicodedata.combining(char) and char.isalnum())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=INPUT_CSV)
    parser.add_argument("--output", type=Path, default=OUTPUT_CSV)
    args = parser.parse_args()

    normalized_groups: dict[str, list[dict[str, str]]] = defaultdict(list)
    exact_groups: dict[str, list[dict[str, str]]] = defaultdict(list)
    row_count = 0
    with args.input.open("r", encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            row_count += 1
            title = (row.get("name") or "").strip()
            if not title:
                continue
            exact_groups[title.casefold()].append(row)
            normalized_groups[normalize(title)].append(row)

    exact_duplicates = {key: rows for key, rows in exact_groups.items() if len(rows) > 1}
    normalized_duplicates = {
        key: rows for key, rows in normalized_groups.items() if len(rows) > 1
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8-sig", newline="") as output:
        fields = [
            "normalized_title", "match_type", "group_size", "game_id", "name",
            "year_published", "is_expansion",
        ]
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        for key, group in sorted(normalized_duplicates.items()):
            title_variants = {row["name"].strip().casefold() for row in group}
            match_type = "same title" if len(title_variants) == 1 else "punctuation/spacing/accent variant"
            for row in sorted(group, key=lambda item: (item["name"].casefold(), int(item["game_id"]))):
                writer.writerow(
                    {
                        "normalized_title": key,
                        "match_type": match_type,
                        "group_size": len(group),
                        "game_id": row["game_id"],
                        "name": row["name"],
                        "year_published": row.get("year_published", ""),
                        "is_expansion": row.get("is_expansion", ""),
                    }
                )

    print(f"Catalog rows scanned: {row_count}")
    print(f"Exact title groups (case-insensitive): {len(exact_duplicates)}")
    print(f"Rows in exact title groups: {sum(map(len, exact_duplicates.values()))}")
    print(f"Normalized title groups: {len(normalized_duplicates)}")
    print(f"Rows in normalized duplicate groups: {sum(map(len, normalized_duplicates.values()))}")
    print(f"Wrote duplicate details to: {args.output}")
    print("Largest exact-title groups:")
    for group in sorted(exact_duplicates.values(), key=lambda rows: (-len(rows), rows[0]["name"].casefold()))[:15]:
        entries = "; ".join(f'{row["game_id"]} — {row["name"]}' for row in group)
        print(f"{len(group)} entries: {entries}")


if __name__ == "__main__":
    main()
