"""Render a book's chapter-division pages onto labelled contact sheets.

The books this serves are scans: their outline records exactly where each
division starts, but the names are the scanner's batch ids. The page numbers
are therefore already correct and are never re-derived here — the only thing
missing is what each division is called, which is printed on the page itself.

Each sheet tiles the top of several division pages, captioned with the division
number, so the titles can be read off and transcribed back.

    py scripts/chapter_sheets.py --book es-250 --out <dir>
    py scripts/chapter_sheets.py --book es-250 --pages 12,44,90 --full
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.parse
import urllib.request
import warnings
from pathlib import Path

import fitz

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parents[1]
META_PATH = ROOT / "resource-meta.json"
CONFIG_PATH = ROOT / "config.js"
REFERER = "https://sonali1701.github.io/"

PER_SHEET = 8          # tiles per contact sheet
COLUMNS = 2
TILE_WIDTH = 660
TILE_HEIGHT = 430
LABEL_HEIGHT = 26
TOP_FRACTION = 0.34    # headings live at the top of a page


def api_key() -> str:
    match = re.search(r"googleApiKey\s*:\s*[\"']([^\"']*)[\"']",
                      CONFIG_PATH.read_text(encoding="utf-8"))
    return match.group(1) if match else ""


def cache_pdf(file_id: str, destination: Path) -> Path:
    """Keep the download beside the sheets; these books are large."""
    if destination.exists() and destination.stat().st_size > 1024:
        return destination
    url = ("https://www.googleapis.com/drive/v3/files/"
           f"{urllib.parse.quote(file_id)}?alt=media&supportsAllDrives=true&key={api_key()}")
    request = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0", "Referer": REFERER})
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(request, timeout=600) as response, destination.open("wb") as fh:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    return destination


def build_sheets(doc, entries, out_dir: Path, stem: str, full: bool,
                 per_sheet: int = PER_SHEET, dpi: int = 96) -> list[Path]:
    """entries: [(label, page_number)] — page numbers are 1-based."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    tile_h = TILE_HEIGHT * (2.4 if full else 1.0)

    for index in range(0, len(entries), per_sheet):
        batch = entries[index:index + per_sheet]
        sheet_rows = (len(batch) + COLUMNS - 1) // COLUMNS
        canvas = fitz.open()
        page = canvas.new_page(
            width=COLUMNS * TILE_WIDTH,
            height=sheet_rows * (tile_h + LABEL_HEIGHT),
        )
        for position, (label, number) in enumerate(batch):
            column, row = position % COLUMNS, position // COLUMNS
            x = column * TILE_WIDTH
            y = row * (tile_h + LABEL_HEIGHT)

            source = doc[number - 1]
            clip = None if full else fitz.Rect(
                0, 0, source.rect.width, source.rect.height * TOP_FRACTION)
            pixmap = source.get_pixmap(clip=clip, dpi=max(130, dpi * 2))

            page.insert_text((x + 8, y + 18), f"{label}  (pdf page {number})",
                             fontsize=13, color=(0.7, 0, 0))
            page.insert_image(
                fitz.Rect(x + 4, y + LABEL_HEIGHT, x + TILE_WIDTH - 4, y + LABEL_HEIGHT + tile_h),
                pixmap=pixmap, keep_proportion=True)

        destination = out_dir / f"{stem}-{index // per_sheet + 1:02d}.png"
        page.get_pixmap(dpi=dpi).save(destination)
        written.append(destination)
        canvas.close()
    return written


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--book", required=True, help="catalog id, or a unique prefix of one")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--pages", default="",
                        help="explicit 1-based pdf pages: '3,9' or ranges '1-24'")
    parser.add_argument("--per-sheet", type=int, default=0, help="tiles per sheet")
    parser.add_argument("--dpi", type=int, default=0, help="render resolution for the sheet")
    parser.add_argument("--full", action="store_true", help="render whole pages, not just the top")
    args = parser.parse_args()

    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    matches = [k for k in meta["resources"] if k.startswith(args.book)]
    if len(matches) != 1:
        raise SystemExit(f"--book matched {len(matches)} entries: {matches[:5]}")
    entry = meta["resources"][matches[0]]

    cache = args.out / "pdf" / f"{entry['fileId']}.pdf"
    print(f"{matches[0]}  ({entry.get('filename', '')})")
    print("downloading…" if not cache.exists() else "using cached pdf")
    cache_pdf(entry["fileId"], cache)

    doc = fitz.open(cache)
    if args.pages:
        wanted = []
        for part in args.pages.split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                start, end = (int(v) for v in part.split("-", 1))
                wanted.extend(range(start, end + 1))
            else:
                wanted.append(int(part))
        wanted = [p for p in wanted if 1 <= p <= doc.page_count]
        entries = [(f"page {p}", p) for p in wanted]
        stem = f"{matches[0][:26]}-pages"
    else:
        chapters = entry.get("chapters") or []
        entries = [(f"#{i}", int(c["page"])) for i, c in enumerate(chapters, 1)]
        stem = matches[0][:26]

    sheets = build_sheets(doc, entries, args.out, stem, args.full,
                          args.per_sheet or PER_SHEET, args.dpi or 96)
    print(f"pages: {doc.page_count}   divisions: {len(entries)}   sheets: {len(sheets)}")
    for sheet in sheets:
        print("  ", sheet)
    doc.close()


if __name__ == "__main__":
    main()
