"""Audit catalog links and generate static metadata for the web app.

The script checks links as an anonymous visitor, lists files in public Drive
folders, and records public PDF download metadata. It does not download book
content unless --extract-chapters is supplied.
"""

from __future__ import annotations

import argparse
import json
import re
import tempfile
import time
import warnings
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

import fitz
import gdown
import requests


warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parents[1]
BOOKS_PATH = ROOT / "books.json"
DEFAULT_OUTPUT = ROOT / "resource-meta.json"
DRIVE_FILE_RE = re.compile(r"drive\.google\.com/file/d/([^/?#]+)")
DRIVE_FOLDER_RE = re.compile(
    r"drive\.google\.com/(?:drive/)?folders/([^/?#]+)"
)
DENIED_MARKERS = ("you need access", "request access", "access denied")
MISSING_MARKERS = (
    "file does not exist",
    "file was deleted",
    "folder does not exist",
)
USER_AGENT = "Mozilla/5.0 (compatible; OpenBooksResourceSync/1.0)"


def request_with_retries(url: str, *, stream: bool = False):
    last_error = None
    for attempt in range(3):
        try:
            response = requests.get(
                url,
                timeout=(8, 30),
                allow_redirects=True,
                stream=stream,
                headers={"User-Agent": USER_AGENT},
            )
            if response.status_code == 429 or response.status_code >= 500:
                last_error = f"HTTP {response.status_code}"
                response.close()
                time.sleep(1.5 * (attempt + 1))
                continue
            return response, None
        except requests.RequestException as exc:
            last_error = f"{type(exc).__name__}: {str(exc)[:160]}"
            time.sleep(1.5 * (attempt + 1))
    return None, last_error or "Request failed"


def classify_page(response) -> str:
    if response is None:
        return "error"
    text = response.text[:150000].lower()
    final_url = response.url.lower()
    if (
        response.status_code == 200
        and "accounts.google.com" not in final_url
        and not any(marker in text for marker in DENIED_MARKERS)
        and not any(marker in text for marker in MISSING_MARKERS)
    ):
        return "public"
    if (
        response.status_code in (401, 403)
        or "accounts.google.com" in final_url
        or any(marker in text for marker in DENIED_MARKERS)
    ):
        return "restricted"
    if response.status_code in (404, 410) or any(
        marker in text for marker in MISSING_MARKERS
    ):
        return "missing"
    return "unknown"


def audit_drive_file(file_id: str) -> dict:
    preview_url = f"https://drive.google.com/file/d/{file_id}/preview"
    response, error = request_with_retries(preview_url)
    access = classify_page(response)
    status = response.status_code if response is not None else None
    if response is not None:
        response.close()

    result = {
        "kind": "drive-file",
        "access": access,
        "fileId": file_id,
        "httpStatus": status,
    }
    if error:
        result["error"] = error
    if access == "public":
        result.update(probe_public_download(file_id))
    return result


def filename_from_disposition(value: str | None) -> str:
    if not value:
        return ""
    utf_match = re.search(r"filename\*=UTF-8''([^;]+)", value, re.I)
    if utf_match:
        return unquote(utf_match.group(1)).strip('"')
    plain_match = re.search(r'filename="([^"]+)"', value, re.I)
    if plain_match:
        return plain_match.group(1)
    return ""


def probe_public_download(file_id: str) -> dict:
    url = (
        "https://drive.usercontent.google.com/download"
        f"?id={file_id}&export=download&authuser=0&confirm=t"
    )
    response, error = request_with_retries(url, stream=True)
    if response is None:
        return {"downloadError": error}

    metadata = {
        "downloadUrl": url,
        "contentType": response.headers.get("content-type", ""),
        "filename": filename_from_disposition(
            response.headers.get("content-disposition")
        ),
    }
    content_length = response.headers.get("content-length")
    if content_length and content_length.isdigit():
        metadata["size"] = int(content_length)
    response.close()
    return metadata


def audit_drive_folder(folder_id: str) -> dict:
    url = f"https://drive.google.com/drive/folders/{folder_id}"
    response, error = request_with_retries(url)
    access = classify_page(response)
    status = response.status_code if response is not None else None
    if response is not None:
        response.close()

    result = {
        "kind": "drive-folder",
        "access": access,
        "folderId": folder_id,
        "httpStatus": status,
    }
    if error:
        result["error"] = error
    if access == "public":
        result["folderItems"] = list_public_folder(folder_id)
    return result


def list_public_folder(folder_id: str) -> list[dict]:
    try:
        items = gdown.download_folder(
            id=folder_id,
            output=None,
            quiet=True,
            use_cookies=False,
            remaining_ok=True,
            skip_download=True,
        )
    except Exception as exc:  # gdown uses several custom exception types
        return [
            {
                "title": "Folder listing unavailable",
                "kind": "notice",
                "error": f"{type(exc).__name__}: {str(exc)[:160]}",
            }
        ]

    output = []
    for item in items or []:
        display_path = str(getattr(item, "path", "") or "").replace("\\", "/")
        file_id = str(getattr(item, "id", "") or "")
        if not file_id:
            continue
        suffix = Path(display_path).suffix.lower()
        output.append(
            {
                "title": Path(display_path).name or display_path or "Drive file",
                "path": display_path,
                "fileId": file_id,
                "kind": "pdf" if suffix == ".pdf" else "file",
                "url": f"https://drive.google.com/file/d/{file_id}/view",
                "previewUrl": (
                    f"https://drive.google.com/file/d/{file_id}/preview"
                    if suffix == ".pdf"
                    else ""
                ),
            }
        )
    return output


def audit_external(url: str) -> dict:
    response, error = request_with_retries(url)
    access = classify_page(response)
    status = response.status_code if response is not None else None
    final_url = response.url if response is not None else ""
    if response is not None:
        response.close()
    result = {
        "kind": "external",
        "access": access,
        "httpStatus": status,
        "finalUrl": final_url,
    }
    if error:
        result["error"] = error
    return result


def extract_outline(path: Path) -> list[dict]:
    document = fitz.open(path)
    raw_toc = document.get_toc(simple=True)
    document.close()
    if not raw_toc:
        return []

    candidates = []
    seen_pages = set()
    for level, title, page in raw_toc:
        clean_title = re.sub(r"\s+", " ", str(title)).strip()
        page_number = int(page)
        if not clean_title or page_number < 1 or page_number in seen_pages:
            continue
        if level <= 2:
            candidates.append(
                {
                    "title": clean_title,
                    "page": page_number,
                    "unit": "" if level == 1 else "Sections",
                }
            )
            seen_pages.add(page_number)

    if len(candidates) > 120:
        candidates = [item for item in candidates if not item["unit"]]
    return candidates[:120]


def normalise_chapters(metadata: dict):
    chapters = metadata.get("chapters") or []
    if not chapters:
        return

    filename_stem = Path(metadata.get("filename") or "").stem.lower()
    ordered = sorted(chapters, key=lambda item: int(item.get("page") or 0))
    has_named_chapters = any(
        re.match(
            r"^(?:chapter\s*)?\d+\b",
            str(item.get("title") or "").strip(),
            re.I,
        )
        for item in ordered
    )
    first_named_page = min(
        (
            int(item.get("page") or 0)
            for item in ordered
            if re.match(
                r"^(?:chapter\s*)?\d+\b",
                str(item.get("title") or "").strip(),
                re.I,
            )
        ),
        default=0,
    )
    front_matter = {
        "cover",
        "title",
        "title page",
        "copyright",
        "preface",
        "acknowledgments",
        "acknowledgements",
        "contents",
    }
    cleaned = []
    seen_pages = set()
    for index, chapter in enumerate(ordered, start=1):
        page = int(chapter.get("page") or 0)
        if page < 1 or page in seen_pages:
            continue
        seen_pages.add(page)
        title = re.sub(r"\s+", " ", str(chapter.get("title") or "")).strip()
        title_lower = title.lower()
        if has_named_chapters and page < first_named_page and (
            title_lower in front_matter
            or re.fullmatch(r"section\s+\d+", title_lower)
        ):
            continue
        part_match = re.search(r"\((\d+)\)\s*$", title)
        looks_scanned = bool(
            re.fullmatch(r"(?:page\s*)?\d+", title_lower)
            or re.fullmatch(r"\d+[-–]\d+", title_lower)
            or re.fullmatch(r"\d{3,}[_-]\d+", title_lower)
            or title_lower in {"0", "cover", "title"}
        )
        repeats_filename = bool(
            len(title_lower) > 24
            and (
                title_lower in filename_stem
                or filename_stem in title_lower
            )
        )
        if part_match and repeats_filename:
            title = f"Part {part_match.group(1)}"
        elif looks_scanned or repeats_filename:
            title = f"Section {len(cleaned) + 1}"

        cleaned.append(
            {
                "title": title or f"Section {len(cleaned) + 1}",
                "page": page,
                "unit": str(chapter.get("unit") or ""),
            }
        )
    metadata["chapters"] = cleaned


def download_and_extract(file_id: str, metadata: dict, target_dir: Path):
    filename = metadata.get("filename") or f"{file_id}.pdf"
    safe_name = re.sub(r'[<>:"/\\|?*]+', "_", filename)
    destination = target_dir / f"{file_id}-{safe_name}"
    url = metadata.get("downloadUrl")
    response, error = request_with_retries(url, stream=True)
    if response is None:
        return [], error
    try:
        with destination.open("wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    handle.write(chunk)
        chapters = extract_outline(destination)
        return chapters, None
    except Exception as exc:
        return [], f"{type(exc).__name__}: {str(exc)[:160]}"
    finally:
        response.close()
        destination.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--extract-chapters", action="store_true")
    parser.add_argument("--max-file-mb", type=int, default=200)
    parser.add_argument(
        "--reuse-audit",
        action="store_true",
        help="Reuse an existing output file instead of rechecking links/folders.",
    )
    args = parser.parse_args()

    books = json.loads(BOOKS_PATH.read_text(encoding="utf-8"))
    file_books = defaultdict(list)
    folder_books = defaultdict(list)
    external_books = defaultdict(list)

    for book in books:
        url = book.get("sourceUrl", "")
        file_match = DRIVE_FILE_RE.search(url)
        folder_match = DRIVE_FOLDER_RE.search(url)
        if file_match:
            file_books[file_match.group(1)].append(book)
        elif folder_match:
            folder_books[folder_match.group(1)].append(book)
        elif url:
            external_books[url].append(book)

    file_audits = {}
    folder_audits = {}
    external_audits = {}

    if args.reuse_audit and args.output.exists():
        previous = json.loads(args.output.read_text(encoding="utf-8"))
        previous_resources = previous.get("resources", {})
        for entries in file_books.values():
            metadata = previous_resources.get(entries[0]["id"], {})
            if metadata.get("fileId"):
                file_audits[metadata["fileId"]] = metadata
        for entries in folder_books.values():
            metadata = previous_resources.get(entries[0]["id"], {})
            if metadata.get("folderId"):
                folder_audits[metadata["folderId"]] = metadata
        for url, entries in external_books.items():
            external_audits[url] = previous_resources.get(entries[0]["id"], {})
    else:
        with ThreadPoolExecutor(max_workers=10) as pool:
            future_map = {
                pool.submit(audit_drive_file, file_id): ("file", file_id)
                for file_id in file_books
            }
            future_map.update(
                {
                    pool.submit(audit_drive_folder, folder_id): (
                        "folder",
                        folder_id,
                    )
                    for folder_id in folder_books
                }
            )
            future_map.update(
                {
                    pool.submit(audit_external, url): ("external", url)
                    for url in external_books
                }
            )
            for future in as_completed(future_map):
                kind, key = future_map[future]
                result = future.result()
                if kind == "file":
                    file_audits[key] = result
                elif kind == "folder":
                    folder_audits[key] = result
                else:
                    external_audits[key] = result

    if args.extract_chapters:
        with tempfile.TemporaryDirectory(prefix="open-books-toc-") as temp_name:
            temp_dir = Path(temp_name)
            for index, (file_id, metadata) in enumerate(
                sorted(file_audits.items()), start=1
            ):
                if metadata.get("access") != "public":
                    continue
                size = int(metadata.get("size") or 0)
                if size and size > args.max_file_mb * 1024 * 1024:
                    metadata["chapterError"] = (
                        f"Skipped: file exceeds {args.max_file_mb} MB"
                    )
                    continue
                print(
                    f"[{index}/{len(file_audits)}] extracting "
                    f"{metadata.get('filename') or file_id}",
                    flush=True,
                )
                chapters, error = download_and_extract(
                    file_id, metadata, temp_dir
                )
                if chapters:
                    metadata["chapters"] = chapters
                elif error:
                    metadata["chapterError"] = error
                else:
                    metadata["chapterError"] = "PDF has no embedded bookmarks"

    for metadata in file_audits.values():
        normalise_chapters(metadata)

    resources = {}
    for book in books:
        url = book.get("sourceUrl", "")
        file_match = DRIVE_FILE_RE.search(url)
        folder_match = DRIVE_FOLDER_RE.search(url)
        if file_match:
            resources[book["id"]] = file_audits[file_match.group(1)]
        elif folder_match:
            resources[book["id"]] = folder_audits[folder_match.group(1)]
        elif url:
            resources[book["id"]] = external_audits[url]
        else:
            local_paths = []
            if book.get("pdf"):
                local_paths.append(ROOT / book["pdf"])
            local_paths.extend(
                ROOT / chapter["pdf"]
                for chapter in book.get("chapters", [])
                if chapter.get("pdf")
            )
            available = bool(local_paths) and all(path.exists() for path in local_paths)
            resources[book["id"]] = {
                "kind": "hosted" if available else "local",
                "access": "public" if available else "missing",
            }

    access_counts = Counter(
        metadata.get("access", "unknown") for metadata in resources.values()
    )
    kind_counts = Counter(
        metadata.get("kind", "unknown") for metadata in resources.values()
    )
    public_file_bytes = sum(
        int(metadata.get("size") or 0)
        for metadata in file_audits.values()
        if metadata.get("access") == "public"
    )

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "entries": len(books),
            "access": dict(sorted(access_counts.items())),
            "kinds": dict(sorted(kind_counts.items())),
            "publicDriveFiles": sum(
                1
                for metadata in file_audits.values()
                if metadata.get("access") == "public"
            ),
            "publicDriveFileBytes": public_file_bytes,
            "publicDriveFolders": sum(
                1
                for metadata in folder_audits.values()
                if metadata.get("access") == "public"
            ),
        },
        "resources": resources,
    }
    args.output.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload["summary"], indent=2), flush=True)
    print(f"Wrote {args.output}", flush=True)


if __name__ == "__main__":
    main()
