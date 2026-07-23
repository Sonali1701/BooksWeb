# Open Books Library

A static web app that presents study materials like an NCERT-style digital library.
Each material is tagged by **Subject, Class, Wing, Language, and Year**, and opens its
source PDF in a built-in reader.

## Open the app

Run the folder through a small local server so the browser can load `books.json` and the PDFs:

```powershell
py -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

You can still open `index.html` directly, but many browsers block local `books.json`
loading. In that case the app shows a small built-in sample.

## Public deployment

This repository is ready to deploy as a free public site with GitHub Pages. The workflow
in [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) publishes the
site whenever `main` is pushed.

1. Create a public GitHub repository and push this folder to its `main` branch.
2. In the repository, open **Settings → Pages** and select **GitHub Actions** as the source.
3. Open **Actions → Deploy Open Books to GitHub Pages** to follow the first deployment.

For a repository named `BooksWeb`, the default URL is:

```text
https://YOUR_USER.github.io/BooksWeb/
```

The included NCERT Physics chapter PDFs are hosted directly by the site. Catalog entries
that point to public Google Drive *files* can use Drive's inline preview; Drive *folders*
open in a new tab because a folder cannot be embedded as a PDF.

Only publish material that you have permission to distribute.

## Verified Drive resources

The generated [`resource-meta.json`](resource-meta.json) records anonymous access checks
for every catalog entry. The current snapshot contains:

- 32 catalog entries backed by 31 public Drive PDFs
- 43 public Drive folders with 659 child files available in the in-app file browser
- 18 public PDFs with 420 extracted bookmark/page divisions
- explicit `Restricted` and `Missing` states for sources that visitors cannot open

Public Drive books with embedded PDF bookmarks receive chapter/section navigation
automatically. Selecting a section opens the Drive preview at its starting page. Public
folders receive a searchable file list; PDF children open directly in the reader.

Regenerate the metadata after Drive permissions or folder contents change:

```powershell
py scripts/sync_resource_metadata.py
py scripts/sync_resource_metadata.py --reuse-audit --extract-chapters --max-file-mb 200
```

The sync script uses `requests`, `gdown`, and `PyMuPDF`. PDFs used for bookmark extraction
are downloaded one at a time to temporary storage and deleted immediately; book files are
not added to the repository.

## Using a separate public PDF repository

The app supports a second GitHub Pages repository for chapter PDFs. Set `pdfBaseUrl` in
[`config.js`](config.js) to its public Pages URL:

```js
window.OPEN_BOOKS_CONFIG = {
  pdfBaseUrl: "https://YOUR_USER.github.io/open-books-pdfs"
};
```

Relative `pdf` and chapter `pdf` values in `books.json` will then resolve from that URL.
Absolute `https://` PDF URLs continue to work unchanged.

## Catalog data (`books.json`)

`books.json` is generated from the **NEET Content Tracker** workbook (the `External Source`
and `New Category Books` tabs) and currently holds ~293 real book entries. It is a plain
JSON array; each entry has:

| Field         | Example                                   | Notes                                          |
| ------------- | ----------------------------------------- | ---------------------------------------------- |
| `id`          | `es-1-botany-aakash`                      | Unique id for the entry                        |
| `title`       | `HC Verma Part 1`                         | Display name                                   |
| `subject`     | `Physics`                                 | Physics, Chemistry, Botany, Zoology, Biology, Maths |
| `class`       | `11`                                      | `11`, `12`, or `11 & 12`                        |
| `wing`        | `NEET`                                    | NEET, JEE, or Board                            |
| `language`    | `English`                                 | English or Hindi (auto-detected from the title) |
| `year`        | `2021`                                    | Session / year (may be empty)                  |
| `author`      | `H. C. Verma`                             | Optional                                       |
| `publication` | `Bharti Bhavan`                           | Optional                                       |
| `description` | `H. C. Verma \| Bharti Bhavan`            | Short summary shown on the card (optional)     |
| `sourceUrl`   | `https://drive.google.com/...`            | Original Google Drive link to view/download    |
| `pdf`         | `pdfs/physics-hc-verma-part1.pdf`         | Local PDF path (leave `""` until downloaded)   |
| `chapters`    | `[ {title, page} ]`                       | Optional — enables the chapter-wise reader     |

The five filters (Subject, Class, Wing, Language, Year) are generated automatically from
whatever values appear in `books.json` — add a new subject or year and it shows up in the
dropdowns without any code change. A sixth **Access** filter is derived automatically and
separates hosted PDFs, public previews, public folders, external links, restricted
resources, and missing sources.

The local `NEET CONTENT TRACKER - Sheet1.csv` export is a 39-row internal project tracker
with columns such as `Project Name`, `Planner`, and `Drive Link`; it is intentionally
excluded from this public repository and is not the source catalog for these 291 books.
To regenerate the catalog, export the workbook's **External Source** and
**New Category Books** tabs instead.

## Chapter-wise books (like NCERT)

Give an entry a `chapters` array and the reader shows a scrollable **Contents** list with
previous/next chapter navigation — the same experience as the NCERT textbook pages.

Each chapter can open in one of two ways:

```jsonc
"chapters": [
  // Mode A: page anchor into the book's single combined PDF (uses book.pdf)
  { "title": "Chapter 1: Units and Measurements", "page": 49, "unit": "Unit 1" },

  // Mode B: a separate PDF file per chapter (the NCERT model)
  { "title": "Chapter 1: Units and Measurements", "pdf": "pdfs/physics-11/ch01.pdf" }
]
```

- `page` jumps to that page of `book.pdf` via the browser's `#page=` viewer.
- `pdf` opens a standalone file (leave `page` out).
- `unit` (optional) groups chapters under a heading in the Contents list.

Public Google Drive PDFs with bookmarks are live examples of Mode A: the metadata sync
extracts their section titles and starting pages without publishing copies of the books.

## Hosting large PDFs

Browsers must download the whole file to open it, and **GitHub Pages rejects any file over
100 MB**. For production:

- **Prefer Mode B** (one PDF per chapter) — each file is small, fast, and well under the limit.
- Or keep large books on Google Drive and rely on `sourceUrl` (no hosting needed).
- Only commit PDFs you have the right to distribute publicly.

## Adding the actual PDFs

Every entry already carries its `sourceUrl`, so the app is fully usable immediately: pick a
book and click **Open original source** to view or download it on Google Drive.

To show a PDF **inline** in the reader:

1. Download the PDF from its `sourceUrl` and save it in the [`pdfs/`](pdfs/) folder.
2. Set that entry's `pdf` field in `books.json` to the saved path.
3. Reload the page.

Until a local PDF is added, the reader shows the **Open original source** button instead of
an embedded document.
