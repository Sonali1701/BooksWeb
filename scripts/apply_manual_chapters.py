"""Merge hand-read chapter lists into resource-meta.json.

The books these cover are scans with no text layer: their chapter names exist
only as pixels on a printed contents page, so extract_chapters.py cannot reach
them. The lists in manual-chapters.json were read off those pages and each page
number was checked by rendering it and confirming the chapter opens there.

They are marked `chapterSource: "contents-page"` so extract_chapters.py leaves
them alone — that script only clears entries it wrote itself.

    py scripts/apply_manual_chapters.py            # report
    py scripts/apply_manual_chapters.py --write    # apply
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
META_PATH = ROOT / "resource-meta.json"
MANUAL_PATH = Path(__file__).resolve().parent / "manual-chapters.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    manual = json.loads(MANUAL_PATH.read_text(encoding="utf-8"))

    applied, missing = 0, []
    for book_id, record in manual.items():
        if book_id.startswith("_"):
            continue
        entry = meta["resources"].get(book_id)
        if entry is None:
            missing.append(book_id)
            continue

        chapters = record["chapters"]
        pages = [c["page"] for c in chapters]
        if pages != sorted(pages) or pages[0] < 1:
            raise SystemExit(f"{book_id}: chapter pages are not in ascending order")

        print(f"{book_id}")
        print(f"   {len(chapters)} chapters, offset {record.get('offset')}, "
              f"{record.get('verified', 'unverified')}")
        if args.write:
            entry["chapters"] = [
                {"title": c["title"], "page": c["page"], "unit": c.get("unit", "")}
                for c in chapters
            ]
            entry["chapterSource"] = "contents-page"
            entry.pop("chapterError", None)
        applied += 1

    if missing:
        print("\nnot found in resource-meta.json:", missing)
    if args.write:
        META_PATH.write_text(
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"\nWrote {applied} books into {META_PATH.name}")
    else:
        print(f"\n{applied} books ready — pass --write to apply")


if __name__ == "__main__":
    main()
