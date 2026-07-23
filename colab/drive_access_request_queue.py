"""
Google Colab helper for reviewing restricted BooksWeb Google Drive resources.

HOW TO USE
1. Open a new notebook at https://colab.research.google.com/
2. Copy this entire file into one code cell.
3. Edit REQUEST_MESSAGE below if desired, then run the cell.
4. Sign in with the Google account that should receive viewer access.
5. Use the generated buttons to open each Drive item and click "Request access".

Important Google Drive limitation:
The public Drive API cannot create an access proposal. Google requires the
requester to submit each request in the Drive UI. This notebook prepares and
deduplicates that manual queue; it does not use unsupported private endpoints.
"""

# @title Build the Drive viewer-access request queue

import html
import subprocess
import sys
import time
from pathlib import Path

subprocess.run(
    [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-q",
        "google-api-python-client",
        "google-auth-httplib2",
        "pandas",
        "requests",
    ],
    check=True,
)

import google.auth
import pandas as pd
import requests
from google.colab import auth, files
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from IPython.display import HTML, Markdown, display


# ---------- Settings you may edit ----------

BOOKS_URL = (
    "https://raw.githubusercontent.com/"
    "Sonali1701/BooksWeb/main/books.json"
)
RESOURCE_META_URL = (
    "https://raw.githubusercontent.com/"
    "Sonali1701/BooksWeb/main/resource-meta.json"
)

REQUEST_MESSAGE = """Hello{owner_suffix},

I am requesting viewer access to this study material for personal educational use.
I will respect the owner's sharing and copyright conditions.

Thank you."""

# Set to an integer such as 10 while testing, or leave as None for every item.
MAX_ITEMS = None

# Downloads the completed queue as CSV at the end.
DOWNLOAD_CSV = True


# ---------- Load the BooksWeb catalog ----------

def load_json(url):
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    return response.json()


books = load_json(BOOKS_URL)
resource_document = load_json(RESOURCE_META_URL)
resource_by_book_id = resource_document["resources"]

restricted_catalog_entries = []
for book in books:
    resource = resource_by_book_id.get(book["id"], {})
    if resource.get("access") != "restricted":
        continue
    if resource.get("kind") not in {"drive-file", "drive-folder"}:
        continue

    drive_id = resource.get("fileId") or resource.get("folderId")
    if not drive_id:
        continue

    restricted_catalog_entries.append(
        {
            "book_id": book["id"],
            "drive_id": drive_id,
            "kind": resource["kind"],
            "title": book.get("title", "Untitled resource"),
            "subject": book.get("subject", ""),
            "class": book.get("class", ""),
            "wing": book.get("wing", ""),
            "publication": book.get("publication", ""),
            "source_url": book.get("sourceUrl")
            or f"https://drive.google.com/open?id={drive_id}",
        }
    )

# One Drive item may appear more than once in the catalog. Request it only once,
# while retaining every catalog title/category that refers to it.
deduplicated = {}
for entry in restricted_catalog_entries:
    key = (entry["kind"], entry["drive_id"])
    if key not in deduplicated:
        deduplicated[key] = entry.copy()
        deduplicated[key]["catalog_titles"] = [entry["title"]]
        deduplicated[key]["categories"] = {
            " / ".join(
                value
                for value in (entry["wing"], entry["subject"], entry["class"])
                if value
            )
        }
    else:
        deduplicated[key]["catalog_titles"].append(entry["title"])
        deduplicated[key]["categories"].add(
            " / ".join(
                value
                for value in (entry["wing"], entry["subject"], entry["class"])
                if value
            )
        )

targets = list(deduplicated.values())
if MAX_ITEMS is not None:
    targets = targets[: int(MAX_ITEMS)]

print(
    f"Catalog entries marked restricted: {len(restricted_catalog_entries)}\n"
    f"Unique Drive items to check: {len(targets)}"
)


# ---------- Authenticate and check the signed-in account ----------

auth.authenticate_user()
credentials, _ = google.auth.default()
drive = build("drive", "v3", credentials=credentials, cache_discovery=False)


def inspect_drive_item(item):
    """Return metadata if this Google account can already see the item."""
    try:
        metadata = (
            drive.files()
            .get(
                fileId=item["drive_id"],
                fields=(
                    "id,name,mimeType,webViewLink,"
                    "owners(displayName,emailAddress)"
                ),
                supportsAllDrives=True,
            )
            .execute()
        )
        owners = metadata.get("owners", [])
        owner_names = sorted(
            {
                owner.get("displayName") or owner.get("emailAddress")
                for owner in owners
                if owner.get("displayName") or owner.get("emailAddress")
            }
        )
        return {
            "account_status": "Already accessible to signed-in account",
            "drive_name": metadata.get("name", ""),
            "owner_name": ", ".join(owner_names) or "Not supplied by Drive",
            "request_url": metadata.get("webViewLink") or item["source_url"],
        }
    except HttpError as error:
        status = getattr(error.resp, "status", None)
        if status in {403, 404}:
            # Drive intentionally hides metadata, including the owner, from a
            # user who does not have access.
            return {
                "account_status": "Request viewer access",
                "drive_name": "",
                "owner_name": "Not disclosed before access",
                "request_url": item["source_url"],
            }
        return {
            "account_status": f"Drive API error {status or 'unknown'}",
            "drive_name": "",
            "owner_name": "Unavailable",
            "request_url": item["source_url"],
        }


rows = []
for number, item in enumerate(targets, start=1):
    checked = inspect_drive_item(item)
    known_owner = checked["owner_name"]
    owner_suffix = (
        f" {known_owner}"
        if known_owner not in {
            "Not disclosed before access",
            "Not supplied by Drive",
            "Unavailable",
        }
        else ""
    )
    personalized_message = REQUEST_MESSAGE.format(owner_suffix=owner_suffix)

    rows.append(
        {
            "No.": number,
            "Title": " | ".join(dict.fromkeys(item["catalog_titles"])),
            "Category": " | ".join(sorted(filter(None, item["categories"]))),
            "Type": item["kind"].replace("drive-", "").title(),
            "Owner name": known_owner,
            "Signed-in account status": checked["account_status"],
            "Request URL": checked["request_url"],
            "Request message": personalized_message,
            "Drive ID": item["drive_id"],
        }
    )
    if number % 20 == 0:
        print(f"Checked {number} of {len(targets)} items...")
    time.sleep(0.05)

queue = pd.DataFrame(rows)
request_queue = queue[
    queue["Signed-in account status"] == "Request viewer access"
].copy()
already_accessible = queue[
    queue["Signed-in account status"]
    == "Already accessible to signed-in account"
].copy()

print(
    f"\nNeed a Drive UI request: {len(request_queue)}\n"
    f"Already accessible to this account: {len(already_accessible)}\n"
    f"Other API errors: {len(queue) - len(request_queue) - len(already_accessible)}"
)


# ---------- Save the full audit and render the manual request queue ----------

csv_path = Path("/content/drive_viewer_access_queue.csv")
queue.to_csv(csv_path, index=False)
print(f"Saved: {csv_path}")

if request_queue.empty:
    display(Markdown("### No viewer-access requests are needed for this account."))
else:
    cards = []
    for _, row in request_queue.iterrows():
        title = html.escape(str(row["Title"]))
        category = html.escape(str(row["Category"]))
        owner = html.escape(str(row["Owner name"]))
        request_url = html.escape(str(row["Request URL"]), quote=True)
        message = html.escape(str(row["Request message"]))
        cards.append(
            f"""
            <article class="request-card">
              <div class="request-number">#{int(row["No."])}</div>
              <h3>{title}</h3>
              <p><b>Category:</b> {category or "Uncategorized"}</p>
              <p><b>Owner:</b> {owner}</p>
              <textarea readonly rows="6">{message}</textarea>
              <a class="request-button" href="{request_url}" target="_blank"
                 rel="noopener noreferrer">Open Drive request page</a>
            </article>
            """
        )

    display(
        HTML(
            """
            <style>
              .request-help {
                padding: 14px 16px;
                margin: 8px 0 16px;
                border-left: 5px solid #1a73e8;
                background: #eef5ff;
                border-radius: 8px;
              }
              .request-card {
                border: 1px solid #dadce0;
                border-radius: 12px;
                padding: 16px;
                margin: 12px 0;
                background: white;
              }
              .request-card h3 { margin: 4px 0 10px; }
              .request-card p { margin: 5px 0; }
              .request-number { color: #5f6368; font-weight: 700; }
              .request-card textarea {
                box-sizing: border-box;
                width: 100%;
                margin: 10px 0;
                padding: 10px;
                resize: vertical;
              }
              .request-button {
                display: inline-block;
                padding: 10px 14px;
                color: white !important;
                background: #1a73e8;
                border-radius: 8px;
                font-weight: 700;
                text-decoration: none;
              }
            </style>
            <div class="request-help">
              <b>Google requires the final action in Drive.</b>
              Open an item, click <b>Request access</b>, paste the prepared
              message, and submit it. Return here for the next item.
            </div>
            """
            + "\n".join(cards)
        )
    )

if DOWNLOAD_CSV:
    files.download(str(csv_path))
