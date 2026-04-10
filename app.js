const STORAGE_KEYS = {
  theme: "news-theme",
  read: "news-read-items",
  saved: "news-saved-items",
  ui: "news-ui-state",
};

const TAB_ORDER = ["All", "Malayalam", "Kottayam", "Trivandrum", "Kochi", "Focus", "Kerala", "India", "World", "Saved"];
const state = {
  activeTab: "All",
  items: [],
  readIds: loadStoredSet(STORAGE_KEYS.read),
  savedIds: loadStoredSet(STORAGE_KEYS.saved),
  visibleImages: new Set(),
  theme: localStorage.getItem(STORAGE_KEYS.theme) || "red",
  activeArticleId: null,
};

const elements = {
  themeToggle: document.querySelector("#theme-toggle"),
  statusSummary: document.querySelector("#status-summary"),
  lastUpdated: document.querySelector("#last-updated"),
  topStory: document.querySelector("#top-story"),
  latestList: document.querySelector("#latest-list"),
  countsPanel: document.querySelector("#counts-panel"),
  savedPreview: document.querySelector("#saved-preview"),
  emptyTemplate: document.querySelector("#empty-state-template"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  readerPanel: document.querySelector("#reader-panel"),
  readerTitle: document.querySelector("#reader-title"),
  readerSource: document.querySelector("#reader-source"),
  readerOpenSource: document.querySelector("#reader-open-source"),
  readerClose: document.querySelector("#reader-close"),
  readerPublished: document.querySelector("#reader-published"),
  readerSummary: document.querySelector("#reader-summary"),
  readerImageShell: document.querySelector("#reader-image-shell"),
};

bootstrap();

async function bootstrap() {
  applyTheme(state.theme);
  bindEvents();
  await loadNews();
  restoreUiState();
  render();
  registerServiceWorker();
}

function bindEvents() {
  elements.themeToggle.addEventListener("click", () => {
    state.theme = state.theme === "red" ? "blue" : "red";
    localStorage.setItem(STORAGE_KEYS.theme, state.theme);
    applyTheme(state.theme);
  });

  elements.tabs.forEach((tabButton) => {
    tabButton.addEventListener("click", () => {
      state.activeTab = tabButton.dataset.tab;
      render();
    });
  });

  elements.readerClose.addEventListener("click", () => {
    closeReader();
    render();
  });

  elements.readerOpenSource.addEventListener("click", () => {
    persistUiState();
  });

  document.addEventListener("click", (event) => {
    const openTarget = event.target.closest("[data-open-article]");
    if (openTarget) {
      event.preventDefault();
      const articleId = openTarget.dataset.openArticle;
      openReader(articleId);
      render();
      return;
    }

    const saveTarget = event.target.closest("[data-save-article]");
    if (saveTarget) {
      const articleId = saveTarget.dataset.saveArticle;
      toggleSaved(articleId);
      render();
      return;
    }

    const imageTarget = event.target.closest("[data-load-image]");
    if (imageTarget) {
      state.visibleImages.add(imageTarget.dataset.loadImage);
      render();
    }
  });
}

async function loadNews() {
  try {
    const response = await fetch("data/news.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load headlines: ${response.status}`);
    }

    const payload = await response.json();
    state.items = Array.isArray(payload) ? payload : [];
  } catch (error) {
    console.error(error);
    state.items = [];
    elements.statusSummary.textContent = "Headlines could not be loaded.";
    elements.lastUpdated.textContent = "Check your local server or refresh the feed data.";
  }
}

function render() {
  elements.tabs.forEach((tabButton) => {
    tabButton.classList.toggle("is-active", tabButton.dataset.tab === state.activeTab);
    tabButton.setAttribute("aria-selected", String(tabButton.dataset.tab === state.activeTab));
  });

  const filteredItems = getFilteredItems();
  const [topStory, ...remainingStories] = filteredItems;
  const unreadCount = state.items.filter((item) => !state.readIds.has(item.id)).length;

  elements.statusSummary.textContent = `${filteredItems.length} stories in ${state.activeTab}. ${unreadCount} unread overall.`;
  elements.lastUpdated.textContent = buildLastUpdatedLabel();
  elements.countsPanel.textContent = `Unread: ${unreadCount} · Saved: ${state.savedIds.size}`;
  renderSavedPreview();
  renderReader();
  persistUiState();

  renderSlot(elements.topStory, topStory ? renderStory(topStory, true) : cloneEmptyState());

  if (remainingStories.length === 0) {
    renderSlot(elements.latestList, cloneEmptyState());
    return;
  }

  elements.latestList.innerHTML = remainingStories.map((item) => renderStory(item, false)).join("");
}

function renderSavedPreview() {
  const savedItems = state.items.filter((item) => state.savedIds.has(item.id)).slice(0, 4);
  if (savedItems.length === 0) {
    elements.savedPreview.innerHTML = "<p>No saved stories yet.</p>";
    return;
  }

  elements.savedPreview.innerHTML = savedItems
    .map(
      (item) => `
        <article class="saved-item">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.source)} · ${escapeHtml(item.category)}</p>
        </article>
      `,
    )
    .join("");
}

function renderStory(item, isLead) {
  const isRead = state.readIds.has(item.id);
  const isSaved = state.savedIds.has(item.id);
  const imageVisible = state.visibleImages.has(item.id);
  const wrapperClass = isLead ? "story-lead" : "story-card";
  const summary = item.summary || "Open the full article for the complete report.";
  const openLabel = state.activeArticleId === item.id ? "Reading here" : "Read here";
  const saveLabel = isSaved ? "Saved" : "Save";

  return `
    <article class="${wrapperClass} ${isRead ? "is-read" : ""}">
      <p class="story-kicker">${escapeHtml(item.category)} · ${escapeHtml((item.language || "en").toUpperCase())}</p>
      <h3 class="story-title">${escapeHtml(item.title)}</h3>
      ${
        item.hasImage
          ? `
            <div class="image-shell">
              ${
                imageVisible
                  ? `<img class="story-image" src="${escapeAttribute(item.image)}" alt="" loading="lazy" decoding="async" />`
                  : `<p class="story-image-note">Image hidden by default. Load it only when you want it.</p>`
              }
            </div>
          `
          : ""
      }
      <p class="story-summary">${escapeHtml(summary)}</p>
      <p class="story-meta">
        <span>${escapeHtml(item.source)}</span>
        <span>${formatPublishedAt(item.publishedAt)}</span>
      </p>
      <div class="story-actions">
        <a
          class="button button-primary"
          href="${escapeAttribute(item.url)}"
          data-open-article="${escapeAttribute(item.id)}"
          aria-label="Read article here: ${escapeAttribute(item.title)}"
        >
          ${openLabel}
        </a>
        <button
          class="button button-quiet ${isSaved ? "is-saved" : ""}"
          type="button"
          data-save-article="${escapeAttribute(item.id)}"
          aria-pressed="${String(isSaved)}"
        >
          ${saveLabel}
        </button>
        ${
          item.hasImage
            ? imageVisible
              ? ""
              : `
                <button
                  class="button button-secondary"
                  type="button"
                  data-load-image="${escapeAttribute(item.id)}"
                >
                  Load image
                </button>
              `
            : ""
        }
      </div>
    </article>
  `;
}

function getFilteredItems() {
  if (state.activeTab === "Saved") {
    return state.items.filter((item) => state.savedIds.has(item.id));
  }

  if (state.activeTab === "Malayalam") {
    return state.items.filter((item) => item.language === "ml");
  }

  if (state.activeTab === "All") {
    return state.items;
  }

  return state.items.filter((item) => item.category === state.activeTab);
}

function renderSlot(element, content) {
  if (content instanceof DocumentFragment) {
    element.innerHTML = "";
    element.appendChild(content);
    return;
  }

  element.innerHTML = content;
}

function renderReader() {
  const activeItem = state.items.find((item) => item.id === state.activeArticleId);
  if (!activeItem) {
    elements.readerPanel.classList.add("is-hidden");
    elements.readerOpenSource.href = "#";
    elements.readerPublished.textContent = "Publication time";
    elements.readerSummary.textContent =
      "Select a story to view the summary here. Use Open original to read the full article on the publisher site.";
    elements.readerImageShell.innerHTML = "";
    return;
  }

  elements.readerPanel.classList.remove("is-hidden");
  elements.readerTitle.textContent = activeItem.title;
  elements.readerSource.textContent = `${activeItem.source} · ${activeItem.category}`;
  elements.readerOpenSource.href = activeItem.url;
  elements.readerPublished.textContent = formatPublishedAt(activeItem.publishedAt);
  elements.readerSummary.textContent = activeItem.summary || "Open the original article for the full report.";
  elements.readerImageShell.innerHTML = renderReaderImage(activeItem);
}

function cloneEmptyState() {
  return elements.emptyTemplate.content.cloneNode(true);
}

function markAsRead(articleId) {
  state.readIds.add(articleId);
  persistSet(STORAGE_KEYS.read, state.readIds);
}

function toggleSaved(articleId) {
  if (state.savedIds.has(articleId)) {
    state.savedIds.delete(articleId);
  } else {
    state.savedIds.add(articleId);
  }

  persistSet(STORAGE_KEYS.saved, state.savedIds);
}

function openReader(articleId) {
  const item = state.items.find((entry) => entry.id === articleId);
  if (!item) {
    return;
  }

  state.activeArticleId = articleId;
  markAsRead(articleId);
  persistUiState();
  elements.readerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeReader() {
  state.activeArticleId = null;
  persistUiState();
}

function renderReaderImage(item) {
  if (!item.hasImage) {
    return "";
  }

  if (!state.visibleImages.has(item.id)) {
    return `
      <button class="button button-secondary" type="button" data-load-image="${escapeAttribute(item.id)}">
        Load image
      </button>
    `;
  }

  return `<img src="${escapeAttribute(item.image)}" alt="" loading="lazy" decoding="async" />`;
}

function persistUiState() {
  try {
    sessionStorage.setItem(
      STORAGE_KEYS.ui,
      JSON.stringify({
        activeTab: state.activeTab,
        activeArticleId: state.activeArticleId,
      }),
    );
  } catch {}
}

function restoreUiState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.ui);
    if (!raw) {
      return;
    }

    const saved = JSON.parse(raw);
    if (saved && TAB_ORDER.includes(saved.activeTab)) {
      state.activeTab = saved.activeTab;
    }

    if (saved && typeof saved.activeArticleId === "string" && state.items.some((item) => item.id === saved.activeArticleId)) {
      state.activeArticleId = saved.activeArticleId;
    }
  } catch {}
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "blue" ? "blue" : "red";
  elements.themeToggle.textContent = theme === "blue" ? "Use red theme" : "Use blue theme";
}

function buildLastUpdatedLabel() {
  if (state.items.length === 0) {
    return "No cached stories available yet.";
  }

  const latestDate = state.items[0].publishedAt;
  return `Latest story timestamp: ${formatPublishedAt(latestDate)}`;
}

function formatPublishedAt(value) {
  if (!value) {
    return "Time unavailable";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Time unavailable";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function loadStoredSet(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistSet(key, value) {
  localStorage.setItem(key, JSON.stringify([...value]));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((error) => {
      console.error("Service worker registration failed", error);
    });
  });
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value = "") {
  return escapeHtml(String(value));
}
