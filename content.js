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

    // Which of those cards live in a horizontal carousel. The best-in-row
    // marker needs the distinction because "the row" is only a meaningful unit
    // on the homepage: My List and the genre pages are wrapping grids, where
    // the same mark would just crown whichever tile happened to land in the
    // first line. The three anchors above are the row components and the
    // fourth is the grid one, which is why this is a subset of `cards` rather
    // than a separate measurement — a grid tile is badged on the container
    // itself, a row card on the anchor inside it, so a badge that can reach one
    // of these with closest() is on a row.
    rowCards: [
      '[data-uia="standard-card"]',
      '[data-uia="ranked-card"]',
      '[data-uia="progress-card"]'
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

    // Prime uses one card component everywhere, so nothing here separates a
    // carousel card from a grid card — and the best-in-row marker is wrong the
    // moment it can't tell them apart. Null turns the feature off rather than
    // guessing, which is the same call the modal chip already makes below.
    rowCards: null,

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
const ROW_CARDS = platform.rowCards ? platform.rowCards.join(",") : null;

// Below this many votes a rating is thin evidence. Measured against 430 real
// titles: only ~3% fall under 1,000, so this flags the genuinely shaky ones
// without dimming a quarter of the page (10,000 would flag 28%). It doubles as
// a wrong-match signal — a famous series resolving to 90 votes means the match,
// not the rating, is wrong.
const LOW_VOTE_THRESHOLD = 1000;

// The top of the "under-seen" band: a strong score on fewer votes than this,
// but more than LOW_VOTE_THRESHOLD, is a find rather than a warning.
//
// Both edges come from the same measurement as the threshold above. The floor
// has to be LOW_VOTE_THRESHOLD itself, because under it a high score is more
// often a wrong match than a discovery — a famous title resolving to 90 votes
// is the dash's whole purpose, and promoting that to a recommendation would
// recommend the mistake. The ceiling is the other number that measurement gave
// us: ~28% of 430 real titles sit under 10,000 votes, and requiring green on
// top of that leaves a handful of cards on a homepage rather than one per row.
//
// The honest limit: this cannot tell an under-seen gem from a plausible
// mismatch that happens to clear 1,000 votes, because on the data we have they
// are the same shape. Everything about the marker is therefore sized for being
// wrong sometimes — it is a halo on the badge, not a rosette, and it never
// promotes anything the dash would have flagged.
const GEM_VOTE_MAX = 10000;

// --- the best-in-row marker ----------------------------------------------
// How many comparable titles a row needs before "best" says anything. With two
// it is a coin-flip that flips again as the row fills; three is the smallest
// number where the mark reads as a pick rather than as an accident of which
// cards resolved first.
const ROW_BEST_MIN_RATED = 3;

// How far the walk up from a card may go looking for the element that holds
// the whole row. Netflix's row card sits four levels under its slider's
// content box; this is a bail-out for a DOM that no longer looks like that,
// not a measurement of one that does.
const ROW_ANCESTOR_LIMIT = 8;

// A carousel puts every card on one line, a grid does not. sort.js measures the
// same distinction from the other side (60px, comfortably more than a row's own
// sub-pixel jitter and less than a tile's ~147px height); this is the same test
// with room to spare, and it is what stops the marker appearing on a grid if
// Netflix ever builds one from the row components.
const ROW_LINE_TOLERANCE = 40;

// Ratings land in bursts as a screenful resolves, so the winner is recomputed
// once per burst rather than once per badge — otherwise the mark would visibly
// walk down the row as each card came back.
const ROW_BEST_DELAY = 300;
// A strip is read as a shape, and past a dozen columns the shape stops being
// The RAG thresholds are user-configurable (see options.html). RAG_DEFAULTS
// comes from defaults.js, which the manifest loads before this file. These are
// mutable because a settings change re-colours badges in place — no refetch.
let thresholds = { ...RAG_DEFAULTS };

// The metadata filters, added after defaults.js was written and defaulted here
// so that an options page which has never stored them, or a build of
// defaults.js that predates them, still lands on "off". Each says so in its own
// value — null minutes, "all" kinds, no genres — rather than sharing
// filterEnabled, so a user who picks a genre gets the genre filter without also
// having to arm the rating one.
const META_FILTER_DEFAULTS = {
  filterRuntimeMax: null,
  filterKinds: "all",
  filterGenres: []
};

const FILTER_KEYS = ["filterEnabled", "filterMin", "filterRuntimeMax", "filterKinds", "filterGenres"];

// The dim-filter setting, same deal: mutable, re-applied in place rather than
// re-fetched. Seeded through the same normaliser the two storage paths use —
// with nothing to normalise, so every key lands on its own "off" — because a
// scan can beat start() to the page, and a card badged in that window must be
// judged by exactly the rules a card badged a moment later will be.
let filter = {};
for (const key of FILTER_KEYS) filter[key] = normaliseFilter(key, undefined);

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

// --- the dim filters ------------------------------------------------------
// One rule per question the user can ask, all reading the badge rather than the
// reply, because the reply is long gone by the time a settings change asks
// again. Every one of them answers "pass" when the field it judges is missing:
// absence of information is not failure, and dimming on it would bury exactly
// the new and regional titles the rating rule has always been careful about.
//
// A missing rating is that rule's own version of the same thing — "no data",
// never "low score".
function failsRating(badge) {
  if (!filter.filterEnabled) return false;
  const value = parseFloat(badge.dataset.rating);
  return Number.isFinite(value) && value < filter.filterMin;
}

// Films only, and deliberately so. IMDb's runtimeMinutes for a series is the
// length of one episode, so judging a series on it would dim a five-season show
// for having 45-minute episodes — the opposite of what "nothing over two hours"
// means. A series is exempt rather than failed, and so is anything whose kind
// the worker didn't say, since exempting the unknown is the only reading that
// can't be wrong in that direction.
function failsRuntime(badge) {
  const max = filter.filterRuntimeMax;
  if (!(typeof max === "number" && Number.isFinite(max) && max > 0)) return false;
  if (badge.dataset.kind !== "movie") return false;
  const minutes = Number(badge.dataset.runtime);
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  return minutes > max;
}

function failsKind(badge) {
  const want = filter.filterKinds;
  if (want !== "movies" && want !== "series") return false; // "all", or a value we don't know
  if (!badge.dataset.kind) return false;
  return want === "movies" ? badge.dataset.kind !== "movie" : badge.dataset.kind !== "series";
}

// Sharing one genre is enough. The list reads as "things I'm in the mood for",
// and a title has to be several genres at once for IMDb to file it that way, so
// requiring all of them would dim nearly everything.
function failsGenres(badge) {
  const wanted = filter.filterGenres;
  if (!Array.isArray(wanted) || wanted.length === 0) return false;
  if (!badge.dataset.genres) return false;
  const have = badge.dataset.genres.split("|");
  return !wanted.some((genre) => have.includes(genre));
}

// A card fails on any one of them, which is what makes the filters read as
// "and": each is a condition the title has to survive.
function applyDim(card, badge) {
  const dim = failsRating(badge) || failsRuntime(badge) || failsKind(badge) || failsGenres(badge);
  card.classList.toggle("nrx-dimmed", dim);
}

// The filters run long after the reply arrives — every settings change
// re-evaluates them in place — so what the worker said has to outlive the
// message. Only fields that actually parsed are written, because an absent
// dataset key is precisely what the rules above read as "no data", and a key
// written on a guess is the one way a card could be dimmed for something
// nobody knows about it.
function stampMetadata(badge, result) {
  if (typeof result.titleType === "string" && result.titleType.trim()) {
    badge.dataset.kind = isSeriesType(result.titleType) ? "series" : "movie";
  }

  const minutes = Number(result.runtimeMinutes);
  if (Number.isFinite(minutes) && minutes > 0) badge.dataset.runtime = String(minutes);

  if (Array.isArray(result.genres)) {
    // Lower-cased on both sides of the comparison, so a settings page that
    // stores "Sci-Fi" and a dataset that says "sci-fi" still mean the same
    // genre. The pipe is safe as a separator: no IMDb genre contains one.
    const genres = result.genres
      .filter((genre) => typeof genre === "string" && genre.trim())
      .map((genre) => genre.trim().toLowerCase());
    if (genres.length) badge.dataset.genres = genres.join("|");
  }
}

// --- how sure the badge is ------------------------------------------------
// One attribute with three states, never two attributes, because "thin
// evidence" and "under-seen find" are the same fact read at different vote
// counts and a card must never wear both. Making them values of one key is what
// makes that impossible rather than merely avoided.
//
// Keyed off the user's own green threshold, so a gem is by definition a title
// this user would have called worth watching — which also means the marker has
// to be re-derived whenever that threshold moves, exactly like the tier colours.
function applyConfidence(badge) {
  const votes = Number(badge.dataset.votes);
  const rating = parseFloat(badge.dataset.rating);

  if (!Number.isFinite(votes) || votes <= 0 || !Number.isFinite(rating)) {
    delete badge.dataset.confidence;
  } else if (votes < LOW_VOTE_THRESHOLD) {
    badge.dataset.confidence = "low";
  } else if (votes < GEM_VOTE_MAX && rating >= thresholds.tierHigh) {
    badge.dataset.confidence = "gem";
  } else {
    delete badge.dataset.confidence;
  }

  refreshTip(badge);
}

// The markers are the only thing on a card with no number behind them, so each
// one says in words what it means. They are appended to a stored base rather
// than edited into the tooltip, because both can come and go — a threshold drag
// takes the halo away, a later card in the row takes the underline — and a
// tooltip that accumulated its own history would end up describing a badge that
// no longer looks like that.
function refreshTip(badge) {
  const base = badge.dataset.tipBase;
  if (!base) return; // an unresolved badge has one fixed line and no markers

  const lines = [base];
  if (badge.dataset.confidence === "gem") lines.push("Under-seen: strong score, few votes");
  if (badge.dataset.best) lines.push("Best rated in this row");
  badge.dataset.tip = lines.join("\n");
}

// Changing a threshold changes only which colour a score maps to, never the
// score itself. So we keep the rating on the element and recolour in place
// rather than re-fetching anything. The dim filter piggybacks on the same
// pass, for the same reason.
function recolourAll() {
  // Every surface that carries a rating keeps it in the same place, so one
  // pass over both of them is the whole recolour — including the
  // blocks, which must move tier with the badges or the strip would be
  // colouring by yesterday's thresholds.
  for (const element of document.querySelectorAll(".nrx-badge, .nrx-chip")) {
    const rating = element.dataset.rating;
    if (rating) element.dataset.tier = tierFor(rating);
  }

  // Only .nrx-badge lives on a card; the chip lives inside
  // the hover-preview modal, which isn't a card and is never dimmed. closest()
  // rather than parentElement because the badge's exact depth is hostFor()'s
  // business, not this function's.
  for (const badge of document.querySelectorAll(".nrx-badge")) {
    applyConfidence(badge); // the gem band moves with the green threshold
    const card = badge.closest(CARD_SELECTORS);
    if (card) applyDim(card, badge);
  }

  // Last, because both of its inputs were just rewritten: the floor is the
  // green threshold, and a card the filter has only now dimmed must not still
  // be a row's recommendation.
  refreshAllRows();
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

// --- the best card in a row -----------------------------------------------
// A Netflix row is thirty seconds of scanning for something that might be good.
// The badges already answer that per card, but the answer only exists once you
// have read all of them — so the row's own best is marked, and a row you would
// have skimmed past says which card was worth stopping on.
//
// Rows only. On My List and the genre pages the tiles wrap, "the row" is a
// consequence of the window width, and a mark on the first line would be
// meaningless; ROW_CARDS is null on platforms where the two can't be told
// apart, and the one-line test below is the second line of defence.

// The row container is derived rather than named, for the same reason sort.js
// derives its grid: Netflix's class names are CSS-in-JS hashes that change on
// every deploy. The first ancestor holding more than one row card is the
// element that holds the row — anything below it wraps a single card, and
// anything above it holds every row on the page.
function rowOf(card) {
  let node = card.parentElement;
  for (let depth = 0; node && depth < ROW_ANCESTOR_LIMIT; depth++, node = node.parentElement) {
    if (node.querySelectorAll(ROW_CARDS).length > 1) return node;
  }
  return null;
}

// Rows resolve card by card, so the winner is provisional until the row is
// full. Recomputing the whole row from scratch — clear every mark, then set
// one — is what keeps it to one card as the winner moves: there is no state to
// go stale, only the current best of whatever has resolved so far.
function markBestInRow(row) {
  const badges = row.querySelectorAll(".nrx-badge[data-rating]");

  let top = Infinity;
  let bottom = -Infinity;
  let candidates = 0; // eligible to win
  let rated = 0;      // available to compare
  let best = null;
  let bestValue = -Infinity;

  for (const badge of badges) {
    const value = parseFloat(badge.dataset.rating);
    if (!Number.isFinite(value)) continue;

    // Measured off the badges we are already walking rather than by a second
    // pass over the cards. A zero-width box is a card the carousel has parked
    // off its own edge, which has no position worth reading.
    const box = badge.getBoundingClientRect();
    if (!box.width) continue;
    top = Math.min(top, box.top);
    bottom = Math.max(bottom, box.top);

    // A dashed badge is as likely to be a wrong match as a discovery, and
    // Counted before the exclusions, because the minimum below asks how many
    // ratings there are to compare — not how many are allowed to win. Counting
    // after meant that switching the dim filter on removed most of a row from
    // the tally and silently turned this feature off: measured on a real
    // homepage, rows of seven rated cards were left with one or two eligible
    // and never reached a minimum of three.
    rated++;

    // crowning a row with one would put the extension's loudest mark on its
    // least reliable number.
    if (badge.dataset.confidence === "low") continue;

    // Nor can a card the user's own filter has just pushed back be the thing
    // the row recommends — that is the marker arguing with the filter.
    const card = badge.closest(CARD_SELECTORS);
    if (card && card.classList.contains("nrx-dimmed")) continue;

    candidates++;
    if (value > bestValue) {
      bestValue = value;
      best = badge;
    }
  }

  // Nothing was laid out — a row Netflix has collapsed rather than one with no
  // good card in it. Leaving it untouched keeps its existing mark for when it
  // comes back, since nothing would queue this row again to restore one.
  if (!Number.isFinite(top)) return;

  // More than one line means this is not a carousel, and the safe answer is to
  // leave it entirely alone — including any marks already on it, which belong
  // to whichever row pass actually understood the layout.
  if (bottom - top > ROW_LINE_TOLERANCE) return;

  // Two conditions for saying nothing, and both are about noise: too few
  // titles to compare, or a winner that isn't worth pointing at. The floor is
  // the user's own green threshold rather than a number of ours, because that
  // is where they have already said "worth it" — a row topping out at 5.9 gets
  // no mark, and someone who runs a strict threshold gets marks on fewer rows
  // rather than the same marks with a different meaning.
  if (rated < ROW_BEST_MIN_RATED || !candidates || bestValue < thresholds.tierHigh) best = null;

  for (const badge of badges) {
    if (badge === best) {
      if (badge.dataset.best) continue;
      badge.dataset.best = "1";
    } else if (badge.dataset.best) {
      delete badge.dataset.best;
    } else {
      continue;
    }
    refreshTip(badge);
  }
}

// Ratings arrive in bursts, so rows are collected and settled once the burst is
// over — the same bargain the page scan already makes with its own debounce.
const pendingRows = new Set();
let rowTimer = null;

function noteRowCard(card) {
  if (!ROW_CARDS || !card.matches(ROW_CARDS)) return;
  const row = rowOf(card);
  if (!row) return; // a row with one card resolved so far has nothing to compare

  pendingRows.add(row);
  clearTimeout(rowTimer);
  rowTimer = setTimeout(flushRows, ROW_BEST_DELAY);
}

function flushRows() {
  rowTimer = null;
  const rows = [...pendingRows];
  pendingRows.clear();
  // Netflix rebuilds rows as you scroll, so a container queued a moment ago may
  // no longer be on the page; marking one is work nobody will see.
  for (const row of rows) if (row.isConnected) markBestInRow(row);
}

// The settings path, where every row is stale at once rather than one row being
// newly filled. Rare enough — a threshold drag, a filter change — that walking
// the page beats keeping an index of rows in sync with Netflix's churn.
function refreshAllRows() {
  if (!ROW_CARDS) return;

  const rows = new Set();
  for (const badge of document.querySelectorAll(".nrx-badge[data-rating]")) {
    const card = badge.closest(ROW_CARDS);
    if (!card) continue; // a grid tile: no row to be best in
    const row = rowOf(card);
    if (row) rows.add(row);
  }
  for (const row of rows) markBestInRow(row);
}

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
    // the badge mislead by omission — and an 8.9 from 3,000 is a third thing
    // again, worth pointing at rather than warning about. The vote count is
    // kept on the element so applyConfidence() can be asked again later; which
    // of the three a card is depends on a threshold the user can move.
    if (Number.isFinite(result.votes) && result.votes > 0) {
      badge.dataset.votes = String(result.votes);
    }
    stampMetadata(badge, result);

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

    // The markers append their own lines to this; see refreshTip().
    badge.dataset.tipBase = tip;
    badge.dataset.tip = tip;
    applyConfidence(badge);
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
  const card = host.closest(CARD_SELECTORS) || host;
  applyDim(card, badge);

  // After the dim, because a card that has just been filtered out is not
  // eligible to be its row's pick. Only a card with a score can change the
  // winner; a grey "—" leaves the row exactly as it was.
  if (badge.dataset.rating) noteRowCard(card);
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

// The metadata row says either "2 Seasons" or "1h 52m", and which one it is
// settles a question the title alone cannot: a name that belongs to both a
// film and a series gives the worker nothing to choose on, and it resolves
// whichever entry scores better on the name. The page is already showing the
// answer; this just forwards it.
//
// Deliberately narrow, because a wrong hint is worse than none — it would push
// the worker away from a match it would have found unaided. Netflix localises
// this row, so these patterns only fire on English wording, and text carrying
// both signals or neither returns null rather than picking a side.
function hintFromModalMeta(meta) {
  const text = meta.textContent || "";
  const series = /\b\d+\s*(seasons?|episodes?)\b/i.test(text);
  const movie = /\b\d{1,2}\s*h(\s*\d{1,2}\s*m)?\b/i.test(text) || /\b\d{1,3}\s*m\b/i.test(text);

  if (series === movie) return null; // both, or neither
  return { kind: series ? "series" : "movie" };
}

// The worker's titleType is IMDb's own vocabulary ("tvSeries", "tvMiniSeries")
// while the hint above speaks in "series"/"movie", and a field arriving in
// either dialect should read the same way here. Substring rather than a list,
// so a value nobody anticipated still reads as episodic; "movie", "tvMovie"
// and "tvEpisode" cannot match it by accident.
function isSeriesType(titleType) {
  return typeof titleType === "string" && titleType.toLowerCase().includes("series");
}

// Whether a series finished is the one thing Netflix never says, and it is
// what decides whether five seasons are a commitment or a cliffhanger nobody
// resolved. Only stated when the worker is sure: isEnded has to be a real
// boolean, and an ended series with no end year says nothing rather than
// inventing a date — or, worse, calling itself still running. Everything the
// worker doesn't send (an older build, an import that hasn't run) lands here
// as null and the chip stays exactly as it was.
function runStatusFor(result) {
  if (!isSeriesType(result.titleType)) return null;
  if (typeof result.isEnded !== "boolean") return null;
  if (result.isEnded) return result.endYear ? `ended ${result.endYear}` : null;
  return result.endYear ? null : "still running";
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

    // Context, not a verdict, so it is appended in the same muted key as the
    // alias below rather than competing with the score. It stays out of the
    // card badge entirely: that badge is one glanceable number, and a number
    // with a clause after it is no longer glanceable.
    const status = runStatusFor(result);
    if (status) {
      const state = document.createElement("span");
      state.className = "nrx-chip-status";
      state.textContent = `· ${status}`;
      chip.appendChild(state);
    }

    if (result.exact === false && result.label) {
      const alias = document.createElement("span");
      alias.className = "nrx-chip-alias";
      alias.textContent = `· ${result.label}`;
      chip.appendChild(alias);
    }
  }

  meta.insertBefore(chip, meta.firstChild);
}

// Netflix rebuilds the preview modal as the pointer crosses a row, and reuses
// the nodes: a metadata row that was Dexter a moment ago is The Mentalist now.
// A reply that arrives after that swap must not paint. Each pass stamps its
// own number on the element, and anything coming back to find a different
// stamp — or an element no longer in the document — is answering a question
// nobody is asking any more.
let modalPass = 0;

async function processModal(meta) {
  if (meta.dataset.nrxDone) return;
  meta.dataset.nrxDone = "1";

  const title = titleFromModal(meta);
  if (!title) { delete meta.dataset.nrxDone; return; }

  const pass = String(++modalPass);
  meta.dataset.nrxPass = pass;
  const stillCurrent = () => meta.isConnected && meta.dataset.nrxPass === pass;

  // Read before anything of ours is inserted into the row, so the hint comes
  // from Netflix's text and never from the chip we are about to add.
  const hint = hintFromModalMeta(meta);

  const lookup = { type: "lookup", title };
  if (hint) lookup.hint = hint;

  let result;
  try {
    result = await chrome.runtime.sendMessage(lookup);
  } catch (e) {
    return;
  }
  if (!result) return;
  if (result.error) { delete meta.dataset.nrxDone; return; }
  if (!stillCurrent()) return;

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

// Settings are read in one place, on both paths, because a stored value is
// whatever the last version of the options page happened to write — and a
// filterGenres that arrived as a string, or a filterRuntimeMax of 0, would
// otherwise dim a page nobody asked to have dimmed. Anything unrecognised
// lands on the setting's own "off" value rather than being applied literally:
// a filter is a thing the user turned on, so uncertainty means off.
function normaliseFilter(key, value) {
  switch (key) {
    case "filterEnabled":
      return typeof value === "boolean" ? value : FILTER_DEFAULTS.filterEnabled;
    case "filterMin":
      return typeof value === "number" && Number.isFinite(value) ? value : FILTER_DEFAULTS.filterMin;
    case "filterRuntimeMax":
      return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : META_FILTER_DEFAULTS.filterRuntimeMax;
    case "filterKinds":
      return value === "movies" || value === "series" ? value : META_FILTER_DEFAULTS.filterKinds;
    case "filterGenres":
      // Lower-cased here so the comparison in failsGenres() is a plain
      // includes() against what stampMetadata() wrote, rather than a case fold
      // repeated once per card per pass.
      return Array.isArray(value)
        ? value
            .filter((genre) => typeof genre === "string" && genre.trim())
            .map((genre) => genre.trim().toLowerCase())
        : [];
    default:
      return value;
  }
}

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
  for (const key of FILTER_KEYS) {
    if (changes[key]) {
      filter[key] = normaliseFilter(key, changes[key].newValue);
      touched = true;
    }
  }
  if (touched) recolourAll();
});

// Load saved thresholds before the first scan, so nothing is ever painted with
// the wrong colours and then corrected a moment later.
(async function start() {
  try {
    const saved = await chrome.storage.local.get(["tierHigh", "tierMid", ...FILTER_KEYS]);
    thresholds = {
      tierHigh: typeof saved.tierHigh === "number" ? saved.tierHigh : RAG_DEFAULTS.tierHigh,
      tierMid: typeof saved.tierMid === "number" ? saved.tierMid : RAG_DEFAULTS.tierMid
    };
    filter = {};
    for (const key of FILTER_KEYS) filter[key] = normaliseFilter(key, saved[key]);
  } catch (e) {
    // Storage unavailable is not fatal — the defaults are perfectly usable.
  }
  scan();
})();
