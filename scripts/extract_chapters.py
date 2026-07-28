"""Find chapter divisions in the catalog's public PDFs.

Two sources are tried, both deterministic — nothing here guesses a page number:

1. **Embedded bookmarks.** Exact by construction, and present even in scanned
   books. Titles are only trusted when they read like chapter names; scanners
   often write the batch id ("0607_028") into the outline instead.

2. **The printed table of contents.** Needs a text layer. A printed TOC gives
   *printed* page numbers, which are not PDF page indices — front matter shifts
   them. The offset is measured from the page folios themselves and applied
   only when enough pages agree, so a book with an unreadable numbering scheme
   yields nothing rather than a wrong jump.

A wrong jump is worse than no chapter list: it looks like a working feature.
Anything uncertain is therefore dropped and reported as needing another method.

Usage:
    py scripts/extract_chapters.py                # report only, writes nothing
    py scripts/extract_chapters.py --write        # update resource-meta.json
    py scripts/extract_chapters.py --limit 5      # try the 5 smallest first
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import tempfile
import urllib.parse
import urllib.request
import warnings
from collections import Counter
from pathlib import Path

import fitz

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parents[1]
META_PATH = ROOT / "resource-meta.json"
CONFIG_PATH = ROOT / "config.js"
BOOKS_PATH = ROOT / "books.json"
REFERER = "https://sonali1701.github.io/"

MIN_CHAPTERS = 3          # fewer than this is not a table of contents
# A printed contents page is held to a higher bar than an outline: a handful of
# lines scraped off a page is far more likely to be a stray table than a book's
# chapter list, and the syllabus outline it would displace is more complete.
MIN_TOC_ENTRIES = 6
MAX_CHAPTERS = 150
MIN_FOLIO_AGREEMENT = 8   # pages that must agree before an offset is trusted

FRONT_MATTER = {
    "cover", "title", "title page", "copyright", "preface", "contents",
    "acknowledgments", "acknowledgements", "dedication", "about the author",
    "foreword", "index", "table of contents", "colophon",
}


# --------------------------------------------------------------------------
# download


def api_key() -> str:
    match = re.search(
        r"googleApiKey\s*:\s*[\"']([^\"']*)[\"']",
        CONFIG_PATH.read_text(encoding="utf-8"),
    )
    return match.group(1) if match else ""


def download(file_id: str, destination: Path, key: str) -> None:
    url = (
        "https://www.googleapis.com/drive/v3/files/"
        f"{urllib.parse.quote(file_id)}?alt=media&supportsAllDrives=true&key={key}"
    )
    request = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0", "Referer": REFERER}
    )
    with urllib.request.urlopen(request, timeout=600) as response, destination.open("wb") as handle:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            handle.write(chunk)


# --------------------------------------------------------------------------
# tier 1: embedded bookmarks


def looks_like_scan_artifact(title: str) -> bool:
    """Scanner output such as "0607_028", "Page 14", "img003" — not a title."""
    value = title.strip().lower()
    # Duplicate markers a scanner or download appends: "0378_001 (1)".
    value = re.sub(r"\s*[\(\[]\d+[\)\]]\s*$", "", value).strip()
    return bool(
        re.fullmatch(r"(?:page\s*)?\d{1,5}", value)
        or re.fullmatch(r"\d{2,}[_-]\d{2,}", value)
        or re.fullmatch(r"\d+[-–]\d+", value)
        or re.fullmatch(r"(?:img|scan|doc|page|pg)[\s_-]*\d+", value)
        or value in {"0", "cover", "title", "untitled"}
    )


def bookmark_chapters(doc) -> tuple[list[dict], bool]:
    """Chapters from the outline, plus whether the titles were meaningful."""
    raw = doc.get_toc(simple=True)
    if not raw:
        return [], False

    entries, seen_pages = [], set()
    for level, title, page in raw:
        if level != 1:
            continue
        clean = re.sub(r"\s+", " ", str(title)).strip()
        page = int(page)
        if not clean or page < 1 or page > doc.page_count or page in seen_pages:
            continue
        seen_pages.add(page)
        entries.append({"title": clean, "page": page})

    if len(entries) < MIN_CHAPTERS:
        return [], False

    real = [e for e in entries if not looks_like_scan_artifact(e["title"])]
    named = len(real) >= max(MIN_CHAPTERS, len(entries) // 2)
    if not named:
        # Page divisions with no usable names. Still navigation, but it must not
        # masquerade as a contents list.
        return [
            {"title": f"Section {i}", "page": e["page"], "unit": ""}
            for i, e in enumerate(entries, 1)
        ], False

    # Drop front matter that precedes the first numbered chapter.
    numbered = [e for e in real if re.match(r"^(?:chapter\s*)?\d+\b", e["title"], re.I)]
    first = min((e["page"] for e in numbered), default=0)
    kept = [
        e for e in real
        if not (e["page"] < first and e["title"].strip().lower() in FRONT_MATTER)
    ]
    kept.sort(key=lambda e: e["page"])
    return [{"title": e["title"], "page": e["page"], "unit": ""} for e in kept[:MAX_CHAPTERS]], True


# --------------------------------------------------------------------------
# tier 2: the printed table of contents


TOC_LINE = re.compile(r"^\s*(?P<title>\S.{2,80}?)[\s.…·]{2,}(?P<page>\d{1,4})\s*$")


def looks_like_title(text: str) -> bool:
    """Reject the debris a contents page yields alongside real entries.

    Page ranges ("247 -262"), folio markers ("(ix)"), column headers ("Marks"),
    and OCR noise ("13u", "?96") all match the shape of a contents line. They
    also survive naive verification, because a two-character fragment appears
    on almost any page — so they have to be excluded on their own merits.
    """
    letters = sum(character.isalpha() for character in text)
    if letters < 4 or letters / max(1, len(text)) < 0.55:
        return False
    if re.fullmatch(r"[\d\s\-–—,.()\[\]ivxlcIVXLC]+", text):
        return False
    words = [w for w in text.split() if len(w) >= 3 and any(c.isalpha() for c in w)]
    return bool(words) and (len(words) >= 2 or letters >= 7)


def accept(title: str, page: int) -> dict | None:
    title = re.sub(r"\s+", " ", title).strip(" .·…\t")
    if len(title) < 3 or title.lower() in FRONT_MATTER or page < 1:
        return None
    if not looks_like_title(title):
        return None
    return {"title": title, "printed": page}


def toc_lines(text: str) -> list[dict]:
    """Contents entries in either common layout.

    A single line ("Gravitation .... 203"), and the two-line form that PDF text
    extraction produces when the title and its page number sit in separate
    columns — the title on one line, a bare number on the next.
    """
    found = []
    lines = [ln.rstrip() for ln in text.splitlines()]
    previous = ""
    for line in lines:
        stripped = line.strip()
        match = TOC_LINE.match(line)
        if match:
            entry = accept(match.group("title"), int(match.group("page")))
            if entry:
                found.append(entry)
            previous = ""
            continue
        if re.fullmatch(r"\d{1,4}", stripped) and previous:
            entry = accept(previous, int(stripped))
            if entry:
                found.append(entry)
            previous = ""
            continue
        if stripped:
            previous = stripped
    return found


def find_toc_entries(doc) -> list[dict]:
    """Title/printed-page pairs from a printed contents page.

    The page is found by how it reads, not by whether it says "Contents" —
    plenty of textbooks head the list "Chapter" or nothing at all.
    """
    best: list[dict] = []
    for index in range(min(30, doc.page_count)):
        text = doc[index].get_text("text") or ""
        found = toc_lines(text)
        # A contents page may run on; gather following pages too.
        if len(found) >= MIN_CHAPTERS:
            for follow in range(index + 1, min(index + 4, doc.page_count)):
                extra = toc_lines(doc[follow].get_text("text") or "")
                if len(extra) < 2:
                    break
                found.extend(extra)
        if len(found) > len(best):
            best = found
    return best


def heading_at(doc, page_index: int) -> str:
    """The most prominent line near the top of a page — usually its title.

    Used to name bookmark divisions in books whose outline holds scanner ids
    rather than chapter names. Only the page's own words are used, so nothing
    is invented.
    """
    try:
        data = doc[page_index - 1].get_text("dict")
    except Exception:
        return ""
    height = data.get("height") or 1
    best_size, best_text = 0.0, ""
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            top = spans[0].get("bbox", [0, 0, 0, 0])[1]
            if top > height * 0.45:       # headings sit high on the page
                continue
            size = max(s.get("size", 0) for s in spans)
            text = re.sub(r"\s+", " ", "".join(s.get("text", "") for s in spans)).strip()
            if len(text) < 4 or len(text) > 90 or text.isdigit():
                continue
            if size > best_size:
                best_size, best_text = size, text
    return best_text.strip(" .:-—")


def measure_page_offset(doc) -> int | None:
    """How far the printed numbering is shifted from the PDF index.

    Read the folio printed on each page and compare it with that page's
    position. Agreement across many pages is what makes the shift trustworthy;
    without it the printed numbers cannot be used at all.
    """
    votes = Counter()
    for index in range(min(doc.page_count, 260)):
        text = doc[index].get_text("text") or ""
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if not lines:
            continue
        for candidate in (lines[0], lines[-1]):
            match = re.fullmatch(r"(\d{1,4})", candidate)
            if not match:
                continue
            folio = int(match.group(1))
            if 1 <= folio <= doc.page_count:
                votes[(index + 1) - folio] += 1
    if not votes:
        return None
    offset, count = votes.most_common(1)[0]
    if count < MIN_FOLIO_AGREEMENT:
        return None
    # A single dominant shift is expected; competing shifts mean re-numbering.
    total = sum(votes.values())
    if count / total < 0.5:
        return None
    return offset


def drop_subsections(entries: list[dict]) -> list[dict]:
    """Keep chapters, not the numbered sub-headings beneath them.

    A contents page lists "23 Heat and Temperature" alongside "23.1 Hot and
    Cold Bodies"; both are real, but only the first is a chapter, and mixing
    them buries the structure a reader is looking for.
    """
    top = [e for e in entries if not re.match(r"^\d+\s*[.)]\s*\d+", e["title"])]
    return top if len(top) >= MIN_CHAPTERS else entries


def prune(chapters: list[dict]) -> list[dict]:
    """One entry per page, and nothing that repeats.

    Running heads such as "Only One Choice is Correct" appear on page after
    page. A title that recurs is furniture, not a chapter name.
    """
    by_page: dict[int, dict] = {}
    for chapter in chapters:
        by_page.setdefault(chapter["page"], chapter)
    items = [by_page[page] for page in sorted(by_page)]

    counts = Counter(item["title"].strip().lower() for item in items)
    unique = [item for item in items if counts[item["title"].strip().lower()] == 1]
    return unique if len(unique) >= MIN_CHAPTERS else items


def verify_chapters(doc, chapters: list[dict], sample: int = 10) -> float:
    """Fraction of sampled chapters whose title really appears at its page.

    The whole risk of a derived page number is that it points somewhere else,
    which reads as a working feature while sending people to the wrong page.
    Checking the destination is what separates a usable jump from a plausible
    one, so a list that cannot be confirmed is discarded.
    """
    if not chapters:
        return 0.0
    step = max(1, len(chapters) // sample)
    picks = chapters[::step][:sample]
    hits = 0
    for chapter in picks:
        page = chapter["page"]
        window = ""
        for index in range(max(1, page - 1), min(doc.page_count, page + 1) + 1):
            window += " " + (doc[index - 1].get_text("text") or "")
        window = re.sub(r"[^a-z0-9 ]+", " ", window.lower())
        window = re.sub(r"\s+", " ", window)
        words = [w for w in re.sub(r"[^a-z0-9 ]+", " ", chapter["title"].lower()).split()
                 if len(w) > 3][:6]
        if not words:
            continue  # nothing distinctive to match on: unverifiable, so not a hit
        found = sum(1 for w in words if w in window)
        if found >= max(1, len(words) // 2):
            hits += 1
    return hits / len(picks)


def printed_toc_chapters(doc) -> tuple[list[dict], str]:
    entries = drop_subsections(find_toc_entries(doc))
    if len(entries) < MIN_CHAPTERS:
        return [], "no printed contents page found"

    offset = measure_page_offset(doc)
    if offset is None:
        return [], f"found {len(entries)} contents lines but page numbering could not be calibrated"

    chapters, last = [], 0
    for entry in entries:
        page = entry["printed"] + offset
        if page < 1 or page > doc.page_count or page < last:
            continue  # out of order or out of bounds: not trustworthy
        last = page
        chapters.append({"title": entry["title"], "page": page, "unit": ""})

    chapters = prune(chapters)
    if len(chapters) < MIN_TOC_ENTRIES:
        return [], f"only {len(chapters)} usable contents lines"

    # A book's chapters run through the book. A cluster covering a fraction of
    # it is a stray table — an exam archive, a marks scheme, an appendix index
    # — not the contents, and shipping it would hide the fuller syllabus
    # outline behind a handful of misleading jumps.
    span = chapters[-1]["page"] - chapters[0]["page"]
    if span < doc.page_count * 0.3:
        return [], (f"contents lines cover only {span} of {doc.page_count} pages "
                    "— not a whole-book table")
    return chapters[:MAX_CHAPTERS], f"printed contents, page offset {offset:+d}"


# --------------------------------------------------------------------------


def process(path: Path) -> dict:
    doc = fitz.open(path)
    try:
        pages = doc.page_count
        chapters, named = bookmark_chapters(doc)
        if chapters and named:
            return {"chapters": chapters, "source": "bookmarks",
                    "note": f"{len(chapters)} named bookmarks", "pages": pages}

        printed, note = printed_toc_chapters(doc)
        if printed:
            score = verify_chapters(doc, printed)
            if score >= 0.6:
                return {"chapters": printed, "source": "printed-toc",
                        "note": f"{note}, {score:.0%} of sampled pages confirmed",
                        "pages": pages}
            note = f"contents parsed but only {score:.0%} of pages matched their title"

        if chapters:
            # The outline gives exact page breaks but useless names. Read each
            # division's own heading to recover the titles.
            named = []
            for chapter in chapters:
                heading = heading_at(doc, chapter["page"])
                if heading and not looks_like_scan_artifact(heading):
                    named.append({**chapter, "title": heading})
            named = prune(named)
            if len(named) >= MIN_CHAPTERS:
                return {"chapters": named[:MAX_CHAPTERS], "source": "page-headings",
                        "note": f"{len(named)} of {len(chapters)} divisions named from page headings",
                        "pages": pages}
            return {"chapters": chapters, "source": "page-divisions",
                    "note": f"{len(chapters)} unnamed bookmark divisions; {note}",
                    "pages": pages}

        text = sum(len(doc[i].get_text("text") or "") for i in range(min(20, pages)))
        scanned = text / max(1, min(20, pages)) < 120
        return {"chapters": [], "source": "none", "pages": pages,
                "note": ("scanned, no text layer — needs vision" if scanned else note)}
    finally:
        doc.close()


def tidy_stored_titles(meta: dict) -> int:
    """Relabel scanner debris already sitting in the metadata.

    Titles like "0378_001 (1)" predate this script and cannot be improved by
    re-reading the file — the name simply is not in it. Numbering them by
    position at least stops the reader presenting a scanner's filenames as
    chapter names. No download is needed, so old entries can be cleaned up
    without re-fetching gigabytes.
    """
    changed = 0
    for entry in meta["resources"].values():
        chapters = entry.get("chapters") or []
        if not chapters:
            continue
        for position, chapter in enumerate(chapters, 1):
            title = str(chapter.get("title") or "")
            if title and looks_like_scan_artifact(title):
                chapter["title"] = f"Section {position}"
                changed += 1
    return changed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="update resource-meta.json")
    parser.add_argument("--tidy", action="store_true",
                        help="relabel scanner debris in stored chapters, without downloading")
    parser.add_argument("--limit", type=int, default=0, help="process only the N smallest")
    parser.add_argument("--show", type=int, default=0,
                        help="print the first N extracted chapters of each book")
    parser.add_argument("--only", default="",
                        help="process only books whose id or filename contains this")
    args = parser.parse_args()

    meta = json.loads(META_PATH.read_text(encoding="utf-8"))

    if args.tidy:
        changed = tidy_stored_titles(meta)
        if args.write:
            META_PATH.write_text(
                json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )
        print(f"Relabelled {changed} scanner-artifact titles"
              f"{'' if args.write else ' (dry run — pass --write to save)'}")
        return

    key = api_key()
    if not key:
        raise SystemExit("No googleApiKey in config.js — cannot download the PDFs.")

    books = {b["id"]: b for b in json.loads(BOOKS_PATH.read_text(encoding="utf-8"))}

    targets = sorted(
        (
            (entry.get("size", 0), book_id, entry["fileId"],
             entry.get("filename") or books.get(book_id, {}).get("title", book_id))
            for book_id, entry in meta["resources"].items()
            if entry.get("kind") == "drive-file"
            and entry.get("access") == "public"
            and entry.get("fileId")
        )
    )
    if args.only:
        needle = args.only.lower()
        targets = [t for t in targets if needle in t[1].lower() or needle in t[3].lower()]
    if args.limit:
        targets = targets[: args.limit]

    print(f"Processing {len(targets)} public PDFs\n")
    results = []
    with tempfile.TemporaryDirectory(prefix="open-books-toc-") as tmp:
        for position, (size, book_id, file_id, name) in enumerate(targets, 1):
            destination = Path(tmp) / "book.pdf"
            mb = round(size / 1048576)
            print(f"[{position}/{len(targets)}] {mb:>4} MB  {name[:44]}", flush=True)
            try:
                download(file_id, destination, key)
                outcome = process(destination)
            except Exception as exc:
                outcome = {"chapters": [], "source": "error", "pages": 0,
                           "note": f"{type(exc).__name__}: {str(exc)[:90]}"}
            finally:
                destination.unlink(missing_ok=True)

            outcome.update({"id": book_id, "name": name, "mb": mb})
            results.append(outcome)
            print(f"          -> {outcome['source']}: {len(outcome['chapters'])} chapters"
                  f"  ({outcome['note']})", flush=True)
            for chapter in outcome["chapters"][: args.show]:
                print(f"             p{chapter['page']:<5} {chapter['title'][:64]}")

            if args.write:
                entry = meta["resources"][book_id]
                if outcome["chapters"]:
                    entry["chapters"] = outcome["chapters"]
                    entry["chapterSource"] = outcome["source"]
                    entry.pop("chapterError", None)
                elif entry.get("chapterSource"):
                    # This run rejected what an earlier run of this script
                    # accepted, so the stored list is now known to be bad and
                    # must go. Chapters from elsewhere are left untouched:
                    # only entries carrying our own marker are ours to clear.
                    entry.pop("chapters", None)
                    entry.pop("chapterSource", None)
                    print("          (cleared previously extracted chapters)", flush=True)

    if args.write:
        META_PATH.write_text(
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"\nUpdated {META_PATH.name}")

    print("\n================ SUMMARY ================")
    by_source = Counter(r["source"] for r in results)
    for source, count in by_source.most_common():
        print(f"  {source:16} {count:3} books")
    got = [r for r in results if r["chapters"]]
    named = [r for r in results if r["source"] in ("bookmarks", "printed-toc", "page-headings")]
    print(f"\n  books with any chapters   : {len(got)}/{len(results)}")
    print(f"  with real chapter titles  : {len(named)}/{len(results)}")
    if got:
        print(f"  median chapters per book  : {statistics.median(len(r['chapters']) for r in got):.0f}")

    remaining = [r for r in results if r["source"] in ("none", "page-divisions", "error")]
    if remaining:
        print(f"\n  still needing another method ({len(remaining)}):")
        for r in remaining:
            print(f"    {r['mb']:>4} MB  {r['name'][:40]:42} {r['note'][:60]}")


if __name__ == "__main__":
    main()
