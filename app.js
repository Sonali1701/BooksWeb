const CATALOG_URL = "books.json";
const RESOURCE_META_URL = "resource-meta.json";
const CHAPTER_MAP_URL = "chapters-map.json";
const APP_CONFIG = window.OPEN_BOOKS_CONFIG || {};
const PDF_BASE_URL = String(APP_CONFIG.pdfBaseUrl || "").trim().replace(/\/+$/, "");
const MOBILE_QUERY = "(max-width: 900px)";
const DRIVE_SIGNIN_KEY = "obl:drive-signin";
const WELCOME_KEY = "obl:welcome-dismissed";
// Drive's own viewer refuses to render a PDF past roughly this size
// ("This file is too large to preview"), whatever the sharing settings.
// Files above it skip the Drive frame and are fetched through the API.
const DRIVE_PREVIEW_LIMIT = 100 * 1024 * 1024;
// Holding one of these in memory is heavy enough to warn about first.
const DRIVE_HEAVY_LIMIT = 250 * 1024 * 1024;

const fallbackBooks = [
  {
    id: "sample-material",
    title: "Sample Material",
    subject: "Physics",
    class: "11",
    wing: "NEET",
    language: "English",
    year: "2024-25",
    description: "A built-in sample shown only if books.json cannot be loaded. Run the folder through a local server to load the full catalog.",
    sourceUrl: "",
    pdf: ""
  }
];

const FILTERS = [
  { key: "subject", el: null, active: "All" },
  { key: "class", el: null, active: "All" },
  { key: "wing", el: null, active: "All" },
  { key: "language", el: null, active: "All" },
  { key: "year", el: null, active: "All" },
  { key: "access", el: null, active: "All" }
];

let books = [];
let selectedBook = null;
let selectedChapterIndex = null; // null = complete book / single PDF
let currentViewKey = null;
let resourceSummary = null;
let chapterMap = null;
let drivePreviewFallback = false; // used only when localStorage is unavailable
let activeDriveFile = null; // { fileId, url } — the one blob URL held at a time
// True once a chapter has actually been chosen. Opening a book selects its
// first chapter automatically, and that must not be read as a request to
// download the file — only a deliberate jump justifies the wait.
let chapterPicked = false;

// Books flagged localOnly (large local demo files) only render when running locally.
const IS_LOCAL = ["localhost", "127.0.0.1", ""].includes(location.hostname);

const bookGrid = document.querySelector("#bookGrid");
const searchInput = document.querySelector("#searchInput");
const dataNotice = document.querySelector("#dataNotice");
const resultCount = document.querySelector("#resultCount");
const clearFilters = document.querySelector("#clearFilters");
const filterPanel = document.querySelector("#filterPanel");
const filterBadge = document.querySelector("#filterBadge");

const readerTitle = document.querySelector("#reader-title");
const readerMeta = document.querySelector("#readerMeta");
const readerFacts = document.querySelector("#readerFacts");
const sourceLink = document.querySelector("#sourceLink");
const completeBook = document.querySelector("#completeBook");
const contents = document.querySelector("#contents");
const contentsLabel = document.querySelector("#contentsLabel");
const contentsNote = document.querySelector("#contentsNote");
const chapterCount = document.querySelector("#chapterCount");
const chapterSearch = document.querySelector("#chapterSearch");
const chapterList = document.querySelector("#chapterList");
const prevChapter = document.querySelector("#prevChapter");
const nextChapter = document.querySelector("#nextChapter");
const toggleSidebar = document.querySelector("#toggleSidebar");
const fullscreenBtn = document.querySelector("#fullscreenBtn");
const readerShell = document.querySelector(".reader-shell");
const readerPanel = document.querySelector(".reader-panel");
const readerSidebar = document.querySelector("#readerSidebar");
const readerFileTitle = document.querySelector("#readerFileTitle");
const readerFileStatus = document.querySelector("#readerFileStatus");
const pdfFrame = document.querySelector("#pdfFrame");

const topbar = document.querySelector("#topbar");
const tabbar = document.querySelector("#tabbar");
const tabs = Array.from(document.querySelectorAll(".tab"));
const backToLibrary = document.querySelector("#backToLibrary");
const googleAuthBtn = document.querySelector("#googleAuthBtn");
const welcomeDialog = document.querySelector("#welcomeDialog");
const welcomeSignIn = document.querySelector("#welcomeSignIn");
const welcomeSkip = document.querySelector("#welcomeSkip");
const welcomeError = document.querySelector("#welcomeError");
const sheetClose = document.querySelector("#sheetClose");
const sheetScrim = document.querySelector("#sheetScrim");

const mobileQuery = window.matchMedia(MOBILE_QUERY);

const SUBJECT_COLORS = {
  Physics: "linear-gradient(145deg, #255c8e, #63a0a8)",
  Chemistry: "linear-gradient(145deg, #6d4b8f, #d5776c)",
  Botany: "linear-gradient(145deg, #1f8066, #9ac26b)",
  Zoology: "linear-gradient(145deg, #b9473f, #e0ad3f)",
  Biology: "linear-gradient(145deg, #157a53, #7fbf5a)",
  Maths: "linear-gradient(145deg, #275b8f, #1e7661)"
};

function colorForSubject(subject) {
  return SUBJECT_COLORS[subject] || "linear-gradient(145deg, #5e6a70, #d6a54c)";
}

function isMobile() {
  return mobileQuery.matches;
}

/* ---------- layout ---------- */

// The reader sizes itself against the space the header actually leaves, so a
// short laptop window and a tall phone both get a full-height page view.
function measureChrome() {
  if (!topbar) return;
  const height = Math.round(topbar.getBoundingClientRect().height);
  if (height > 0) {
    document.documentElement.style.setProperty("--topbar-h", `${height}px`);
  }
}

function setView(view) {
  document.body.dataset.view = view;
  tabs.forEach((tab) => {
    tab.setAttribute("aria-pressed", String(tab.dataset.view === view));
  });
}

function openSheet() {
  document.body.classList.add("sheet-open");
  sheetScrim.hidden = false;
  syncSidebarToggle();
}

function closeSheet() {
  document.body.classList.remove("sheet-open");
  sheetScrim.hidden = true;
  syncSidebarToggle();
}

function sheetOpen() {
  return document.body.classList.contains("sheet-open");
}

function syncSidebarToggle() {
  if (isMobile()) {
    const open = sheetOpen();
    toggleSidebar.textContent = open ? "Close contents" : "Contents";
    toggleSidebar.setAttribute("aria-pressed", String(open));
    return;
  }
  const collapsed = readerShell.classList.contains("collapsed");
  toggleSidebar.textContent = collapsed ? "Show panel" : "Hide panel";
  toggleSidebar.setAttribute("aria-pressed", String(collapsed));
}

// Keep the two layouts from leaking into each other when the window crosses
// the breakpoint (or a phone is rotated).
function syncLayout() {
  measureChrome();
  if (isMobile()) {
    readerShell.classList.remove("collapsed");
  } else {
    closeSheet();
    filterPanel.open = true;
  }
  syncSidebarToggle();
}

/* ---------- filters ---------- */

function sortValues(key, values) {
  if (key === "class") {
    const order = { "11": 1, "12": 2, "11 & 12": 3 };
    return values.sort((a, b) => (order[a] || 99) - (order[b] || 99) || a.localeCompare(b));
  }
  if (key === "access") {
    const order = {
      "Hosted here": 1,
      "Public preview": 2,
      "Public folder": 3,
      "External link": 4,
      Restricted: 5,
      Missing: 6,
      Unavailable: 7
    };
    return values.sort((a, b) => (order[a] || 99) - (order[b] || 99) || a.localeCompare(b));
  }
  if (key === "year") {
    return values.sort((a, b) => b.localeCompare(a));
  }
  return values.sort((a, b) => a.localeCompare(b));
}

function valueForFilter(book, key) {
  return key === "access" ? accessInfo(book).label : book[key];
}

function uniqueValues(key) {
  const values = [...new Set(books.map((book) => valueForFilter(book, key)).filter(Boolean))];
  return ["All", ...sortValues(key, values)];
}

function fillSelect(select, values) {
  select.innerHTML = values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("");
}

function setupFilters() {
  FILTERS.forEach((filter) => fillSelect(filter.el, uniqueValues(filter.key)));
}

function activeFilterCount() {
  return FILTERS.filter((filter) => filter.active !== "All").length;
}

function filtersActive() {
  return activeFilterCount() > 0 || searchInput.value.trim() !== "";
}

function syncFilterBadge() {
  const count = activeFilterCount();
  filterBadge.hidden = count === 0;
  filterBadge.textContent = String(count);
}

function bookMatchesFilters(book, query) {
  const searchable = [
    book.title, book.subject, book.class, book.wing,
    book.language, book.year, book.description, book.author, book.publication,
    accessInfo(book).label
  ].join(" ").toLowerCase();

  const passesFilters = FILTERS.every(
    (filter) => filter.active === "All" || valueForFilter(book, filter.key) === filter.active
  );

  return passesFilters && searchable.includes(query);
}

/* ---------- chapters ---------- */

// Every book gets a table of contents when one can be established, in this
// order: hand-authored or extracted chapters, then a public Drive folder
// listing, then the standard syllabus outline for its subject and class.
function readerCollection(book) {
  if (book && book.chapters && book.chapters.length) {
    // Page breaks recovered from a scanner's outline are real positions with
    // no names. They navigate perfectly well, but calling them a contents
    // list would promise something the file does not contain. Judged from the
    // titles as well as the recorded source, so entries extracted before that
    // source existed are described just as accurately.
    return {
      mode: "chapters",
      items: book.chapters,
      navigable: true,
      unnamed: book.chapterSource === "page-divisions" || mostlyUnnamed(book.chapters)
    };
  }
  if (book && book.folderItems && book.folderItems.length) {
    return { mode: "folder", items: book.folderItems, navigable: true };
  }
  if (book && book.syllabusChapters && book.syllabusChapters.length) {
    return {
      mode: "syllabus",
      items: book.syllabusChapters,
      navigable: false,
      label: book.syllabusLabel || "standard syllabus"
    };
  }
  return { mode: "none", items: [], navigable: false };
}

// "Section 4" is a position, not a title. When most entries read that way the
// list is a set of page breaks rather than a table of contents.
function mostlyUnnamed(chapters) {
  if (!chapters.length) return false;
  const placeholder = chapters.filter((chapter) =>
    /^section\s+\d+$/i.test(String(chapter.title || "").trim())).length;
  return placeholder / chapters.length >= 0.7;
}

function subjectKeys(subject) {
  const key = String(subject || "").trim().toLowerCase();
  if (!key) return [];
  const aliases = (chapterMap && chapterMap.aliases) || {};
  return aliases[key] ? aliases[key].slice() : [key];
}

function classKeys(value) {
  const text = String(value || "");
  const keys = [];
  if (/\b11\b/.test(text)) keys.push("11");
  if (/\b12\b/.test(text)) keys.push("12");
  return keys;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Build a reference outline from the syllabus map. Entries carry no page
// numbers, so they are shown as contents rather than as jump targets.
function buildSyllabusChapters(book) {
  const syllabus = (chapterMap && chapterMap.syllabus) || null;
  if (!syllabus) return { items: [], label: "" };

  const subjects = subjectKeys(book.subject).filter((key) => syllabus[key]);
  const classes = classKeys(book.class);
  if (!subjects.length || !classes.length) return { items: [], label: "" };

  const multiSubject = subjects.length > 1;
  const multiClass = classes.length > 1;
  const items = [];
  const labels = [];

  subjects.forEach((subjectKey) => {
    const entry = syllabus[subjectKey];
    if (entry.label && !labels.includes(entry.label)) labels.push(entry.label);
    classes.forEach((classKey) => {
      const chapters = entry[classKey] || [];
      chapters.forEach((chapter, index) => {
        const unit = [
          multiSubject ? titleCase(subjectKey) : "",
          multiClass ? `Class ${classKey}` : "",
          chapter.unit || ""
        ].filter(Boolean).join(" · ");
        items.push({ title: chapter.title, unit, number: index + 1 });
      });
    });
  });

  // One subject reads well ("NCERT / NEET Biology syllabus"); stacking three
  // of them does not, so combined books get a plain label.
  const label = labels.length === 1 ? labels[0] : "standard NCERT / JEE / NEET syllabus";
  return { items, label };
}

function folderGroup(item) {
  const path = String(item.path || "").replace(/\\/g, "/");
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

function collectionLabel(collection) {
  if (collection.mode === "folder") return "Files";
  if (collection.mode === "syllabus") return "Syllabus contents";
  if (collection.unnamed) return "Page divisions";
  return "Contents";
}

function collectionUnit(collection, item) {
  return collection.mode === "folder" ? folderGroup(item) : item.unit;
}

function collectionDetail(collection, item, index) {
  if (collection.mode === "chapters" && item.page) return `Page ${item.page}`;
  if (collection.mode === "syllabus") return `Chapter ${item.number || index + 1}`;
  return "";
}

function renderChapterList(book) {
  const collection = readerCollection(book);
  const hasItems = collection.items.length > 0;
  contents.hidden = !hasItems;
  prevChapter.hidden = !hasItems;
  nextChapter.hidden = !hasItems;

  if (!hasItems) {
    chapterList.innerHTML = "";
    return;
  }

  chapterSearch.value = "";
  contentsLabel.textContent = collectionLabel(collection);
  chapterSearch.placeholder = collection.mode === "folder"
    ? "Find a file..."
    : "Find a chapter...";
  chapterCount.textContent = `(${collection.items.length})`;

  contentsNote.hidden = collection.navigable && !collection.unnamed;
  if (!collection.navigable) {
    contentsNote.textContent =
      `Outline of the ${collection.label}. This material is one document, so the ` +
      "list is for reference — use the viewer's page controls or search to reach a chapter.";
  } else if (collection.unnamed) {
    contentsNote.textContent =
      "This scan carries page breaks but no chapter names, so sections are numbered " +
      "by position. Each one still jumps to the right page.";
  }

  let html = "";
  let lastUnit = null;
  collection.items.forEach((item, index) => {
    const unit = collectionUnit(collection, item);
    if (unit && unit !== lastUnit) {
      html += `<p class="unit-heading">${escapeHtml(unit)}</p>`;
      lastUnit = unit;
    }
    const detail = collectionDetail(collection, item, index);
    // An entry with no page behind it cannot move the viewer. Marking it says
    // so before it is clicked, rather than leaving a button that looks broken.
    const reference = collection.mode === "syllabus" ? " reference" : "";
    html += `
      <button class="chapter-button${reference} ${index === selectedChapterIndex ? "active" : ""}" type="button" data-index="${index}">
        <span>${escapeHtml(item.title)}</span>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      </button>`;
  });
  chapterList.innerHTML = html;

  chapterList.querySelectorAll(".chapter-button").forEach((button) => {
    button.addEventListener("click", () => {
      selectedChapterIndex = Number(button.dataset.index);
      chapterPicked = true;
      renderReaderView();
      if (isMobile()) closeSheet();
    });
  });
}

function filterChapters(query) {
  const q = query.trim().toLowerCase();
  chapterList.querySelectorAll(".chapter-button").forEach((button) => {
    button.style.display = button.textContent.toLowerCase().includes(q) ? "" : "none";
  });
  chapterList.querySelectorAll(".unit-heading").forEach((heading) => {
    let el = heading.nextElementSibling;
    let anyVisible = false;
    while (el && !el.classList.contains("unit-heading")) {
      if (el.classList.contains("chapter-button") && el.style.display !== "none") {
        anyVisible = true;
        break;
      }
      el = el.nextElementSibling;
    }
    heading.style.display = anyVisible ? "" : "none";
  });
}

/* ---------- catalog ---------- */

function chapterBadgeFor(collection) {
  const count = collection.items.length;
  if (!count) return "";
  if (collection.mode === "folder") return `<span class="chapter-badge">${count} files</span>`;
  if (collection.mode === "syllabus") {
    return `<span class="chapter-badge outline">${count} topics</span>`;
  }
  if (collection.unnamed) return `<span class="chapter-badge">${count} sections</span>`;
  return `<span class="chapter-badge">${count} chapters</span>`;
}

function renderBooks() {
  const query = searchInput.value.trim().toLowerCase();
  const filteredBooks = books.filter((book) => bookMatchesFilters(book, query));

  resultCount.textContent = `${filteredBooks.length} of ${books.length} materials`;
  clearFilters.hidden = !filtersActive();
  syncFilterBadge();

  bookGrid.innerHTML = "";

  if (!filteredBooks.length) {
    bookGrid.innerHTML =
      '<p class="empty-state">No materials found. Try a different subject, class, wing, language, year, or search term.</p>';
    return;
  }

  filteredBooks.forEach((book) => {
    const access = accessInfo(book);

    const card = document.createElement("button");
    card.className = `book-card ${selectedBook && book.id === selectedBook.id ? "active" : ""}`;
    card.type = "button";
    card.innerHTML = `
      <span class="book-cover" style="background: ${escapeHtml(colorForSubject(book.subject))}">
        <span class="book-cover-subject">${escapeHtml(book.subject || "")}</span>
      </span>
      <span class="book-body">
        <span class="book-format">${escapeHtml(book.wing || "Material")}${book.year ? " &middot; " + escapeHtml(book.year) : ""}</span>
        <h3>${escapeHtml(book.title)}</h3>
        <p>${escapeHtml(book.description || (book.publication ? book.publication : "Source available — open to view or download."))}</p>
        <span class="tag-row">
          <span class="tag">${escapeHtml(book.subject)}</span>
          <span class="tag">Class ${escapeHtml(book.class)}</span>
          <span class="tag">${escapeHtml(book.wing)}</span>
          <span class="tag">${escapeHtml(book.language)}</span>
          <span class="access-badge access-${access.kind}">${escapeHtml(access.label)}</span>
          ${chapterBadgeFor(readerCollection(book))}
        </span>
      </span>
    `;
    card.addEventListener("click", () => selectBook(book));
    bookGrid.appendChild(card);
  });
}

/* ---------- reader ---------- */

function selectBook(book) {
  const collection = readerCollection(book);
  // Free a held Drive download as soon as the reader moves to another file.
  if (activeDriveFile && activeDriveFile.fileId !== driveFileId(book)) releaseDriveFile();
  // Moving on also stops a transfer still running for the previous book, which
  // now starts by itself and would otherwise keep pulling bytes unwatched. It
  // is not marked cancelled: coming back should download it, not refuse to.
  if (driveDownload && driveDownload.fileId !== driveFileId(book)) cancelDriveDownload();
  chapterPicked = false;
  selectedBook = book;
  // Reference outlines open on the whole document; real chapters open on the first one.
  selectedChapterIndex = collection.navigable && collection.items.length ? 0 : null;
  currentViewKey = null;
  renderBooks();
  renderReader();

  if (isMobile()) {
    setView("reader");
    closeSheet();
  } else {
    document.querySelector("#reader").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderFacts(book) {
  const facts = [
    ["Subject", book.subject],
    ["Class", book.class],
    ["Wing", book.wing],
    ["Language", book.language],
    ["Year", book.year],
    ["Author", book.author],
    ["Publication", book.publication]
  ].filter(([, value]) => value);

  readerFacts.innerHTML = facts
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
}

function persistSelection() {
  if (!selectedBook) return;
  const chPart = selectedChapterIndex !== null ? `&ch=${selectedChapterIndex}` : "&ch=all";
  try {
    localStorage.setItem("obl:last", JSON.stringify({ id: selectedBook.id, ch: selectedChapterIndex }));
  } catch (e) { /* storage unavailable */ }
  try {
    history.replaceState(null, "", `#book=${encodeURIComponent(selectedBook.id)}${chPart}`);
  } catch (e) { /* history unavailable */ }
}

function readInitialSelection() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  let id = params.get("book");
  let ch = params.get("ch");
  if (!id) {
    try {
      const saved = JSON.parse(localStorage.getItem("obl:last") || "null");
      if (saved && saved.id) {
        id = saved.id;
        ch = saved.ch === null ? "all" : String(saved.ch);
      }
    } catch (e) { /* ignore */ }
  }
  if (!id) return null;
  const book = books.find((b) => b.id === id);
  if (!book) return null;

  let index = null;
  const collection = readerCollection(book);
  if (collection.navigable && collection.items.length) {
    if (ch === "all") {
      index = null;
    } else {
      const n = Number(ch);
      index = Number.isInteger(n) && n >= 0 && n < collection.items.length ? n : 0;
    }
  } else if (collection.items.length && ch !== "all") {
    const n = Number(ch);
    index = Number.isInteger(n) && n >= 0 && n < collection.items.length ? n : null;
  }
  return { book, index };
}

/* ---------- viewer ---------- */

// Every viewer state is keyed so re-rendering the same document (for example
// when stepping through a reference outline) never reloads the iframe.
function renderFrame(key, html) {
  if (currentViewKey === key) return;
  currentViewKey = key;
  pdfFrame.innerHTML = html;
}

// Whether pointing an iframe at a PDF actually shows the pages.
//
// It does on desktop, and there the browser's own viewer is faster and more
// familiar than anything we could ship. On Android Chrome it does not: the
// frame is replaced by a placeholder offering to hand the file to another app,
// which is the "open" button people have to press before they can read
// anything. iOS Safari draws only the first page and will not scroll to the
// rest. Both need the pages drawn by us instead.
const NATIVE_PDF_IN_FRAME = (() => {
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) return false;
  if (/iPhone|iPad|iPod/i.test(ua)) return false;
  // iPadOS reports itself as a Mac, so the touch points are the reliable tell.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return false;
  // Browsers with PDF viewing switched off say so directly.
  return navigator.pdfViewerEnabled !== false;
})();

const PDFJS_VIEWER = "vendor/pdfjs/web/viewer.html";

// PDF.js resolves ?file= against its own location, so a path that is correct
// for the page is wrong for the viewer unless it is made absolute first.
//
// #page= means the same thing to both viewers. #view=FitH does not: it is a
// PDF open parameter the native viewers honour and PDF.js ignores, so it is
// swapped for the PDF.js spelling. Fitting the width is what makes a textbook
// legible on a phone without pinching, so it is worth carrying across.
function frameSrc(url, hash) {
  if (NATIVE_PDF_IN_FRAME) return encodeURI(url) + hash;
  const absolute = new URL(url, location.href).href;
  const viewerHash = hash === "#view=FitH" ? "#zoom=page-width" : hash;
  return `${PDFJS_VIEWER}?file=${encodeURIComponent(absolute)}${viewerHash}`;
}

function showPdf(pdfPath, page) {
  const resolvedPath = resolvePdfUrl(pdfPath);
  const hash = page ? `#page=${page}` : "#view=FitH";
  const src = frameSrc(resolvedPath, hash);
  const key = `pdf:${resolvedPath}`;
  const iframe = pdfFrame.querySelector("iframe.pdf-embed");

  if (currentViewKey === key && iframe) {
    if (iframe.getAttribute("src") !== src) iframe.src = src;
    return;
  }
  currentViewKey = key;
  pdfFrame.innerHTML =
    `<iframe class="pdf-embed" src="${escapeHtml(src)}" title="${escapeHtml(selectedBook.title)}"></iframe>`;
}

function resolvePdfUrl(path) {
  const value = String(path || "").trim();
  if (!value || /^(?:[a-z]+:)?\/\//i.test(value) || /^(?:data|blob):/i.test(value)) {
    return value;
  }
  if (!PDF_BASE_URL) return value;
  return `${PDF_BASE_URL}/${value.replace(/^\.?\//, "")}`;
}

// A local-only book's PDF is only reachable when the site runs on your machine.
function bookPdfAvailable(book) {
  if (!book.pdf) return false;
  if (book.resource && book.resource.kind === "local" && book.resource.access === "missing") {
    return false;
  }
  if (book.localOnly && !IS_LOCAL) return false;
  return true;
}

// Will this book display something inline in the reader (vs. just a source link)?
function rendersInline(book) {
  if (bookPdfAvailable(book)) return true;
  if (isPublicDriveFile(book)) return true;
  if (isRestrictedDriveFile(book) && drivePreviewEnabled()) return true;
  if (book.chapters && book.chapters.some((c) => c.pdf)) return true;
  if (book.folderItems && book.folderItems.some((item) => item.previewUrl)) return true;
  return false;
}

function showLocalOnly(book) {
  const sourceButton = book.sourceUrl
    ? `<a class="button primary" href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Open original source</a>`
    : "";
  renderFrame(`local:${book.id}`, `
    <div class="pdf-placeholder">
      <strong>Local-only sample</strong>
      <p><em>${escapeHtml(book.title)}</em> is a large demo file that is not hosted online. Run this project on your computer (<code>py -m http.server</code>) to read it here, or host each chapter as a small PDF for the live site.</p>
      ${sourceButton}
    </div>`);
}

// Convert a Google Drive "file" link into an inline-embeddable preview URL.
function driveEmbedUrl(url) {
  const match = String(url || "").match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  return match ? `https://drive.google.com/file/d/${match[1]}/preview` : null;
}

function isDriveFolderUrl(url) {
  return /drive\.google\.com\/(?:drive\/)?folders\//i.test(String(url || ""));
}

function accessInfo(book) {
  const hasHostedPdf =
    bookPdfAvailable(book) ||
    Boolean(book.chapters && book.chapters.some((chapter) => chapter.pdf));
  if (hasHostedPdf) return { kind: "hosted", label: "Hosted here" };
  const resource = book.resource || {};
  if (resource.access === "restricted") return { kind: "restricted", label: "Restricted" };
  if (resource.access === "missing") return { kind: "missing", label: "Missing" };
  if (resource.kind === "drive-file" && resource.access === "public") {
    return { kind: "drive", label: "Public preview" };
  }
  if (resource.kind === "drive-folder" && resource.access === "public") {
    return { kind: "folder", label: "Public folder" };
  }
  if (driveEmbedUrl(book.sourceUrl) && !resource.kind) {
    return { kind: "drive", label: "Public preview" };
  }
  if (isDriveFolderUrl(book.sourceUrl) && !resource.kind) {
    return { kind: "folder", label: "Public folder" };
  }
  if (book.sourceUrl) return { kind: "external", label: "External link" };
  return { kind: "unavailable", label: "Unavailable" };
}

function isPublicDriveFile(book) {
  const resource = book.resource || {};
  if (resource.kind === "drive-file") return resource.access === "public";
  return Boolean(driveEmbedUrl(book.sourceUrl));
}

/* ---------- restricted Drive files ---------- */

// `resource-meta.json` classifies access from an anonymous server-side check,
// so "restricted" means "not readable by a signed-out visitor" — not "not
// readable by this visitor". A signed-in Google account with access can see
// the same preview, because the Drive iframe carries the browser's session.
function isRestrictedDriveFile(book) {
  const resource = book.resource || {};
  return resource.access === "restricted" &&
    resource.kind === "drive-file" &&
    Boolean(driveEmbedUrl(book.sourceUrl));
}

// A remembered "I signed in, stop asking" choice. It is the visitor's own
// assertion, not a verified session — we cannot read a cross-origin iframe to
// confirm one, so the escape hatch below every preview matters.
function drivePreviewEnabled() {
  try {
    return localStorage.getItem(DRIVE_SIGNIN_KEY) === "1";
  } catch (e) {
    return drivePreviewFallback;
  }
}

function setDrivePreviewEnabled(enabled) {
  drivePreviewFallback = enabled;
  try {
    if (enabled) localStorage.setItem(DRIVE_SIGNIN_KEY, "1");
    else localStorage.removeItem(DRIVE_SIGNIN_KEY);
  } catch (e) { /* storage unavailable — the in-memory flag still applies */ }
}

function driveFileId(book) {
  const resource = book.resource || {};
  if (resource.kind === "drive-file" && resource.fileId) return resource.fileId;
  const match = String(book.sourceUrl || "").match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  return match ? match[1] : "";
}

// Anything Drive holds as a single file and the anonymous audit could not
// read. "missing" is included deliberately: Drive answers 404 for some files
// a signed-out visitor merely lacks permission to see, so the audit cannot
// tell a deleted file from a private one. A signed-in API call can.
function needsGoogleAuth(book) {
  const resource = book.resource || {};
  if (resource.access === "public") return false;
  if (resource.kind && resource.kind !== "drive-file") return false;
  return Boolean(driveFileId(book));
}

// Drive file IDs the reader has explicitly asked to open through the API
// rather than Drive's viewer, so a re-render does not bounce back to a frame
// that already failed. Keyed by file rather than book, because a folder entry
// holds many files and only one of them may be the problem.
const driveApiForced = new Set();

// True when a public file can be fetched with no sign-in at all, which an API
// key allows for "anyone with the link" files.
function driveCanReadPublic() {
  return Boolean(window.OpenBooksDrive && window.OpenBooksDrive.hasApiKey());
}

function driveCanFetch(publicFile) {
  return driveSignedIn() || (publicFile && driveCanReadPublic());
}

function driveFileSize(book) {
  return Number((book.resource || {}).size || 0);
}

// Known up front from the metadata sync, so an oversized book never has to
// fail in Drive's viewer first to find out.
function driveTooLargeToPreview(book) {
  const size = driveFileSize(book);
  return size > 0 && size > DRIVE_PREVIEW_LIMIT && Boolean(driveFileId(book));
}

function driveConfigured() {
  return Boolean(window.OpenBooksDrive && window.OpenBooksDrive.isConfigured());
}

function driveSignedIn() {
  return driveConfigured() && window.OpenBooksDrive.isSignedIn();
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Offered before embedding so a restricted file never renders as a bare
// Google error frame with no way forward.
function showSignInGate(book) {
  const driveButton = book.sourceUrl
    ? `<a class="button secondary" href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Open in Drive instead</a>`
    : "";

  if (driveConfigured()) {
    renderFrame(`signin:${book.id}`, `
      <div class="pdf-placeholder pdf-gate">
        <strong>Sign in to open this material</strong>
        <p><em>${escapeHtml(book.title)}</em> is shared with specific Google accounts. Sign in with an account that has access and it opens right here — this route works even in browsers that block Drive's own preview frame.</p>
        <div class="gate-actions">
          <button class="button primary" type="button" data-action="google-signin">Sign in with Google</button>
          ${driveButton}
        </div>
      </div>`);
    return;
  }

  // No client ID configured — fall back to Drive's cookie-based preview.
  renderFrame(`signin-basic:${book.id}`, `
    <div class="pdf-placeholder pdf-gate">
      <strong>Sign in to preview this material</strong>
      <p><em>${escapeHtml(book.title)}</em> is shared with specific Google accounts. Open it in Drive once to sign in (or to request access), then come back and the preview loads right here.</p>
      <div class="gate-actions">
        <a class="button primary" href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Sign in / open in Drive</a>
        <button class="button secondary" type="button" data-action="enable-drive-preview">I am signed in — show the preview</button>
      </div>
    </div>`);
}

function driveUsesApi(book) {
  return driveApiForced.has(driveFileId(book)) || driveTooLargeToPreview(book);
}

// Shown when Drive cannot render a public file and nobody is signed in to
// fetch it another way. It states the size rather than letting Google's
// viewer fail first with no explanation.
function showTooLargeGate(book, label, size) {
  const title = label || book.title;
  const bytes = size || driveFileSize(book);
  const sizeText = bytes ? ` (${formatBytes(bytes)})` : "";
  const signIn = driveConfigured()
    ? '<button class="button primary" type="button" data-action="google-signin">Sign in with Google to open it here</button>'
    : "";
  showDriveMessage(book, `toobig:${book.id}:${title}`, "Too large for Google's preview",
    `<em>${escapeHtml(title)}</em>${escapeHtml(sizeText)} is past the size Drive's own viewer will display, so it cannot be shown in a Drive frame. Signing in lets the reader fetch the file directly and open it here instead.`,
    signIn + driveLinkButton(book, "Download from Drive"));
}

function showDriveMessage(book, key, heading, message, actions) {
  renderFrame(`${key}:${book.id}`, `
    <div class="pdf-placeholder pdf-gate">
      <strong>${heading}</strong>
      <p>${message}</p>
      ${actions ? `<div class="gate-actions">${actions}</div>` : ""}
    </div>`);
}

// Async work races the reader: a visitor can pick another book mid-download,
// so every render checks it is still the newest request before painting.
let driveRequestId = 0;

function showAuthorisedDrive(book, page) {
  openDriveFile(book, driveFileId(book), book.title, page, isPublicDriveFile(book));
}

function openDriveFile(book, fileId, label, page, publicFile) {
  const request = ++driveRequestId;
  const current = selectedBook;

  if (activeDriveFile && activeDriveFile.fileId === fileId) {
    showBlobPdf(book, activeDriveFile.url, page);
    return;
  }

  showDriveMessage(book, `drive-checking-${fileId}`, "Opening…",
    `Asking Google Drive for <em>${escapeHtml(label)}</em>.`);

  window.OpenBooksDrive.fileMeta(fileId, publicFile).then((meta) => {
    if (request !== driveRequestId || selectedBook !== current) return;

    if (!meta.canDownload) {
      showDriveMessage(book, "drive-nodownload", "This file is view-only",
        "The owner has disabled downloading, so it cannot be opened here. Drive's own viewer can still show it.",
        driveLinkButton(book, "Open in Drive"));
      return;
    }
    if (meta.mimeType && meta.mimeType !== "application/pdf") {
      showDriveMessage(book, "drive-notpdf", "Not a PDF",
        `Drive reports this file as <code>${escapeHtml(meta.mimeType)}</code>, which the reader cannot display.`,
        driveLinkButton(book, "Open in Drive"));
      return;
    }

    // The download starts on its own. Asking first made every large book cost
    // an extra click to say yes to something the reader had already chosen by
    // opening it, and the wait began only after that click.
    // Stopping one is still the reader's call, so the progress panel carries a
    // cancel button rather than a confirmation coming before it.
    if (driveCancelled.has(fileId)) {
      showDriveStopped(book, fileId, meta, label, publicFile);
      return;
    }

    loadDriveFile(book, fileId, page, meta, publicFile);
  }).catch((error) => {
    if (request !== driveRequestId || selectedBook !== current) return;
    showDriveError(book, error);
  });
}

function driveLinkButton(book, label) {
  return book.sourceUrl
    ? `<a class="button secondary" href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : "";
}

function showDriveError(book, error) {
  const code = error && error.code;
  if (code === "signedout") {
    showSignInGate(book);
    return;
  }
  const account = driveAccountLabel();
  if (code === "forbidden" || code === "notfound") {
    // Anonymous reads go through the API key, so a refusal there says nothing
    // about any account — pointing at one would send the reader hunting in the
    // wrong place.
    if (!driveSignedIn()) {
      showDriveMessage(book, `drive-${code}-anon`, "Could not read this file",
        `${escapeHtml(error.message)} It may not be shared publicly, or the API key may not be permitted on this site. Signing in with an account that has access is the surest route.`,
        (driveConfigured()
          ? '<button class="button primary" type="button" data-action="google-signin">Sign in with Google</button>'
          : "") + driveLinkButton(book, "Open in Drive"));
      return;
    }
    showDriveMessage(book, `drive-${code}`, "No access with this account",
      `${escapeHtml(error.message)}${account ? ` You are signed in as ${escapeHtml(account)}.` : ""} Open it in Drive to request access, or switch to an account that already has it.`,
      driveLinkButton(book, "Request access in Drive") +
      '<button class="button secondary" type="button" data-action="google-switch">Use a different account</button>');
    return;
  }
  showDriveMessage(book, "drive-error", "Could not open this file",
    escapeHtml((error && error.message) || "Google Drive did not respond."),
    `<button class="button primary" type="button" data-action="drive-retry">Try again</button>` +
    driveLinkButton(book, "Open in Drive"));
}

function driveAccountLabel() {
  const user = driveConfigured() ? window.OpenBooksDrive.getUser() : null;
  return user ? (user.email || user.name || "") : "";
}

// Shown after the reader stops a download, and kept sticky for that file: a
// re-render must not quietly start the transfer they just stopped.
function showDriveStopped(book, fileId, meta, label, publicFile) {
  const size = (meta && meta.size) || driveFileSize(book);
  const name = (meta && meta.name) || label || book.title;
  showDriveMessage(book, `drive-stopped-${fileId}`, "Download stopped",
    `<em>${escapeHtml(name)}</em>${size ? ` is ${escapeHtml(formatBytes(size))} and` : ""} was not finished, so there is nothing to display yet.`,
    `<button class="button primary" type="button" data-action="drive-load" data-file="${escapeHtml(fileId)}" data-public="${publicFile ? "1" : ""}">Download again${size ? ` (${escapeHtml(formatBytes(size))})` : ""}</button>` +
    driveLinkButton(book, "Open in Drive instead"));
}

function loadDriveFile(book, fileId, page, meta, publicFile) {
  const request = ++driveRequestId;
  const current = selectedBook;
  const total = (meta && meta.size) || driveFileSize(book);

  // Only one download runs at a time, so a newer one stops the old transfer
  // instead of leaving both pulling bytes.
  cancelDriveDownload();
  const controller = new AbortController();
  driveDownload = { fileId, controller, request };
  driveCancelled.delete(fileId);

  // Holding a very large file in memory is heavy on a small device, so the
  // warning that used to block the download now rides along with it.
  const caution = total > DRIVE_HEAVY_LIMIT
    ? `<span class="drive-caution">A file this size needs a lot of memory. If the tab struggles, open it in Drive instead.</span>`
    : "";

  showDriveMessage(book, `drive-loading-${fileId}`, "Opening…",
    `<span id="driveProgress">Downloading ${escapeHtml(meta && meta.name ? meta.name : book.title)}${total ? ` (${escapeHtml(formatBytes(total))})` : ""}…</span>` +
    `<span class="drive-bar" aria-hidden="true"><span id="driveBar"></span></span>${caution}`,
    `<button class="button secondary" type="button" data-action="drive-cancel">Cancel</button>` +
    driveLinkButton(book, "Open in Drive instead"));

  const onProgress = (received, size) => {
    if (request !== driveRequestId) return;
    const label = document.querySelector("#driveProgress");
    if (!label) return;
    const cap = size || total;
    const pct = cap ? Math.round((received / cap) * 100) : 0;
    label.textContent = cap
      ? `Downloading… ${pct}% of ${formatBytes(cap)}`
      : `Downloading… ${formatBytes(received)}`;
    const bar = document.querySelector("#driveBar");
    if (bar && cap) bar.style.width = `${pct}%`;
  };

  window.OpenBooksDrive.fileBlobUrl(fileId, onProgress, publicFile, controller.signal).then((url) => {
    if (request !== driveRequestId || selectedBook !== current) {
      URL.revokeObjectURL(url); // a newer selection won this race
      return;
    }
    driveDownload = null;
    releaseDriveFile();
    activeDriveFile = { fileId, url };
    showBlobPdf(book, url, page);
  }).catch((error) => {
    if (request !== driveRequestId || selectedBook !== current) return;
    driveDownload = null;
    // A cancel is the reader's own doing, not a failure to report as one.
    if (error && error.name === "AbortError") {
      showDriveStopped(book, fileId, meta, book.title, publicFile);
      return;
    }
    showDriveError(book, error);
  });
}

// The transfer in flight, so it can be stopped when the reader cancels or
// moves to another book.
let driveDownload = null;
// Files whose download the reader stopped; they are not restarted on their own.
const driveCancelled = new Set();

function cancelDriveDownload() {
  if (!driveDownload) return null;
  const { fileId, controller } = driveDownload;
  driveDownload = null;
  controller.abort();
  return fileId;
}

// One blob at a time: these books run to hundreds of megabytes, so the
// previous object URL is released before another is held.
function releaseDriveFile() {
  if (!activeDriveFile) return;
  URL.revokeObjectURL(activeDriveFile.url);
  activeDriveFile = null;
}

function showBlobPdf(book, url, page) {
  const src = frameSrc(url, page ? `#page=${page}` : "#view=FitH");
  const key = `blob:${url}`;
  const iframe = pdfFrame.querySelector("iframe.pdf-embed");
  const account = driveAccountLabel();
  const hint =
    `Opened from Google Drive${account ? ` as ${escapeHtml(account)}` : ""}. ` +
    `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open in a new tab</a>` +
    (book.sourceUrl
      ? ` &middot; <a href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">View in Drive</a>`
      : "");

  if (currentViewKey === key && iframe) {
    if (iframe.getAttribute("src") !== src) iframe.src = src;
    return;
  }
  currentViewKey = key;
  pdfFrame.innerHTML =
    `<iframe class="pdf-embed" src="${escapeHtml(src)}" title="${escapeHtml(book.title)}"></iframe>` +
    `<p class="pdf-hint">${hint}</p>`;
}

// Show an embeddable source (currently Google Drive preview) inline in the reader.
function showEmbed(book, page, restricted) {
  const embedBase = driveEmbedUrl(book.sourceUrl);
  const embed = embedBase && page ? `${embedBase}#page=${page}` : embedBase;
  if (!embed) {
    showNoPdf(book);
    return false;
  }

  const pageHint = page
    ? ` This section starts on page ${escapeHtml(page)}; use Drive's page control if it does not jump automatically.`
    : "";
  // A cross-origin frame cannot report failure to us, so restricted files
  // always carry a way out rather than leaving the visitor at a blank frame.
  // Drive can decline to render for reasons the catalog cannot predict, and a
  // cross-origin frame never tells us it failed — so the way out is always on
  // screen rather than waiting for us to detect trouble.
  const openHere = driveConfigured() || driveCanReadPublic()
    ? ` Not loading, or does Drive say it is too large? <button class="link-button" type="button" data-action="drive-open-here" data-file="${escapeHtml(driveFileId(book))}">Open it here instead</button>.`
    : "";
  const hint = restricted
    ? `Preview shown for the Google account signed in to this browser.${pageHint} Blank or asking you to sign in? <a href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Open in Drive</a> to sign in or request access, or <button class="link-button" type="button" data-action="reset-drive-preview">use a different account</button>.`
    : `Displayed from Google Drive.${pageHint} <a href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Open in Drive</a> to download.${openHere}`;

  renderFrame(`embed:${embed}:${restricted ? "auth" : "public"}`, `
    <iframe class="pdf-embed" src="${escapeHtml(embed)}" title="${escapeHtml(book.title)}" allow="autoplay" allowfullscreen></iframe>
    <p class="pdf-hint">${hint}</p>`);
  return true;
}

function showFolderItem(book, item) {
  const preview = item.previewUrl || driveEmbedUrl(item.url);
  const fileId = item.fileId || "";
  const size = Number(item.size || 0);
  const tooLarge = size > DRIVE_PREVIEW_LIMIT;

  // Folder children carry their own size (the metadata sync resolves each one
  // through the Drive API), so an oversized child skips Drive's viewer exactly
  // as a catalogued book does instead of failing inside it first.
  if (fileId && (tooLarge || driveApiForced.has(fileId))) {
    if (driveCanFetch(true)) {
      openDriveFile(book, fileId, item.title, null, true);
      return;
    }
    if (tooLarge) {
      showTooLargeGate(book, item.title, size);
      return;
    }
  }

  if (preview) {
    const openHere = fileId && (driveConfigured() || driveCanReadPublic())
      ? ` Not loading, or too large for Drive to preview? <button class="link-button" type="button" data-action="drive-open-here" data-file="${escapeHtml(fileId)}">Open it here instead</button>.`
      : "";
    renderFrame(`folder:${preview}`, `
      <iframe class="pdf-embed" src="${escapeHtml(preview)}" title="${escapeHtml(item.title)}" allow="autoplay" allowfullscreen></iframe>
      <p class="pdf-hint">Public file from <em>${escapeHtml(book.title)}</em>. <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open in Drive</a>.${openHere}</p>`);
    return;
  }
  renderFrame(`folder-item:${book.id}:${item.fileId || item.title}`, `
    <div class="pdf-placeholder">
      <strong>${escapeHtml(item.title)}</strong>
      <p>This folder item is not a PDF preview. Open it in Google Drive to view it.</p>
      ${item.url ? `<a class="button primary" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open in Drive</a>` : ""}
    </div>`);
}

function showNoPdf(book) {
  const isFolder = isDriveFolderUrl(book.sourceUrl);
  const access = accessInfo(book);
  const sourceButton = book.sourceUrl
    ? `<a class="button primary" href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">${isFolder ? "Open folder in Drive" : "Open original source"}</a>`
    : "";
  let heading = isFolder ? "This resource is a Google Drive folder" : "No hosted PDF yet";
  let message = isFolder
    ? `No public child files were found for <em>${escapeHtml(book.title)}</em>.`
    : `Open <em>${escapeHtml(book.title)}</em> at its original source.`;
  if (access.kind === "restricted") {
    // Restricted single files are handled by the sign-in gate; what lands here
    // is mostly folders, which Drive will not embed at any permission level.
    heading = "Sign in to open this resource";
    message = isFolder
      ? "This Drive folder is shared with specific Google accounts, and folders cannot be embedded here. Open it in Drive with an account that has access."
      : "This Drive resource is shared with specific Google accounts. Open it in Drive with an account that has access, or request access there.";
  } else if (access.kind === "missing") {
    heading = "Source is missing";
    message = "The catalogued source returned a missing-file response and may have been deleted or moved.";
  }
  renderFrame(`none:${book.id}:${access.kind}`, `
    <div class="pdf-placeholder">
      <strong>${heading}</strong>
      <p>${message}</p>
      ${sourceButton}
    </div>`);
}

/* ---------- reader rendering ---------- */

function wholeBookStatus(book, hasChapters) {
  if (bookPdfAvailable(book)) return hasChapters ? "Complete book" : book.pdf;
  if (book.localOnly) return "Local-only sample";
  // Reading from the fetched copy, not Drive's frame — say so, since the two
  // behave differently the moment a chapter is clicked.
  if (activeDriveFile && activeDriveFile.fileId === driveFileId(book)) {
    const account = driveAccountLabel();
    return account ? `Opened from Google Drive · ${account}` : "Opened from Google Drive";
  }
  if (isPublicDriveFile(book) && driveUsesApi(book)) {
    const account = driveAccountLabel();
    if (driveSignedIn()) return account ? `Google Drive · ${account}` : "Opened from Google Drive";
    if (driveCanReadPublic()) return "Opened from Google Drive";
    const size = driveFileSize(book);
    return size ? `${formatBytes(size)} — too large for Drive's preview` : "Too large for Drive's preview";
  }
  if (isPublicDriveFile(book)) return "Displayed from Google Drive";
  if (driveConfigured() && needsGoogleAuth(book)) {
    const account = driveAccountLabel();
    if (driveSignedIn()) return account ? `Google Drive · ${account}` : "Opened from Google Drive";
    return "Sign in with Google to open this material";
  }
  if (isRestrictedDriveFile(book)) {
    return drivePreviewEnabled()
      ? "Drive preview — needs a signed-in account with access"
      : "Sign in to Google to preview this material";
  }
  if (isDriveFolderUrl(book.sourceUrl)) return "Google Drive folder — open it to choose a file";
  return book.sourceUrl ? "Open original source to view or download" : "No PDF linked yet";
}

function showWholeBook(book, page) {
  if (bookPdfAvailable(book)) {
    showPdf(book.pdf, page || null);
    return;
  }
  if (book.localOnly) {
    showLocalOnly(book);
    return;
  }

  const fileId = driveFileId(book);

  // Already downloaded: keep reading from it rather than dropping back to the
  // Drive frame, which would throw the file away and lose page jumps again.
  if (fileId && activeDriveFile && activeDriveFile.fileId === fileId) {
    showBlobPdf(book, activeDriveFile.url, page);
    return;
  }

  // A page anchor only lands in a viewer we control. Drive's preview frame
  // ignores #page=, so a chapter click there moves nothing and reads as a
  // broken button — the chapter number is right, the viewer just will not act
  // on it. Fetching the file gives a viewer that does, so asking for a page is
  // itself the reason to take the slower route.
  if (page && chapterPicked && fileId && driveCanFetch(isPublicDriveFile(book))) {
    showAuthorisedDrive(book, page);
    return;
  }

  if (isPublicDriveFile(book) && driveUsesApi(book)) {
    // Public, but Drive's viewer will not render it — fetch it ourselves.
    // An API key covers this without anyone signing in.
    if (driveCanFetch(true)) showAuthorisedDrive(book, page);
    else showTooLargeGate(book);
  } else if (isPublicDriveFile(book)) {
    // Public and within Drive's limits — the free frame beats a download.
    showEmbed(book, page);
  } else if (driveSignedIn() && needsGoogleAuth(book)) {
    showAuthorisedDrive(book, page);
  } else if (driveConfigured() && needsGoogleAuth(book)) {
    showSignInGate(book);
  } else if (isRestrictedDriveFile(book)) {
    if (drivePreviewEnabled()) showEmbed(book, page, true);
    else showSignInGate(book);
  } else {
    showNoPdf(book);
  }
}

function renderReaderView() {
  const book = selectedBook;
  if (!book) return;
  const collection = readerCollection(book);
  const hasItems = collection.items.length > 0;
  persistSelection();

  if (hasItems) {
    chapterList.querySelectorAll(".chapter-button").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.index) === selectedChapterIndex);
    });
    prevChapter.disabled = selectedChapterIndex === null || selectedChapterIndex === 0;
    nextChapter.disabled =
      selectedChapterIndex !== null && selectedChapterIndex === collection.items.length - 1;
  }

  // Reference outline: the document never changes, only the label does.
  if (collection.mode === "syllabus") {
    const item = selectedChapterIndex !== null ? collection.items[selectedChapterIndex] : null;
    readerFileTitle.textContent = item ? item.title : book.title;
    readerFileStatus.textContent = item
      ? `Chapter ${selectedChapterIndex + 1} of ${collection.items.length} — no page link, search the document for it`
      : wholeBookStatus(book, false);
    showWholeBook(book);
    return;
  }

  if (hasItems && selectedChapterIndex !== null) {
    const item = collection.items[selectedChapterIndex];
    readerFileTitle.textContent = item.title;
    readerFileStatus.textContent = collection.mode === "folder"
      ? `File ${selectedChapterIndex + 1} of ${collection.items.length}`
      : `Section ${selectedChapterIndex + 1} of ${collection.items.length}${item.page ? ` · starts page ${item.page}` : ""}`;

    if (collection.mode === "folder") {
      showFolderItem(book, item);
    } else if (item.pdf) {
      showPdf(item.pdf, item.page);
    } else {
      showWholeBook(book, item.page);
    }
    return;
  }

  // Complete book / no chapters.
  readerFileTitle.textContent = book.title;
  readerFileStatus.textContent = wholeBookStatus(book, collection.mode === "chapters");
  showWholeBook(book);
}

function renderReader() {
  if (!selectedBook) return;
  const book = selectedBook;
  const collection = readerCollection(book);

  readerTitle.textContent = book.title;
  readerMeta.textContent = [book.subject, `Class ${book.class}`, book.wing, book.language, book.year]
    .filter(Boolean)
    .join(" | ");

  renderFacts(book);

  sourceLink.hidden = !book.sourceUrl;
  if (book.sourceUrl) {
    sourceLink.href = book.sourceUrl;
    sourceLink.textContent = isDriveFolderUrl(book.sourceUrl)
      ? "Open folder in Drive"
      : "Open original source";
  }

  completeBook.hidden = !(
    collection.mode === "chapters" &&
    collection.items.length &&
    (bookPdfAvailable(book) || isPublicDriveFile(book))
  );

  renderChapterList(book);
  renderReaderView();
}

/* ---------- events ---------- */

function bindEvents() {
  FILTERS.forEach((filter) => {
    filter.el.addEventListener("change", () => {
      filter.active = filter.el.value;
      renderBooks();
    });
  });

  searchInput.addEventListener("input", renderBooks);

  clearFilters.addEventListener("click", () => {
    FILTERS.forEach((filter) => {
      filter.active = "All";
      filter.el.value = "All";
    });
    searchInput.value = "";
    renderBooks();
  });

  completeBook.addEventListener("click", () => {
    selectedChapterIndex = null;
    renderReaderView();
    if (isMobile()) closeSheet();
  });

  toggleSidebar.addEventListener("click", () => {
    if (isMobile()) {
      if (sheetOpen()) closeSheet();
      else openSheet();
      return;
    }
    readerShell.classList.toggle("collapsed");
    syncSidebarToggle();
  });

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      closeSheet();
      setView(tab.dataset.view);
    });
  });

  backToLibrary.addEventListener("click", () => {
    closeSheet();
    setView("library");
  });

  sheetClose.addEventListener("click", closeSheet);
  sheetScrim.addEventListener("click", closeSheet);

  // The viewer's contents are re-rendered, so its controls are delegated.
  pdfFrame.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    handleViewerAction(trigger.dataset.action, trigger);
  });

  googleAuthBtn.addEventListener("click", () => {
    if (driveSignedIn()) startGoogleSignOut();
    else startGoogleSignIn();
  });

  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (readerPanel.requestFullscreen) {
      readerPanel.requestFullscreen();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const on = Boolean(document.fullscreenElement);
    fullscreenBtn.innerHTML = on
      ? "&#10005; <span>Exit fullscreen</span>"
      : "&#9974; <span>Fullscreen</span>";
  });

  chapterSearch.addEventListener("input", () => filterChapters(chapterSearch.value));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sheetOpen()) {
      closeSheet();
      return;
    }
    const tag = document.activeElement ? document.activeElement.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!selectedBook || !readerCollection(selectedBook).items.length) return;

    if (event.key === "ArrowLeft" && !prevChapter.disabled) {
      event.preventDefault();
      prevChapter.click();
    } else if (event.key === "ArrowRight" && !nextChapter.disabled) {
      event.preventDefault();
      nextChapter.click();
    }
  });

  prevChapter.addEventListener("click", () => {
    if (selectedChapterIndex === null) selectedChapterIndex = 0;
    selectedChapterIndex = Math.max(0, selectedChapterIndex - 1);
    chapterPicked = true;
    renderReaderView();
    scrollActiveChapterIntoView();
  });

  nextChapter.addEventListener("click", () => {
    const total = readerCollection(selectedBook).items.length;
    if (selectedChapterIndex === null) selectedChapterIndex = -1;
    selectedChapterIndex = Math.min(total - 1, selectedChapterIndex + 1);
    chapterPicked = true;
    renderReaderView();
    scrollActiveChapterIntoView();
  });

  // Layout follows the viewport, not a one-time guess at the device.
  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener("change", syncLayout);
  } else if (mobileQuery.addListener) {
    mobileQuery.addListener(syncLayout); // Safari < 14
  }
  window.addEventListener("resize", measureChrome);
  window.addEventListener("orientationchange", syncLayout);
  if (window.ResizeObserver && topbar) {
    new ResizeObserver(measureChrome).observe(topbar);
  }
}

/* ---------- Google sign-in ---------- */

function handleViewerAction(action, trigger) {
  if (action === "enable-drive-preview" || action === "reset-drive-preview") {
    setDrivePreviewEnabled(action === "enable-drive-preview");
    currentViewKey = null; // force the viewer to swap between gate and preview
    renderReaderView();
    return;
  }
  if (action === "google-signin" || action === "google-switch") {
    startGoogleSignIn(action === "google-switch" ? "switch" : "");
    return;
  }
  if (action === "drive-open-here" && selectedBook) {
    // Recorded before any sign-in, so the re-render that follows does not fall
    // straight back to the Drive frame the reader just rejected.
    driveApiForced.add(trigger.dataset.file || driveFileId(selectedBook));
    if (driveCanFetch(true)) {
      currentViewKey = null;
      renderReaderView();
    } else {
      startGoogleSignIn();
    }
    return;
  }
  if (action === "drive-retry") {
    currentViewKey = null;
    renderReaderView();
    return;
  }
  if (action === "drive-cancel") {
    const stopped = cancelDriveDownload();
    // Remembered so the re-render that follows does not start it again; the
    // reader asked for it to stop, and a fresh click is what undoes that.
    if (stopped) driveCancelled.add(stopped);
    return;
  }
  if (action === "drive-load" && selectedBook) {
    const fileId = trigger.dataset.file;
    driveCancelled.delete(fileId);
    loadDriveFile(selectedBook, fileId, currentChapterPage(), null,
      trigger.dataset.public === "1");
  }
}

// The page anchor of whatever is selected, so a resumed download lands there.
function currentChapterPage() {
  if (!selectedBook || selectedChapterIndex === null) return null;
  const collection = readerCollection(selectedBook);
  if (collection.mode !== "chapters") return null;
  const item = collection.items[selectedChapterIndex];
  return item ? item.page || null : null;
}

function startGoogleSignIn(mode) {
  if (!driveConfigured()) return;
  setAuthBusy(true);
  window.OpenBooksDrive.signIn(mode)
    .catch((error) => {
      // Deliberately narrow: only a cancellation by someone who has signed in
      // before is silent. A first-attempt failure is far more likely to be
      // configuration than a change of mind, so it gets explained.
      if (error && error.code === "cancelled") return;
      showAuthProblem(error);
    })
    .finally(() => setAuthBusy(false));
}

function startGoogleSignOut() {
  window.OpenBooksDrive.signOut();
  releaseDriveFile();
}

function setAuthBusy(busy) {
  googleAuthBtn.disabled = busy;
  if (busy) googleAuthBtn.textContent = "Signing in…";
  else syncAuthButton();
}

function showAuthProblem(error) {
  if (!selectedBook) return;
  showDriveMessage(selectedBook, "auth-error", "Google sign-in did not complete",
    escapeHtml((error && error.message) || "Sign-in failed."),
    '<button class="button primary" type="button" data-action="google-signin">Try again</button>' +
    driveLinkButton(selectedBook, "Open in Drive"));
}

function syncAuthButton() {
  if (!driveConfigured()) {
    googleAuthBtn.hidden = true;
    return;
  }
  googleAuthBtn.hidden = false;
  googleAuthBtn.disabled = false;
  if (driveSignedIn()) {
    const account = driveAccountLabel();
    googleAuthBtn.textContent = account ? `Sign out (${account})` : "Sign out of Google";
    googleAuthBtn.classList.add("signed-in");
    googleAuthBtn.title = "Signed in to Google Drive";
  } else {
    googleAuthBtn.textContent = "Sign in with Google";
    googleAuthBtn.classList.remove("signed-in");
    googleAuthBtn.title = "Sign in to open Drive files shared with your account";
  }
  measureChrome();
}

/* ---------- welcome prompt ---------- */

function welcomeDismissed() {
  try {
    return localStorage.getItem(WELCOME_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function rememberWelcomeDismissed() {
  try {
    localStorage.setItem(WELCOME_KEY, "1");
  } catch (e) { /* storage unavailable */ }
}

function shouldShowWelcome() {
  if (!driveConfigured() || !welcomeDialog || !welcomeDialog.showModal) return false;
  if (driveSignedIn()) return false;
  // Someone who signed in before expects to still be signed in, so a failed
  // silent restore brings the prompt back even if it was dismissed once.
  if (window.OpenBooksDrive.wasSignedIn()) return true;
  return !welcomeDismissed();
}

function showWelcome() {
  if (!shouldShowWelcome() || welcomeDialog.open) return;
  welcomeError.hidden = true;
  try {
    welcomeDialog.showModal();
  } catch (e) { /* older browsers simply keep the top-bar button */ }
}

function closeWelcome() {
  if (welcomeDialog && welcomeDialog.open) welcomeDialog.close();
}

function bindWelcome() {
  if (!welcomeDialog) return;

  welcomeSignIn.addEventListener("click", () => {
    welcomeError.hidden = true;
    welcomeSignIn.disabled = true;
    welcomeSignIn.textContent = "Signing in…";
    window.OpenBooksDrive.signIn()
      .then(() => {
        rememberWelcomeDismissed();
        closeWelcome();
      })
      .catch((error) => {
        // Kept in the dialog: this is where a misconfigured origin shows up,
        // and hiding it behind a closing panel would waste the one moment
        // the reader is looking.
        welcomeError.hidden = false;
        welcomeError.textContent = (error && error.message) || "Sign-in failed.";
      })
      .finally(() => {
        welcomeSignIn.disabled = false;
        welcomeSignIn.textContent = "Sign in with Google";
      });
  });

  welcomeSkip.addEventListener("click", () => {
    rememberWelcomeDismissed();
    closeWelcome();
  });

  // Esc counts as declining, so the prompt does not reappear next visit.
  welcomeDialog.addEventListener("cancel", rememberWelcomeDismissed);
}

function setupGoogleAuth() {
  if (!driveConfigured()) {
    googleAuthBtn.hidden = true;
    return;
  }
  window.OpenBooksDrive.onChange(() => {
    syncAuthButton();
    closeWelcome();
    currentViewKey = null; // access changed — re-resolve whatever is open
    renderReaderView();
  });
  syncAuthButton();
  bindWelcome();

  // A returning reader is re-authorised without a prompt where the browser
  // still allows it. The welcome prompt waits for that to settle so it never
  // flashes in front of someone who is already signed in.
  if (window.OpenBooksDrive.wasSignedIn()) {
    window.OpenBooksDrive.restore().then(showWelcome, showWelcome);
  } else {
    showWelcome();
  }
}

function scrollActiveChapterIntoView() {
  const active = chapterList.querySelector(".chapter-button.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

/* ---------- data ---------- */

async function fetchJson(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function loadBooks() {
  const [catalog, metadata, map] = await Promise.all([
    fetchJson(CATALOG_URL),
    fetchJson(RESOURCE_META_URL),
    fetchJson(CHAPTER_MAP_URL)
  ]);

  chapterMap = map;

  if (!catalog) {
    books = fallbackBooks.map(withDerivedChapters);
    dataNotice.hidden = false;
    dataNotice.textContent =
      "Using built-in sample data. Run the folder through a local server so books.json can load (see README).";
    return;
  }

  const resources = (metadata && metadata.resources) || {};
  resourceSummary = (metadata && metadata.summary) || null;

  books = catalog.map((book) => {
    const resource = resources[book.id] || {};
    return withDerivedChapters({
      ...book,
      resource,
      chapters: book.chapters && book.chapters.length
        ? book.chapters
        : (resource.chapters || []),
      // Only extracted chapters carry a source; hand-authored ones are named
      // by definition, so they must not inherit the extractor's label.
      chapterSource: book.chapters && book.chapters.length
        ? "authored"
        : (resource.chapterSource || ""),
      folderItems: resource.folderItems || []
    });
  });
  dataNotice.hidden = true;
}

function withDerivedChapters(book) {
  const hasReal = Boolean(
    (book.chapters && book.chapters.length) ||
    (book.folderItems && book.folderItems.length)
  );
  if (hasReal) return book;
  const syllabus = buildSyllabusChapters(book);
  return { ...book, syllabusChapters: syllabus.items, syllabusLabel: syllabus.label };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setupInstall() {
  const installBtn = document.querySelector("#installBtn");
  const iosHint = document.querySelector("#iosHint");
  const iosHintClose = document.querySelector("#iosHintClose");
  if (!installBtn) return;

  let deferredPrompt = null;

  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (isStandalone()) return; // already installed — no button needed

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installBtn.hidden = false;
    measureChrome();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installBtn.hidden = true;
    if (iosHint) iosHint.hidden = true;
  });

  // iOS has no install prompt — show the button so we can display instructions.
  if (isIos()) installBtn.hidden = false;

  installBtn.addEventListener("click", async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.hidden = true;
    } else if (isIos() && iosHint) {
      iosHint.hidden = !iosHint.hidden;
    }
  });

  if (iosHintClose && iosHint) {
    iosHintClose.addEventListener("click", () => {
      iosHint.hidden = true;
    });
  }
}

async function init() {
  FILTERS.forEach((filter) => {
    filter.el = document.querySelector(`#${filter.key}Filter`);
  });

  await loadBooks();

  const initial = readInitialSelection();
  if (initial) {
    selectedBook = initial.book;
    selectedChapterIndex = initial.index;
  } else {
    // Land on the first book that will actually render in this environment
    // (a reachable local PDF, or an embeddable Drive file), else just the first book.
    selectedBook = books.find(rendersInline) || books[0] || null;
    const collection = readerCollection(selectedBook);
    selectedChapterIndex = collection.navigable && collection.items.length ? 0 : null;
  }

  setupFilters();
  bindEvents();
  setupInstall();
  setupGoogleAuth();
  setView(isMobile() && initial ? "reader" : "library");
  if (isMobile()) filterPanel.open = false;
  syncLayout();
  renderBooks();
  renderReader();
}

init();
