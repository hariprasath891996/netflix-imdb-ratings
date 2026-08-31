// Runs inside the Netflix page. Finds title cards, asks the background worker
// for an IMDb rating, and pins a small badge onto each card.
//
// Netflix is a single-page app that builds cards lazily as you scroll, so there
// is no single "page is ready" moment to hook. Two observers handle that:
//   - a MutationObserver notices cards being added to the DOM
//   - an IntersectionObserver holds the lookup until a card is actually on
//     screen, so scrolling past three rows doesn't spend quota on thirty.

const CARD_SELECTORS = [
  ".title-card",
  ".slider-item",
  ".title-card-container"
].join(",");

const TIER_HIGH = 7.5;
const TIER_MID = 6.5;

let warnedAboutKey = false;

// --- reading a title off a card ------------------------------------------
// Netflix does not hand us a clean data attribute, and the class names change
// every few months. So: try the most reliable sources in order, and give up
// quietly rather than badging the wrong film.
function titleFromCard(card) {
  const fallback = card.querySelector(".fallback-text");
  if (fallback && fallback.textContent.trim()) {
    return clean(fallback.textContent);
  }

  const img = card.querySelector("img[alt]");
  if (img && img.alt.trim()) {
    return clean(img.alt);
  }

  const labelled = card.querySelector("[aria-label]");
  if (labelled) {
    const label = labelled.getAttribute("aria-label");
    if (label && label.trim()) return clean(label);
  }

  return null;
}

function clean(raw) {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^watch\s+/i, "")
    .replace(/\s+(now|on netflix)$/i, "")
    .trim();
}

// The badge is positioned absolutely, so it needs a positioned ancestor.
// Netflix's boxart container usually already is one, but not always.
function hostFor(card) {
  return card.querySelector(".boxart-container, .boxart-size-16x9") || card;
}

function tierFor(rating) {
  const value = parseFloat(rating);
  if (Number.isNaN(value)) return "unknown";
  if (value >= TIER_HIGH) return "high";
  if (value >= TIER_MID) return "mid";
  return "low";
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
    badge.dataset.tier = tierFor(result.rating);
    badge.textContent = result.rating;
    badge.title = result.votes
      ? `IMDb ${result.rating} · ${result.votes} votes${result.year ? ` · ${result.year}` : ""}`
      : `IMDb ${result.rating}`;
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
    if (result.error === "no-key" && !warnedAboutKey) {
      warnedAboutKey = true;
      console.info(
        "[IMDb for Netflix] No API key set yet — click the extension icon and paste your free OMDb key."
      );
    }
    if (result.error === "bad-key" && !warnedAboutKey) {
      warnedAboutKey = true;
      console.warn("[IMDb for Netflix] OMDb rejected that API key.");
    }
    delete card.dataset.nrxDone; // let it retry once the key is fixed
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
scan();
