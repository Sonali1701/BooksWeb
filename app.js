const CATALOG_URL = "books.json";

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
  { key: "year", el: null, active: "All" }
];

let books = [];
let selectedBook = null;
let selectedChapterIndex = null; // null = complete book / single PDF
let currentPdfPath = null;

// Books flagged localOnly (large local demo files) only render when running locally.
const IS_LOCAL = ["localhost", "127.0.0.1", ""].includes(location.hostname);

const bookGrid = document.querySelector("#bookGrid");
const searchInput = document.querySelector("#searchInput");
const dataNotice = document.querySelector("#dataNotice");
const resultCount = document.querySelector("#resultCount");
const clearFilters = document.querySelector("#clearFilters");

const readerTitle = document.querySelector("#reader-title");
const readerMeta = document.querySelector("#readerMeta");
const readerFacts = document.querySelector("#readerFacts");
const sourceLink = document.querySelector("#sourceLink");
const completeBook = document.querySelector("#completeBook");
const contents = document.querySelector("#contents");
const chapterCount = document.querySelector("#chapterCount");
const chapterSearch = document.querySelector("#chapterSearch");
const chapterList = document.querySelector("#chapterList");
const prevChapter = document.querySelector("#prevChapter");
const nextChapter = document.querySelector("#nextChapter");
const toggleSidebar = document.querySelector("#toggleSidebar");
const fullscreenBtn = document.querySelector("#fullscreenBtn");
const readerShell = document.querySelector(".reader-shell");
const readerPanel = document.querySelector(".reader-panel");
const readerFileTitle = document.querySelector("#readerFileTitle");
const readerFileStatus = document.querySelector("#readerFileStatus");
const pdfFrame = document.querySelector("#pdfFrame");

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

/* ---------- filters ---------- */

function sortValues(key, values) {
  if (key === "class") {
    const order = { "11": 1, "12": 2, "11 & 12": 3 };
    return values.sort((a, b) => (order[a] || 99) - (order[b] || 99) || a.localeCompare(b));
  }
  if (key === "year") {
    return values.sort((a, b) => b.localeCompare(a));
  }
  return values.sort((a, b) => a.localeCompare(b));
}

function uniqueValues(key) {
  const values = [...new Set(books.map((book) => book[key]).filter(Boolean))];
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

function filtersActive() {
  return FILTERS.some((f) => f.active !== "All") || searchInput.value.trim() !== "";
}

function bookMatchesFilters(book, query) {
  const searchable = [
    book.title, book.subject, book.class, book.wing,
    book.language, book.year, book.description, book.author, book.publication
  ].join(" ").toLowerCase();

  const passesFilters = FILTERS.every(
    (filter) => filter.active === "All" || book[filter.key] === filter.active
  );

  return passesFilters && searchable.includes(query);
}

/* ---------- catalog ---------- */

function renderBooks() {
  const query = searchInput.value.trim().toLowerCase();
  const filteredBooks = books.filter((book) => bookMatchesFilters(book, query));

  resultCount.textContent = `${filteredBooks.length} of ${books.length} materials`;
  clearFilters.hidden = !filtersActive();

  bookGrid.innerHTML = "";

  if (!filteredBooks.length) {
    bookGrid.innerHTML =
      '<p class="empty-state">No materials found. Try a different subject, class, wing, language, year, or search term.</p>';
    return;
  }

  filteredBooks.forEach((book) => {
    const chapterBadge = book.chapters && book.chapters.length
      ? `<span class="chapter-badge">${book.chapters.length} chapters</span>`
      : "";

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
          ${chapterBadge}
        </span>
      </span>
    `;
    card.addEventListener("click", () => selectBook(book));
    bookGrid.appendChild(card);
  });
}

/* ---------- reader ---------- */

function selectBook(book) {
  selectedBook = book;
  selectedChapterIndex = book.chapters && book.chapters.length ? 0 : null;
  currentPdfPath = null;
  renderBooks();
  renderReader();
  document.querySelector("#reader").scrollIntoView({ behavior: "smooth", block: "start" });
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

function renderChapterList(book) {
  const hasChapters = book.chapters && book.chapters.length;
  contents.hidden = !hasChapters;
  prevChapter.hidden = !hasChapters;
  nextChapter.hidden = !hasChapters;

  if (!hasChapters) {
    chapterList.innerHTML = "";
    return;
  }

  chapterSearch.value = "";
  chapterCount.textContent = `(${book.chapters.length})`;

  let html = "";
  let lastUnit = null;
  book.chapters.forEach((chapter, index) => {
    if (chapter.unit && chapter.unit !== lastUnit) {
      html += `<p class="unit-heading">${escapeHtml(chapter.unit)}</p>`;
      lastUnit = chapter.unit;
    }
    html += `
      <button class="chapter-button ${index === selectedChapterIndex ? "active" : ""}" type="button" data-index="${index}">
        ${escapeHtml(chapter.title)}
      </button>`;
  });
  chapterList.innerHTML = html;

  chapterList.querySelectorAll(".chapter-button").forEach((button) => {
    button.addEventListener("click", () => {
      selectedChapterIndex = Number(button.dataset.index);
      renderReaderView();
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
  if (book.chapters && book.chapters.length) {
    if (ch === "all") {
      index = null;
    } else {
      const n = Number(ch);
      index = Number.isInteger(n) && n >= 0 && n < book.chapters.length ? n : 0;
    }
  }
  return { book, index };
}

function showPdf(pdfPath, page) {
  const hash = page ? `#page=${page}` : "#view=FitH";
  const src = encodeURI(pdfPath) + hash;
  let iframe = pdfFrame.querySelector("iframe.pdf-embed");

  if (!iframe || currentPdfPath !== pdfPath) {
    pdfFrame.innerHTML = `<iframe class="pdf-embed" src="${escapeHtml(src)}" title="${escapeHtml(selectedBook.title)}"></iframe>`;
    currentPdfPath = pdfPath;
  } else {
    iframe.src = src;
  }
}

// A local-only book's PDF is only reachable when the site runs on your machine.
function bookPdfAvailable(book) {
  if (!book.pdf) return false;
  if (book.localOnly && !IS_LOCAL) return false;
  return true;
}

function showLocalOnly(book) {
  currentPdfPath = null;
  const sourceButton = book.sourceUrl
    ? `<a class="button primary" href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Open original source</a>`
    : "";
  pdfFrame.innerHTML = `
    <div class="pdf-placeholder">
      <strong>Local-only sample</strong>
      <p><em>${escapeHtml(book.title)}</em> is a large demo file that is not hosted online. Run this project on your computer (<code>py -m http.server</code>) to read it here, or host each chapter as a small PDF for the live site.</p>
      ${sourceButton}
    </div>`;
}

// Convert a Google Drive "file" link into an inline-embeddable preview URL.
function driveEmbedUrl(url) {
  const match = String(url || "").match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  return match ? `https://drive.google.com/file/d/${match[1]}/preview` : null;
}

// Show an embeddable source (currently Google Drive preview) inline in the reader.
function showEmbed(book) {
  const embed = driveEmbedUrl(book.sourceUrl);
  if (!embed) {
    showNoPdf(book);
    return false;
  }
  currentPdfPath = "embed:" + embed;
  pdfFrame.innerHTML = `
    <iframe class="pdf-embed" src="${escapeHtml(embed)}" title="${escapeHtml(book.title)}" allow="autoplay" allowfullscreen></iframe>
    <p class="pdf-hint">Displayed from Google Drive. <a href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Open in Drive</a> to download.</p>`;
  return true;
}

function showNoPdf(book) {
  currentPdfPath = null;
  const sourceButton = book.sourceUrl
    ? `<a class="button primary" href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Open original source</a>`
    : "";
  pdfFrame.innerHTML = `
    <div class="pdf-placeholder">
      <strong>PDF not added locally yet</strong>
      <p>Download <em>${escapeHtml(book.title)}</em> from its original source, save it in the <code>pdfs/</code> folder, then set the <code>pdf</code> path for this entry in <code>books.json</code> to show it inline here.</p>
      ${sourceButton}
    </div>`;
}

function renderReaderView() {
  const book = selectedBook;
  const hasChapters = book.chapters && book.chapters.length;
  persistSelection();

  // highlight active chapter
  if (hasChapters) {
    chapterList.querySelectorAll(".chapter-button").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.index) === selectedChapterIndex);
    });
  }

  if (hasChapters && selectedChapterIndex !== null) {
    const chapter = book.chapters[selectedChapterIndex];
    readerFileTitle.textContent = chapter.title;
    readerFileStatus.textContent = `Chapter ${selectedChapterIndex + 1} of ${book.chapters.length}`;
    prevChapter.disabled = selectedChapterIndex === 0;
    nextChapter.disabled = selectedChapterIndex === book.chapters.length - 1;

    if (chapter.pdf) {
      showPdf(chapter.pdf, chapter.page);
    } else if (bookPdfAvailable(book)) {
      showPdf(book.pdf, chapter.page);
    } else if (book.localOnly) {
      showLocalOnly(book);
    } else {
      showEmbed(book);
    }
    return;
  }

  // complete book / no chapters
  readerFileTitle.textContent = book.title;
  if (bookPdfAvailable(book)) {
    readerFileStatus.textContent = hasChapters ? "Complete book" : book.pdf;
    showPdf(book.pdf, null);
  } else if (book.localOnly) {
    readerFileStatus.textContent = "Local-only sample";
    showLocalOnly(book);
  } else if (driveEmbedUrl(book.sourceUrl)) {
    readerFileStatus.textContent = "Displayed from Google Drive";
    showEmbed(book);
  } else {
    readerFileStatus.textContent = book.sourceUrl
      ? "Open original source to view or download"
      : "No PDF linked yet";
    showNoPdf(book);
  }
}

function renderReader() {
  if (!selectedBook) return;
  const book = selectedBook;

  readerTitle.textContent = book.title;
  readerMeta.textContent = [book.subject, `Class ${book.class}`, book.wing, book.language, book.year]
    .filter(Boolean)
    .join(" | ");

  renderFacts(book);

  sourceLink.hidden = !book.sourceUrl;
  if (book.sourceUrl) sourceLink.href = book.sourceUrl;

  completeBook.hidden = !(book.pdf && book.chapters && book.chapters.length);

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
  });

  toggleSidebar.addEventListener("click", () => {
    const collapsed = readerShell.classList.toggle("collapsed");
    toggleSidebar.textContent = collapsed ? "Show panel" : "Hide panel";
    toggleSidebar.setAttribute("aria-pressed", String(collapsed));
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
    fullscreenBtn.innerHTML = on ? "&#10005; Exit fullscreen" : "&#9974; Fullscreen";
  });

  chapterSearch.addEventListener("input", () => filterChapters(chapterSearch.value));

  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement ? document.activeElement.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!selectedBook || !(selectedBook.chapters && selectedBook.chapters.length)) return;

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
    renderReaderView();
  });

  nextChapter.addEventListener("click", () => {
    const total = selectedBook.chapters.length;
    if (selectedChapterIndex === null) selectedChapterIndex = 0;
    selectedChapterIndex = Math.min(total - 1, selectedChapterIndex + 1);
    renderReaderView();
  });
}

/* ---------- data ---------- */

async function loadBooks() {
  try {
    const response = await fetch(CATALOG_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`books.json returned ${response.status}`);
    books = await response.json();
    dataNotice.hidden = true;
  } catch (error) {
    books = fallbackBooks;
    dataNotice.hidden = false;
    dataNotice.textContent =
      "Using built-in sample data. Run the folder through a local server so books.json can load (see README).";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
    selectedBook =
      books.find((b) => bookPdfAvailable(b) || driveEmbedUrl(b.sourceUrl)) || books[0] || null;
    selectedChapterIndex =
      selectedBook && selectedBook.chapters && selectedBook.chapters.length ? 0 : null;
  }

  setupFilters();
  bindEvents();
  renderBooks();
  renderReader();
}

init();
