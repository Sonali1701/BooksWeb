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

const bookGrid = document.querySelector("#bookGrid");
const searchInput = document.querySelector("#searchInput");
const dataNotice = document.querySelector("#dataNotice");

const readerTitle = document.querySelector("#reader-title");
const readerMeta = document.querySelector("#readerMeta");
const readerFacts = document.querySelector("#readerFacts");
const downloadPdf = document.querySelector("#downloadPdf");
const sourceLink = document.querySelector("#sourceLink");
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
  FILTERS.forEach((filter) => {
    fillSelect(filter.el, uniqueValues(filter.key));
  });
}

function bookMatchesFilters(book, query) {
  const searchable = [
    book.title,
    book.subject,
    book.class,
    book.wing,
    book.language,
    book.year,
    book.description,
    book.author,
    book.publication
  ]
    .join(" ")
    .toLowerCase();

  const passesFilters = FILTERS.every(
    (filter) => filter.active === "All" || book[filter.key] === filter.active
  );

  return passesFilters && searchable.includes(query);
}

function renderBooks() {
  const query = searchInput.value.trim().toLowerCase();
  const filteredBooks = books.filter((book) => bookMatchesFilters(book, query));

  bookGrid.innerHTML = "";

  if (!filteredBooks.length) {
    bookGrid.innerHTML =
      '<p class="empty-state">No materials found. Try a different subject, class, wing, language, year, or search term.</p>';
    return;
  }

  filteredBooks.forEach((book) => {
    const card = document.createElement("button");
    card.className = `book-card ${selectedBook && book.id === selectedBook.id ? "active" : ""}`;
    card.type = "button";
    card.innerHTML = `
      <span class="book-cover" style="background: ${escapeHtml(colorForSubject(book.subject))}">
        <span class="book-cover-subject">${escapeHtml(book.subject || "")}</span>
      </span>
      <span>
        <span class="book-format">${escapeHtml(book.wing || "Material")}${book.year ? " &middot; " + escapeHtml(book.year) : ""}</span>
        <h3>${escapeHtml(book.title)}</h3>
        <p>${escapeHtml(book.description || (book.publication ? book.publication : "Source available — open to view or download."))}</p>
        <span class="tag-row">
          <span class="tag">${escapeHtml(book.subject)}</span>
          <span class="tag">Class ${escapeHtml(book.class)}</span>
          <span class="tag">${escapeHtml(book.wing)}</span>
          <span class="tag">${escapeHtml(book.language)}</span>
        </span>
      </span>
    `;
    card.addEventListener("click", () => selectBook(book));
    bookGrid.appendChild(card);
  });
}

function selectBook(book) {
  selectedBook = book;
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
    .map(
      ([label, value]) => `
      <div>
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value || "-")}</dd>
      </div>`
    )
    .join("");
}

function renderPdf(book) {
  if (!book.pdf) {
    const sourceButton = book.sourceUrl
      ? `<a class="button primary" href="${escapeHtml(book.sourceUrl)}" target="_blank" rel="noreferrer">Open original source</a>`
      : "";
    pdfFrame.innerHTML = `
      <div class="pdf-placeholder">
        <strong>PDF not added locally yet</strong>
        <p>Download <em>${escapeHtml(book.title)}</em> from its original source, save it in the <code>pdfs/</code> folder, then set the <code>pdf</code> path for this entry in <code>books.json</code> to show it inline here.</p>
        ${sourceButton}
      </div>`;
    return;
  }

  pdfFrame.innerHTML = `
    <iframe class="pdf-embed" src="${escapeHtml(book.pdf)}#view=FitH" title="${escapeHtml(book.title)} PDF" loading="lazy"></iframe>
    <p class="pdf-hint">If the document does not appear, the file <code>${escapeHtml(book.pdf)}</code> has not been added yet. Place the downloaded PDF in the <code>pdfs/</code> folder using that exact name.</p>
  `;
}

function renderReader() {
  if (!selectedBook) {
    return;
  }

  const book = selectedBook;
  readerTitle.textContent = book.title;
  readerMeta.textContent = [book.subject, `Class ${book.class}`, book.wing, book.language, book.year]
    .filter(Boolean)
    .join(" | ");

  renderFacts(book);

  if (book.pdf) {
    downloadPdf.hidden = false;
    downloadPdf.href = book.pdf;
  } else {
    downloadPdf.hidden = true;
    downloadPdf.removeAttribute("href");
  }

  if (book.sourceUrl) {
    sourceLink.hidden = false;
    sourceLink.href = book.sourceUrl;
  } else {
    sourceLink.hidden = true;
    sourceLink.removeAttribute("href");
  }

  readerFileTitle.textContent = book.title;
  readerFileStatus.textContent = book.pdf
    ? book.pdf
    : book.sourceUrl
    ? "Open original source to view or download, then add the PDF locally"
    : "No PDF linked yet";

  renderPdf(book);
}

function bindEvents() {
  FILTERS.forEach((filter) => {
    filter.el.addEventListener("change", () => {
      filter.active = filter.el.value;
      renderBooks();
    });
  });

  searchInput.addEventListener("input", renderBooks);
}

async function loadBooks() {
  try {
    const response = await fetch(CATALOG_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`books.json returned ${response.status}`);
    }
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
  selectedBook = books[0] || null;
  setupFilters();
  bindEvents();
  renderBooks();
  renderReader();
}

init();
