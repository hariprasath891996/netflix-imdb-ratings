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

// Netflix's hover preview replaces the card with a mini-player, taking our
// badge with it. This is the metadata row inside that preview ("U/A 13+ ·
// 5 Seasons · HD"), which is where the rating belongs once you are looking at
// the expanded state.
const MODAL_META = '[data-uia="videoMetadata--container"]';

// Below this many votes a rating is thin evidence. Measured against 430 real
// titles: only ~3% fall under 1,000, so this flags the genuinely shaky ones
// without dimming a quarter of the page (10,000 would flag 28%). It doubles as
// a wrong-match signal — a famous series resolving to 90 votes means the match,
// not the rating, is wrong.
const LOW_VOTE_THRESHOLD = 1000;

// The RAG thresholds are user-configurable (see options.html). RAG_DEFAULTS
// comes from defaults.js, which the manifest loads before this file. These are
// mutable because a settings change re-colours badges in place — no refetch.
let thresholds = { ...RAG_DEFAULTS };

// The dim-filter setting, same deal: mutable, re-applied in place rather than
// re-fetched, and defaulting from defaults.js.
let filter = { ...FILTER_DEFAULTS };

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

// 2,284,119 -> "2.3M". The modal has room for a vote count, and showing it
// there is what makes the confidence signal legible without a hover.
function shortVotes(votes) {
  if (votes >= 1000000) return `${(votes / 1000000).toFixed(1)}M`;
  if (votes >= 1000) return `${Math.round(votes / 1000)}K`;
  return String(votes);
}

function tierFor(rating) {
  const value = parseFloat(rating);
  if (Number.isNaN(value)) return "unknown";
  if (value >= thresholds.tierHigh) return "high";
  if (value >= thresholds.tierMid) return "mid";
  return "low";
}

// A missing rating (dataset.rating unset) must never dim — that's "no data",
// not "low score", and treating them the same would bury new and regional
// titles the extension simply hasn't matched yet.
function applyDim(card, rating) {
  const value = parseFloat(rating);
  const dim = filter.filterEnabled && rating && !Number.isNaN(value) && value < filter.filterMin;
  card.classList.toggle("nrx-dimmed", !!dim);
}

// Changing a threshold changes only which colour a score maps to, never the
// score itself. So we keep the rating on the element and recolour in place
// rather than re-fetching anything. The dim filter piggybacks on the same
// pass, for the same reason.
function recolourAll() {
  for (const element of document.querySelectorAll(".nrx-badge, .nrx-chip")) {
    const rating = element.dataset.rating;
    if (rating) element.dataset.tier = tierFor(rating);
  }

  // Only .nrx-badge lives on a card; .nrx-chip lives inside the hover-preview
  // modal, which isn't a card and is never dimmed. closest() rather than
  // parentElement because the badge's exact depth is hostFor()'s business, not
  // this function's.
  for (const badge of document.querySelectorAll(".nrx-badge")) {
    const card = badge.closest(CARD_SELECTORS);
    if (card) applyDim(card, badge.dataset.rating);
  }
}

// --- tooltip --------------------------------------------------------------
// One shared element, reused by every badge. It lives on <body> with a fixed
// position so that Netflix expanding a card on hover can neither clip it nor
// paint over it.
let tipElement = null;

function ensureTip() {
  if (tipElement && tipElement.isConnected) return tipElement;
  tipElement = document.createElement("div");
  tipElement.className = "nrx-tip";
  tipElement.hidden = true;
  document.body.appendChild(tipElement);
  return tipElement;
}

function showTip(badge) {
  const text = badge.dataset.tip;
  if (!text) return;

  const tip = ensureTip();
  tip.textContent = text;
  tip.hidden = false;

  // Measure only after the text is in, or the box is the previous size.
  const anchor = badge.getBoundingClientRect();
  const box = tip.getBoundingClientRect();

  let left = anchor.left + anchor.width / 2 - box.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));

  // Prefer above the badge; flip below when there isn't room, which happens on
  // the top row.
  let top = anchor.top - box.height - 8;
  if (top < 8) top = anchor.bottom + 8;

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  if (tipElement) tipElement.hidden = true;
}

// A fixed-position tooltip would otherwise hang in place while the row scrolls
// away beneath it.
addEventListener("scroll", hideTip, { passive: true, capture: true });

function renderBadge(host, result) {
  if (host.querySelector(".nrx-badge")) return;

  const badge = document.createElement("div");
  badge.className = "nrx-badge";

  if (!result.found || !result.rating) {
    badge.dataset.tier = "unknown";
    badge.textContent = "—";
    badge.dataset.tip = "No IMDb rating found";
  } else {
    badge.dataset.rating = result.rating;
    badge.dataset.tier = tierFor(result.rating);
    badge.textContent = result.rating;

    // An 8.9 from 74 votes and an 8.7 from 2.3M both badge green, which lets
    // the badge mislead by omission. A dashed outline marks the thin ones.
    if (result.votes && result.votes < LOW_VOTE_THRESHOLD) {
      badge.dataset.confidence = "low";
    }

    // Netflix's label and IMDb's title often differ ("Laapataa Ladies" is
    // filed as "Lost Ladies"), and the match is occasionally wrong. Naming the
    // matched title makes a bad match visible instead of silent.
    const parts = [`IMDb ${result.rating}`];
    if (result.votes) parts.push(`${result.votes.toLocaleString()} votes`);
    if (result.year) parts.push(String(result.year));

    let tip = parts.join(" · ");
    if (result.label) tip += `\n${result.label}`;
    if (result.exact === false) tip += "  (closest match)";
    badge.dataset.tip = tip;
  }

  badge.addEventListener("mouseenter", () => showTip(badge));
  badge.addEventListener("mouseleave", hideTip);

  host.classList.add("nrx-host");
  host.appendChild(badge);

  // A card that renders while the filter is already on should not wait for
  // the next settings change to be dimmed.
  applyDim(host, badge.dataset.rating);
}

// --- the hover preview ----------------------------------------------------
// The modal is built and torn down repeatedly as the pointer moves across a
// row, so it is treated like any other element the page adds: found by the
// same debounced scan, and claimed once.
function titleFromModal(meta) {
  const modal = meta.closest('[class*="previewModal"]');
  const image = (modal || document).querySelector("img[alt]");
  return image && image.alt.trim() ? clean(image.alt) : null;
}

function renderModalChip(meta, result) {
  if (meta.querySelector(".nrx-chip")) return;

  const chip = document.createElement("span");
  chip.className = "nrx-chip";

  if (!result.found || !result.rating) {
    chip.dataset.tier = "unknown";
    chip.textContent = "No IMDb rating";
  } else {
    chip.dataset.rating = result.rating;
    chip.dataset.tier = tierFor(result.rating);
    if (result.votes && result.votes < LOW_VOTE_THRESHOLD) chip.dataset.confidence = "low";

    // Space is not scarce here, so the vote count goes in plainly rather than
    // being hidden behind a hover that Netflix's autoplay would win anyway.
    chip.textContent = result.votes
      ? `IMDb ${result.rating} · ${shortVotes(result.votes)} votes`
      : `IMDb ${result.rating}`;

    if (result.exact === false && result.label) {
      const alias = document.createElement("span");
      alias.className = "nrx-chip-alias";
      alias.textContent = `· ${result.label}`;
      chip.appendChild(alias);
    }
  }

  meta.insertBefore(chip, meta.firstChild);
}

async function processModal(meta) {
  if (meta.dataset.nrxDone) return;
  meta.dataset.nrxDone = "1";

  const title = titleFromModal(meta);
  if (!title) { delete meta.dataset.nrxDone; return; }

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "lookup", title });
  } catch (e) {
    return;
  }
  if (!result) return;
  if (result.error) { delete meta.dataset.nrxDone; return; }

  renderModalChip(meta, result);
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

  // A preview modal only exists while it is being looked at, so there is
  // nothing to defer — resolve it straight away.
  for (const meta of root.querySelectorAll(MODAL_META)) processModal(meta);
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
  for (const key of ["filterEnabled", "filterMin"]) {
    if (changes[key]) {
      filter[key] = changes[key].newValue ?? FILTER_DEFAULTS[key];
      touched = true;
    }
  }
  if (touched) recolourAll();
});

// Load saved thresholds before the first scan, so nothing is ever painted with
// the wrong colours and then corrected a moment later.
(async function start() {
  try {
    const saved = await chrome.storage.local.get(["tierHigh", "tierMid", "filterEnabled", "filterMin"]);
    thresholds = {
      tierHigh: typeof saved.tierHigh === "number" ? saved.tierHigh : RAG_DEFAULTS.tierHigh,
      tierMid: typeof saved.tierMid === "number" ? saved.tierMid : RAG_DEFAULTS.tierMid
    };
    filter = {
      filterEnabled: typeof saved.filterEnabled === "boolean" ? saved.filterEnabled : FILTER_DEFAULTS.filterEnabled,
      filterMin: typeof saved.filterMin === "number" ? saved.filterMin : FILTER_DEFAULTS.filterMin
    };
  } catch (e) {
    // Storage unavailable is not fatal — the defaults are perfectly usable.
  }
  scan();
})();
