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

The five filters (Subject, Class, Wing, Language, Year) are generated automatically from
whatever values appear in `books.json` — add a new subject or year and it shows up in the
dropdowns without any code change.

## Adding the actual PDFs

Every entry already carries its `sourceUrl`, so the app is fully usable immediately: pick a
book and click **Open original source** to view or download it on Google Drive.

To show a PDF **inline** in the reader:

1. Download the PDF from its `sourceUrl` and save it in the [`pdfs/`](pdfs/) folder.
2. Set that entry's `pdf` field in `books.json` to the saved path.
3. Reload the page.

Until a local PDF is added, the reader shows the **Open original source** button instead of
an embedded document.
