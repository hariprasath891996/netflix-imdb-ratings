// Runs inside the Netflix page. Finds title cards, asks the background worker
// for an IMDb rating, and pins a small badge onto each card.
//
// Netflix is a single-page app that builds cards lazily as you scroll, so there
// is no single "page is ready" moment to hook. Two observers handle that:
//   - a MutationObserver notices cards being added to the DOM
//   - an IntersectionObserver holds the lookup until a card is actually on
//     screen, so scrolling past three rows doesn't spend quota on thirty.

// Netflix styles itself with CSS-in-JS, so its class names look like
// "default-ltr-iqcdef-cache-19c3xp8" and change on every deploy — useless to
// select on. `data-uia` attributes are Netflix's own test-automation hooks:
// semantic, and stable because their QA depends on them. Always prefer those.
const CARD_SELECTORS = [
  '[data-uia="standard-card"]', // ordinary row cards
  '[data-uia="ranked-card"]',   // the Top 10 rows
  '[data-uia="progress-card"]'  // Continue Watching
].join(",");

// The RAG thresholds are user-configurable (see options.html). RAG_DEFAULTS
// comes from defaults.js, which the manifest loads before this file. These are
// mutable because a settings change re-colours badges in place — no refetch.
let thresholds = { ...RAG_DEFAULTS };

let announcedImport = false;
let retryTimer = null;

// --- reading a title off a card ------------------------------------------
// A card is an anchor carrying the title in its own aria-label:
//   <a href="/browse?jbv=70155590" aria-label="The Mentalist" data-uia="standard-card">
// Note the label is on the card element itself, not a descendant — so check
// the element's own attribute before searching inside it. The <img> alt is
// empty on current Netflix, but it is kept as a fallback in case that changes.
function titleFromCard(card) {
  const own = card.getAttribute("aria-label");
  if (own && own.trim()) return clean(own);

  const labelled = card.querySelector("[aria-label]");
  const inner = labelled && labelled.getAttribute("aria-label");
  if (inner && inner.trim()) return clean(inner);

  const img = card.querySelector("img[alt]");
  if (img && img.alt.trim()) return clean(img.alt);

  return null;
}

// Netflix labels use typographic punctuation — curly apostrophes, en dashes —
// where catalogues index the plain ASCII forms. "Don't Come Home" with a U+2019
// apostrophe misses; the same title with U+0027 resolves fine.
function clean(raw) {
  return raw
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^watch\s+/i, "")
    .replace(/\s+(now|on netflix)$/i, "")
    .trim();
}

// The badge is absolutely positioned, so it needs a positioned ancestor. The
// card anchor itself is the right box; .nrx-host in the stylesheet gives it
// position:relative when it doesn't already have one.
function hostFor(card) {
  return card;
}

function tierFor(rating) {
  const value = parseFloat(rating);
  if (Number.isNaN(value)) return "unknown";
  if (value >= thresholds.tierHigh) return "high";
  if (value >= thresholds.tierMid) return "mid";
  return "low";
}

// Changing a threshold changes only which colour a score maps to, never the
// score itself. So we keep the rating on the element and recolour in place
// rather than re-fetching anything.
function recolourAll() {
  for (const badge of document.querySelectorAll(".nrx-badge")) {
    const rating = badge.dataset.rating;
    if (rating) badge.dataset.tier = tierFor(rating);
  }
}

function renderBadge(host, result) {
  if (host.querySelector(".nrx-badge")) return;

  const badge = document.createElement("div");
  badge.className = "nrx-badge";

  if (!result.found || !result.rating) {
    badge.dataset.tier = "unknown";
    badge.textContent = "—";
    badge.title = "No IMDb rating found for this title";
  } else {
    badge.dataset.rating = result.rating;
    badge.dataset.tier = tierFor(result.rating);
    badge.textContent = result.rating;

    // Netflix's label and IMDb's title often differ ("Laapataa Ladies" is
    // filed as "Lost Ladies"), and the match is occasionally wrong. Naming the
    // matched title makes a bad match visible instead of silent.
    const parts = [`IMDb ${result.rating}`];
    if (result.votes) parts.push(`${result.votes.toLocaleString()} votes`);
    if (result.year) parts.push(String(result.year));
    const detail = parts.join(" · ");
    badge.title = result.exact === false && result.label
      ? `${detail}\nmatched as "${result.label}"`
      : detail;
  }

  host.classList.add("nrx-host");
  host.appendChild(badge);
}

// --- the lookup pipeline --------------------------------------------------
async function process(card) {
  if (card.dataset.nrxDone) return;
  card.dataset.nrxDone = "1"; // claim it immediately so we never double-fetch

  const title = titleFromCard(card);
  if (!title) return;

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "lookup", title });
  } catch (e) {
    // Usually means the extension was just reloaded and this page's script is
    // orphaned. Nothing useful to do; a page refresh fixes it.
    return;
  }

  if (!result) return;

  if (result.error) {
    // "importing" means the IMDb ratings dataset is still being pulled in on
    // first run. That takes a minute or so once, ever — so rather than leaving
    // the page permanently blank, release the card and rescan shortly.
    if (result.error === "importing" && !announcedImport) {
      announcedImport = true;
      console.info(
        "[IMDb for Netflix] Importing the IMDb ratings dataset — badges appear as soon as it finishes."
      );
    }
    delete card.dataset.nrxDone;
    delete card.dataset.nrxSeen;
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; scan(); }, 5000);
    }
    return;
  }

  renderBadge(hostFor(card), result);
}

const visibility = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visibility.unobserve(entry.target);
        process(entry.target);
      }
    }
  },
  { rootMargin: "200px" } // start slightly before it scrolls in
);

function scan(root = document) {
  const cards = root.querySelectorAll(CARD_SELECTORS);
  for (const card of cards) {
    if (card.dataset.nrxSeen) continue;
    card.dataset.nrxSeen = "1";
    visibility.observe(card);
  }
}

// Netflix adds cards in bursts; debounce so a burst is one scan, not fifty.
let scanTimer = null;
const pageObserver = new MutationObserver(() => {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scan(), 250);
});

pageObserver.observe(document.body, { childList: true, subtree: true });

// A settings change should take effect on the open tab immediately — having to
// reload Netflix to see a threshold tweak would make tuning them miserable.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  for (const key of ["tierHigh", "tierMid"]) {
    if (changes[key]) {
      thresholds[key] = changes[key].newValue ?? RAG_DEFAULTS[key];
      touched = true;
    }
  }
  if (touched) recolourAll();
});

// Load saved thresholds before the first scan, so nothing is ever painted with
// the wrong colours and then corrected a moment later.
(async function start() {
  try {
    const saved = await chrome.storage.local.get(["tierHigh", "tierMid"]);
    thresholds = {
      tierHigh: typeof saved.tierHigh === "number" ? saved.tierHigh : RAG_DEFAULTS.tierHigh,
      tierMid: typeof saved.tierMid === "number" ? saved.tierMid : RAG_DEFAULTS.tierMid
    };
  } catch (e) {
    // Storage unavailable is not fatal — the defaults are perfectly usable.
  }
  scan();
})();
