"""Split Campbell Biology into one PDF per chapter.

The source is 274 MB, and GitHub refuses any file over 100 MB, so the whole
book cannot be published as a single file. Splitting is not just a workaround
for that limit: a reader who opens chapter 9 then fetches 4 MB instead of
274 MB, which is the same reason ncert-physics-11 is stored this way.

Chapter boundaries come from the catalogue's own map, not from the PDF's
embedded outline -- the outline omits chapters 40 and 41 and numbers the last
chapter 55 twice. Every boundary here was confirmed by reading the running
header ("CHAPTER n <title>") on the pages either side of it.

Usage:  py scripts/split_campbell.py --source "<path to the pdf>" [--write]
"""
import argparse, json, re, sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF is required:  py -m pip install pymupdf")

ROOT = Path(__file__).resolve().parent.parent
BOOK_ID = "campbell-biology-10e"
OUT_DIR = ROOT / "pdfs" / BOOK_ID
MAP = ROOT / "scripts" / "campbell-chapters.json"
GITHUB_FILE_LIMIT = 100 * 1024 * 1024


def build(source: Path, write: bool) -> None:
    spec = json.loads(MAP.read_text(encoding="utf-8"))
    chapters, end = spec["chapters"], spec["end"]

    src = fitz.open(source)
    if src.page_count != spec["pageCount"]:
        sys.exit(f"page count {src.page_count} != expected {spec['pageCount']} -- wrong file?")

    parts = []
    for i, ch in enumerate(chapters):
        first = ch["page"]
        last = chapters[i + 1]["page"] - 1 if i + 1 < len(chapters) else end
        parts.append((f"ch{ch['num']:02d}", first, last, ch["title"], ch.get("unit", "")))
    # The index and glossary are how a textbook is actually used, so the back
    # matter ships as a final section rather than being dropped.
    parts.append(("reference", end + 1, src.page_count,
                  "Appendices, Glossary & Index", "REFERENCE"))

    if write:
        OUT_DIR.mkdir(parents=True, exist_ok=True)

    total = 0
    entries = []
    for name, first, last, title, unit in parts:
        out = OUT_DIR / f"{name}.pdf"
        part = fitz.open()
        part.insert_pdf(src, from_page=first - 1, to_page=last - 1)
        if write:
            part.save(out, garbage=4, deflate=True)
            size = out.stat().st_size
            check = fitz.open(out)
            assert check.page_count == last - first + 1, f"{name}: page count mismatch"
            check.close()
        else:
            size = len(part.tobytes(garbage=4, deflate=True))
        part.close()
        total += size
        if size > GITHUB_FILE_LIMIT:
            sys.exit(f"{name} is {size/1048576:.0f} MB -- over GitHub's 100 MB file limit")
        entries.append({"title": title, "unit": unit,
                        "pdf": f"pdfs/{BOOK_ID}/{name}.pdf",
                        "pages": last - first + 1, "bytes": size})
        print(f"  {name:9} pdf {first:5}-{last:<5} {last-first+1:4} pages  {size/1048576:6.1f} MB  {title[:44]}")

    print(f"\n{len(entries)} files, {total/1048576:.0f} MB total"
          f" (source {source.stat().st_size/1048576:.0f} MB, largest part"
          f" {max(e['bytes'] for e in entries)/1048576:.0f} MB)")

    if write:
        (ROOT / "scripts" / "campbell-parts.json").write_text(
            json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
        print("wrote scripts/campbell-parts.json")
    else:
        print("dry run -- pass --write")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, type=Path)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    if not a.source.exists():
        sys.exit(f"not found: {a.source}")
    build(a.source, a.write)
