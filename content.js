// Runs inside a streaming site's page. Finds title cards, asks the background
// worker for an IMDb rating, and pins a small badge onto each card.
//
// Netflix and Prime Video are both single-page apps that build cards lazily as
// you scroll, so there is no single "page is ready" moment to hook. Two
// observers handle that:
//   - a MutationObserver notices cards being added to the DOM
//   - an IntersectionObserver holds the lookup until a card is actually on
//     screen, so scrolling past three rows doesn't spend quota on thirty.

// --- what differs between sites -------------------------------------------
// Everything downstream of a title string is already site-agnostic:
// background.js is handed a name and returns a rating, and never learns who
// asked. Only three things are actually site-shaped — which elements are
// cards, which box inside a card the badge hangs off, and whether the site has
// a hover-preview metadata row to restate the rating in. Confining those to
// this map is what keeps the rest of the file (the observers, the pipeline,
// the tooltip, the dim filter) from growing per-site branches.
const PLATFORMS = {
  netflix: {
    hosts: ["netflix.com"],

    // Netflix styles itself with CSS-in-JS, so its class names look like
    // "default-ltr-iqcdef-cache-19c3xp8" and change on every deploy — useless
    // to select on. `data-uia` attributes are Netflix's own test-automation
    // hooks: semantic, and stable because their QA depends on them. Always
    // prefer those.
    cards: [
      '[data-uia="standard-card"]', // ordinary row cards
      '[data-uia="ranked-card"]',   // the Top 10 rows
      '[data-uia="progress-card"]', // Continue Watching

      // My List and the genre pages are grids, not rows, and build their tiles
      // from a different component: a static DIV with no aria-label of its own,
      // where the three above are anchors that carry the title directly. Both
      // differences are already handled — titleFromCard() falls through to a
      // descendant [aria-label], and .nrx-host supplies the positioning context
      // the badge needs. Between them these four are every surface confirmed on
      // the live site; nothing is listed here on a guess.
      '[data-uia="title-card-container"]'
    ],

    // The card element is itself the box that frames the artwork here, so
    // there is no inner host to look for.
    badgeHost: null,

    // Netflix draws its TOP 10 ribbon in the top-left corner and its
    // "New Season" / "Recently added" tags in the bottom-left, so the right
    // side is the only one that stays clear. Prime is the mirror of this.
    badgeCorner: "right",

    // Netflix's hover preview replaces the card with a mini-player, taking our
    // badge with it. This is the metadata row inside that preview ("U/A 13+ ·
    // 5 Seasons · HD"), which is where the rating belongs once you are looking
    // at the expanded state.
    modalMeta: '[data-uia="videoMetadata--container"]'
  },

  prime: {
    // primevideo.com is the only domain this was measured on, signed in and
    // live. The amazon.* entries are here on the reasonable expectation that
    // /gp/video serves the same web app under a different host — if the badges
    // never appear there, that expectation is what was wrong, and dropping the
    // patterns from the manifest is the whole fix.
    hosts: ["primevideo.com", "amazon.in", "amazon.com"],

    // data-testid is Amazon's test hook, the same kind of contract as
    // Netflix's data-uia and chosen for the same reason. Only what was
    // actually measured on the live page is here: the markup also carries
    // super-carousel-card and poster-link, but neither was verified, and a
    // selector nobody has watched match is a liability rather than extra
    // coverage.
    cards: ['[data-testid="card"]'],

    // The card is an <article> around the packshot, and the packshot is the
    // box that actually frames the artwork — so the badge hangs off that
    // rather than off whatever else the article encloses. It is already
    // position:relative, so .nrx-host asks nothing of it.
    badgeHost: '[data-testid="packshot"]',

    // Prime's own ribbons — "NEW MOVIE", "TRENDING" — sit in the TOP-RIGHT of a
    // tile, exactly where Netflix leaves room. Measured on the live site: the
    // badge collided with them there, and the top-left is clear. Same badge,
    // opposite corner.
    badgeCorner: "left",

    // Prime has no equivalent of Netflix's preview metadata row, and the chip
    // is only meaningful sitting in a row that already reads "18+ · 2 Seasons
    // · HD". Nothing to render into means nothing rendered.
    modalMeta: null
  }
};

function platformFor(hostname) {
  for (const config of Object.values(PLATFORMS)) {
    if (config.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      return config;
    }
  }
  return null;
}

// The manifest injects this file only on the domains named above, so this can
// only miss if a match pattern is added without a config to go with it.
// Failing here is deliberate: falling back to Netflix's selectors would badge
// nothing at all while still looking like a healthy extension.
const platform = platformFor(location.hostname);
if (!platform) {
  throw new Error(`[IMDb badges] No platform config for ${location.hostname}`);
}

const CARD_SELECTORS = platform.cards.join(",");
const MODAL_META = platform.modalMeta;

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
// A Netflix row card is an anchor carrying the title in its own aria-label:
//   <a href="/browse?jbv=70155590" aria-label="The Mentalist" data-uia="standard-card">
// So check the element's own attribute before searching inside it. A grid tile
// (My List, genre pages) is the other shape: an unlabelled DIV wrapping an
// <a aria-label="Tenet">, which is what the descendant lookup is for. The
// <img> alt is empty on current Netflix, but it is kept as a fallback in case
// that changes.
//
// Prime Video is the second shape again — an <article> whose title sits on a
// descendant [aria-label] — so it needs no branch of its own here. That is why
// the platform config carries no title rule: there is nothing to vary yet, and
// a hook with one implementation is just indirection.
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

// The badge is absolutely positioned, so it needs a positioned ancestor that
// frames the artwork and nothing else. On Netflix the card element is already
// that box; where a platform names an inner one (Prime's packshot) the badge
// belongs there instead, or it would be pinned to the corner of whatever the
// card wraps rather than to the poster. .nrx-host in the stylesheet supplies
// position:relative when the chosen box doesn't already have it — which is
// what Netflix's position:static grid tiles need, and what stops the badge
// escaping to some far ancestor.
//
// Falling back to the card when the inner box is missing keeps a badge on
// screen if the site renames it: worse placement beats no rating.
function hostFor(card) {
  if (!platform.badgeHost) return card;
  return card.querySelector(platform.badgeHost) || card;
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

// --- opening the IMDb page from a badge -----------------------------------
// The badge sits inside Netflix's own card anchor, so every click on it is
// also a click on the card. That is why a plain click must be left completely
// alone: it belongs to Netflix, and intercepting it would break the one thing
// people already expect a card to do. Only the modifier chord — the same one
// that opens a link in a new tab everywhere else in the browser — is ours, and
// preventDefault() is reached only on that path.
const MODIFIER_LABEL =
  /mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? "⌘" : "Ctrl";

function openImdb(imdbID) {
  // noopener because the new tab is IMDb's page, not ours; it has no business
  // holding a handle back to the Netflix window.
  window.open(`https://www.imdb.com/title/${imdbID}/`, "_blank", "noopener");
}

function linkToImdb(badge, imdbID) {
  badge.dataset.imdbId = imdbID; // also what the stylesheet keys the cursor off

  // A link that only a mouse can reach is not a link. Only badges that
  // actually resolved to an id get a tab stop, so a grey "—" stays inert
  // rather than adding a dead stop to every card in a row.
  badge.tabIndex = 0;
  badge.setAttribute("role", "link");

  badge.addEventListener("click", (event) => {
    if (!(event.metaKey || event.ctrlKey)) return; // plain click: Netflix's
    event.preventDefault();  // stops the card anchor navigating as well
    event.stopPropagation(); // stops Netflix's own delegated card handler
    openImdb(imdbID);
  });

  // From the keyboard there is no plain-click case to protect: focus is on the
  // badge, so Enter can only have meant the badge.
  badge.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    openImdb(imdbID);
  });
}

// --- hiding every badge ---------------------------------------------------
// Shift+B, for badges. Netflix's own shortcuts are unmodified single keys —
// space, the arrows, f, m and friends during playback — and the browser's are
// all Ctrl/Cmd/Alt chords, so plain Shift is the gap between the two. The
// modified chords are rejected explicitly rather than ignored, so Cmd+Shift+B
// still reaches the browser's bookmarks bar untouched.
const HIDDEN_CLASS = "nrx-badges-hidden";

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Capture, because Netflix binds its playback keys on the document and stops
// propagation on the ones it claims — listening on the way down means the
// shortcut still works over a playing title.
addEventListener("keydown", (event) => {
  if (!event.shiftKey || event.key.toLowerCase() !== "b") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTypingTarget(event.target)) return; // Netflix's search box, mainly

  // The class lives on <html>, which survives Netflix's client-side
  // navigation, so the choice holds for the whole browsing session without
  // needing a storage key of its own.
  document.documentElement.classList.toggle(HIDDEN_CLASS);

  // A tooltip left open would float over the artwork we were just asked to
  // clear.
  hideTip();
}, { capture: true });

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

    // A rating with no id is a real state (on IMDb, unrated), and those badges
    // must not pretend to be links. The tooltip carries the hint because the
    // chord is otherwise invisible — a cursor change alone never told anyone
    // which modifier to hold.
    if (result.imdbID) {
      linkToImdb(badge, result.imdbID);
      tip += `\n${MODIFIER_LABEL}-click to open IMDb`;
    }

    badge.dataset.tip = tip;
  }

  badge.addEventListener("mouseenter", () => showTip(badge));
  badge.addEventListener("mouseleave", hideTip);

  badge.dataset.corner = platform.badgeCorner;
  host.classList.add("nrx-host");
  host.appendChild(badge);

  // A card that renders while the filter is already on should not wait for
  // the next settings change to be dimmed. Dimming the card rather than the
  // host matters where the two differ (Prime badges an inner box): the point
  // is to push the whole tile back, and recolourAll() reaches for the card the
  // same way, so the two passes can never disagree about which element carries
  // the class.
  applyDim(host.closest(CARD_SELECTORS) || host, badge.dataset.rating);
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

    // "title-card-container" is a wrapper, unlike the other three, so a single
    // tile can match twice and take two badges. Badging only the innermost
    // match keeps it to one, on the box that actually frames the artwork. Left
    // unclaimed rather than marked seen, since Netflix rebuilds these subtrees
    // and the inner card may not exist yet on this pass.
    if (card.querySelector(CARD_SELECTORS)) continue;

    card.dataset.nrxSeen = "1";
    visibility.observe(card);
  }

  // A preview modal only exists while it is being looked at, so there is
  // nothing to defer — resolve it straight away. Platforms with no metadata
  // row of their own skip the pass entirely rather than hunting for a
  // stand-in: an empty selector would throw, and a guessed one would put the
  // chip somewhere nobody has looked.
  if (MODAL_META) {
    for (const meta of root.querySelectorAll(MODAL_META)) processModal(meta);
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
