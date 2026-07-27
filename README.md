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

### Files Drive will not preview

Drive's viewer refuses PDFs past roughly **100 MB** with *"This file is too large to
preview"*, no matter who owns them or how they are shared. Seven public entries in this
catalog are over that line, the largest at 552 MB.

Because `resource-meta.json` records each file's size, those books never reach Drive's viewer
at all. Signed in, they are fetched through the Drive API and shown from a `blob:` URL, which
has no such limit. Signed out, the reader explains the situation and gives its size instead of
letting Google's frame fail with no way forward.

Drive can also decline for reasons the catalog cannot predict, and a cross-origin frame never
reports failure back to us. So every Drive preview carries an **Open it here instead** link
that switches that book to the API route permanently for the session — the reader never has to
wait for the app to notice something went wrong.

Files over 250 MB additionally warn before downloading: they are held in memory to be
displayed, which a phone or an older machine may not manage.

### Restricted files and signing in

`Restricted` records that a **signed-out** visitor cannot open the file — the sync script
checks every link anonymously. It does not mean *you* cannot open it. Drive's `/preview`
iframe uses the browser's own Google session, so a reader signed in to an account that has
access sees the document in place.

#### Signing in with Google (recommended)

When [`config.js`](config.js) carries a `googleClientId`, the reader signs in through Google
Identity Services and reads files with the Drive API. This is the reliable route: a bearer
token is not a cookie, so it works in Safari and Firefox, where Drive's own preview frame
usually fails.

Once signed in, **Drive becomes the source of truth** and the static audit is ignored for
single files. That includes entries marked `Missing`, because Drive answers `404` both for a
deleted file and for one the caller simply may not see — an anonymous probe cannot tell those
apart, and a signed-in call can.

The reader then:

1. asks Drive whether the account can open the file, and says who it is signed in as when the
   answer is no, offering **Request access** and **Use a different account**;
2. downloads files under 25 MB straight into the page and shows them from a `blob:` URL —
   the document is never framed from Google's origin;
3. for anything larger, shows the size and waits for a tap, since these books run to hundreds
   of megabytes and readers are often on phones;
4. holds exactly one downloaded file at a time, releasing the previous object URL.

The access token is kept in memory only, never in storage. A returning reader is re-authorised
silently where the browser permits it, and simply sees the sign-in button where it does not.

##### The prompt on arrival

A sign-in dialog opens as the app loads, so signing in is not something to remember once a
book has already refused to open. It invites the click rather than making it: browsers block
an OAuth popup that was not opened by a user gesture, so the popup cannot be raised
automatically.

It appears only when it is useful — never when already signed in, and never again once
**Browse without signing in** (or Esc) has been used. The one exception is a reader who has
signed in before and whose silent re-authorisation failed: they meant to be signed in, so the
prompt returns. Sign-in failures stay inside the dialog, since that is where a misconfigured
origin is most likely to be noticed.

##### Setup this needs in Google Cloud

The client ID alone is not enough — Google matches the requesting origin against an allow
list, so **sign-in fails until every origin the app is served from is registered**:

1. Open **Google Cloud Console → APIs & Services → Credentials**, pick the OAuth 2.0 Client
   ID (type *Web application*), and under **Authorized JavaScript origins** add:
   - `https://YOUR_USER.github.io` — origin only, no repository path
   - `http://localhost:8000` — and any other port used locally
2. Enable the **Google Drive API** for the project under **APIs & Services → Library**.
3. On the **OAuth consent screen**, add every reader as a **Test user** while the app is in
   *Testing* (capped at 100), or publish it.

`drive.readonly` is a **restricted** scope. In *Testing* it works immediately for listed test
users; publishing it to the general public requires Google's verification and a third-party
security assessment. For a class or a small team, Testing mode is usually the right answer.

The client ID is public by design and belongs in `config.js`. **The client secret does not** —
the browser flow never uses it, and this repository is public. Keep the downloaded
`client_secret_*.json` outside the repository.

#### Without a client ID

Restricted single files fall back to a sign-in gate around Drive's own preview:

1. **Sign in / open in Drive** opens the file in a new tab, where Google handles signing in
   or requesting access.
2. **I am signed in — show the preview** embeds the Drive preview and remembers the choice
   (`obl:drive-signin` in `localStorage`), so later restricted books skip the gate.
3. Every restricted preview keeps an escape hatch beneath it — open in Drive, or **use a
   different account** to return to the gate.

That second button records the reader's own assertion, not a verified session: a
cross-origin iframe cannot report back whether it rendered, so the app cannot detect the
difference between a loaded document and a Google sign-in screen. The escape hatch is what
covers the gap. This is exactly the guesswork the signed-in route above removes.

**Browser caveat for this fallback:** it relies on Google cookies inside a third-party frame.
Chrome and Edge generally allow this; Safari's tracking prevention and Firefox's Total Cookie
Protection often do not, and will show Google's sign-in screen inside the frame instead.
Public files are unaffected — they need no session at all.

Restricted *folders* still cannot be embedded at any permission level, so they keep a panel
pointing at Drive.

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

### Where a book's contents come from

Every entry gets a table of contents when one can be established. The reader resolves it in
priority order:

| Source | Mode | Navigates? |
| ------ | ---- | ---------- |
| `chapters` in `books.json`, or bookmarks extracted into `resource-meta.json` | Contents | Yes — opens the chapter's PDF or page |
| `folderItems` from a public Drive folder | Files | Yes — opens that file |
| [`chapters-map.json`](chapters-map.json) syllabus outline for the entry's subject + class | Syllabus contents | No — reference outline only |

Most catalog entries are single Drive documents with no bookmarks, so they fall back to the
syllabus outline. That list is the standard NCERT / JEE / NEET chapter sequence, grouped by
unit, and it is labelled **Syllabus contents** with an explicit note in the panel: it tells a
student what the book covers, but it carries no page numbers, so it cannot jump. Selecting an
entry names the chapter in the toolbar and leaves the document where it is.

`chapters-map.json` holds the outlines for Physics, Chemistry, Maths, Biology, Botany, and
Zoology across classes 11 and 12, plus `aliases` that route subjects such as `Pcb` to several
lists at once. A `class` of `11 & 12` concatenates both years under `Class 11` / `Class 12`
unit headings. Edit that file to correct or extend an outline — no code change is needed.

## Screen sizes

One build serves the laptop site and the installed mobile app.

- **≥ 901 px** — filters, reader, and material list stack down one page. The reader sizes
  itself to `100dvh` minus the measured header height, so the page view fits a short laptop
  window without scrolling. **Hide panel** widens the document; **Fullscreen** removes the
  chrome entirely.
- **≤ 900 px** — the app becomes a two-view shell with a bottom tab bar: **Library**
  (search, filters, cards) and **Reader**, which owns the whole viewport. The details panel
  opens as a bottom sheet from the **Contents** button, and closes as soon as a chapter is
  picked.
- **≤ 480 px and landscape phones** — compacted chrome, single-column filters, and a
  single-row toolbar so the document keeps the most space.

Safe-area insets are respected on notched devices, and no view scrolls horizontally at any
width. If you change the header, nothing needs recalculating — `app.js` measures it and
publishes `--topbar-h` for the CSS.

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
