// The browse surface, minus the two things it does at you rather than for you.
//
// Netflix starts a trailer when your cursor rests on a card, and a second one,
// full width and with sound, at the top of the homepage. Both fight this
// extension directly: the hover preview swallows the card whose badge you were
// reading, and the billboard talks over the page while you read it. Neither is
// a rating question, which is the point — nothing in this file reads IMDb data.
//
// The second half of the file removes Continue Watching entries. Read the
// LOCAL HIDING ONLY block above hideTitle() before changing anything there.
//
// Content scripts injected into the same world share one global lexical scope,
// so a top-level `const` here would collide with content.js's, sort.js's or
// genres.js's and throw before any of them ran. Everything below is closed
// over instead.
(function () {
  "use strict";

  // The manifest injects this file on Prime Video, Amazon and Disney+ too,
  // where every selector below is meaningless and the autoplay behaviour is a
  // different site's to argue with. Netflix only.
  if (!/(^|\.)netflix\.com$/.test(location.hostname)) return;

  // --- what we hang off ------------------------------------------------------
  // Netflix styles itself with CSS-in-JS, so class names like
  // "default-ltr-iqcdef-cache-19c3xp8" change on every deploy and are useless
  // to select on. `data-uia` attributes are its own test-automation hooks:
  // semantic, and stable because Netflix's QA depends on them. content.js
  // already relies on the four card selectors, measured on the live site.
  const PROGRESS_CARD = '[data-uia="progress-card"]';
  const OTHER_CARDS =
    '[data-uia="standard-card"],[data-uia="ranked-card"],[data-uia="title-card-container"]';
  const ANY_CARD = PROGRESS_CARD + "," + OTHER_CARDS;

  // The hover preview. content.js reaches this from the inside with
  // closest('[class*="previewModal"]'); this file looks top-down, so it also
  // accepts the data-uia spelling and picks the outermost match.
  const PREVIEW_MODAL = '[class*="previewModal"],[data-uia*="previewModal"]';

  // The homepage hero. Unlike the hashed component classes, "billboard" is a
  // long-lived semantic name in Netflix's markup — but it is still only the
  // fast path: classify() falls back to geometry when none of this matches.
  const BILLBOARD = '.billboard-row,.billboard,[data-uia*="billboard"]';

  // Only partly-watched titles carry a progress bar, which is what makes a
  // preview modal one of the Continue Watching row's rather than any other's.
  const PROGRESS_BAR = 'progress,[data-uia*="progress"],[class*="progress-bar"]';

  // The real player. The URL check is the guard that matters; this is the belt
  // to its braces, for the moment between Netflix mounting the player and the
  // history entry landing.
  const PLAYER_SURFACES = '.watch-video,.nfp,[data-uia="video-canvas"]';

  // --- how far we will go ----------------------------------------------------
  // A feature film is not a trailer. Anything that reports a duration longer
  // than this is real content and is left alone whatever else we think, so the
  // worst a misfire below can do is fail to stop a preview.
  const REAL_CONTENT_SECONDS = 900;

  // Netflix may well call play() again after we pause. It is allowed to win
  // eventually: after this many rounds on one element we stand down, because a
  // trailer playing is a nuisance and a pause/play loop is a broken page.
  const MAX_STOPS = 10;

  // A play() this soon after a real click or Enter is the user asking for it —
  // the billboard's own replay control, most likely. We suppress autoplay, not
  // playback, so that video is approved for the rest of its life.
  const GESTURE_GRACE_MS = 1200;

  // How far up from a card the search for its row may walk before giving up.
  // A bail-out for a DOM that no longer looks like today's, not a measurement
  // of one that does. content.js uses 8 for the same kind of walk.
  const ROW_ASCENT_LIMIT = 12;

  // Netflix rebuilds in bursts; a burst should cost one pass. Same 250ms
  // content.js settled on.
  const PASS_DELAY = 250;

  // Long enough to read and reach, short enough not to sit over the page.
  const TOAST_MS = 7000;

  // --- settings --------------------------------------------------------------
  // WATCH_DEFAULTS comes from defaults.js, which the manifest loads before this
  // file. Read, never redefined — a second copy of a default is a second thing
  // to forget to change. The literals here are only reached if defaults.js is
  // missing entirely, which would mean a broken build rather than a stale one.
  const KEYS = [
    "stopAutoplayPreviews",
    "stopAutoplayBillboard",
    "hideContinueWatching",
    "hiddenTitles"
  ];

  const LAST_RESORT = {
    stopAutoplayPreviews: true,
    stopAutoplayBillboard: true,
    hideContinueWatching: false,
    hiddenTitles: []
  };

  function fallback(key) {
    const source = typeof WATCH_DEFAULTS === "object" && WATCH_DEFAULTS ? WATCH_DEFAULTS : null;
    return source && key in source ? source[key] : LAST_RESORT[key];
  }

  // A stored value is whatever the last version of the options page happened to
  // write, so nothing is trusted by shape. Anything unrecognised lands on the
  // setting's own default rather than being applied literally: a hiddenTitles
  // that arrived as a string would otherwise hide every card whose title shared
  // a character with it.
  function normalise(key, value) {
    switch (key) {
      case "stopAutoplayPreviews":
      case "stopAutoplayBillboard":
      case "hideContinueWatching":
        return typeof value === "boolean" ? value : fallback(key);
      case "hiddenTitles":
        return Array.isArray(value)
          ? value.filter((title) => typeof title === "string" && title.trim()).map((title) => title.trim())
          : [];
      default:
        return value;
    }
  }

  const settings = {};
  for (const key of KEYS) settings[key] = normalise(key, undefined);

  // Comparison keys are derived once per settings change rather than once per
  // card per pass, and hiddenTitles keeps the user's own spelling so the
  // options page can list back what they actually saw.
  let hiddenKeys = new Set();

  function rebuildKeys() {
    hiddenKeys = new Set(settings.hiddenTitles.map(titleKey).filter(Boolean));
  }

  // --- reading a title off a card --------------------------------------------
  // Deliberately a local copy of what content.js does rather than a call into
  // it. content.js is not wrapped in an IIFE today, so its helpers happen to be
  // reachable from here — but that is an accident of its file layout, not an
  // interface, and a feature that hides cards must not stop working the day
  // somebody tidies another file. genres.js makes the same call.
  function titleOf(element) {
    const own = element.getAttribute("aria-label");
    if (own && own.trim()) return clean(own);

    const labelled = element.querySelector("[aria-label]");
    const inner = labelled && labelled.getAttribute("aria-label");
    if (inner && inner.trim()) return clean(inner);

    const image = element.querySelector("img[alt]");
    if (image && image.alt.trim()) return clean(image.alt);

    return null;
  }

  // Inside a preview modal the artwork's alt text is the title, while the first
  // [aria-label] is usually a control ("Play", "Add to My List"). Same three
  // sources as above, different order, for the same reason content.js reads the
  // modal's image rather than its labels.
  function modalTitle(modal) {
    const image = modal.querySelector("img[alt]");
    if (image && image.alt.trim()) return clean(image.alt);
    return titleOf(modal);
  }

  // Netflix labels use typographic punctuation where a stored string will have
  // the plain ASCII forms — the same normalisation content.js does before a
  // lookup, and for the same reason: a curly apostrophe that misses is a card
  // the user hid that comes back tomorrow.
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

  // Case and spacing are not decisions the user made, so they do not decide
  // whether a hide sticks.
  function titleKey(raw) {
    return typeof raw === "string" ? clean(raw).toLowerCase() : "";
  }

  // ===========================================================================
  // Feature 37 — stop autoplay
  // ===========================================================================
  //
  // The mechanism is deliberately the dullest one available: listen for `play`
  // in the capture phase at the document, and pause what we did not want. Media
  // events do not bubble but they do capture, so one listener covers every
  // <video> the page will ever create — no per-element wiring, nothing to
  // re-attach when Netflix re-renders, and no dependency on where in the DOM
  // the video sits.
  //
  // Patching HTMLMediaElement.prototype.play would be the tidy version and is
  // not available to us: content scripts run in an isolated world, so the patch
  // would only ever intercept our own calls, and reaching the page's world
  // needs an injected <script> that Netflix's CSP blocks anyway.
  //
  // Everything here is arranged so that failure means "the trailer plays". It
  // never removes the modal (content.js renders its IMDb chip into that
  // modal's metadata row), never navigates, and never touches a video the user
  // asked to play.

  // Attempts per element, so Netflix can win rather than the two of us
  // deadlocking. WeakMap because these elements are torn down constantly.
  const stops = new WeakMap();

  // Videos the user started by hand. Once in here, never suppressed again.
  const approved = new WeakSet();

  let lastGesture = 0;

  function isWatchPage() {
    // Read at event time, never cached: Netflix navigates client-side, and a
    // cached answer from before the user pressed Play is the one way this
    // feature could ever pause the actual film.
    return /^\/watch(\/|$)/.test(location.pathname);
  }

  function leaveAlone(video) {
    // THE GUARD THAT MATTERS. Nothing on /watch/ is ever touched, whatever it
    // looks like and whatever the settings say. If you are editing this file
    // and are tempted to move this check, don't: every other line here is a
    // convenience, and this one is the difference between an extension that
    // stops trailers and an extension that stops films.
    if (isWatchPage()) return true;
    if (video.closest(PLAYER_SURFACES)) return true;

    if (approved.has(video)) return true;

    const duration = video.duration;
    if (Number.isFinite(duration) && duration > REAL_CONTENT_SECONDS) return true;

    return (stops.get(video) || 0) >= MAX_STOPS;
  }

  // Which of the two settings governs this video. The attribute paths are the
  // confident ones; the geometry fallback exists so that a Netflix rename costs
  // us the ability to tell the two apart rather than the whole feature.
  function classify(video) {
    if (video.closest(PREVIEW_MODAL)) return { kind: "preview", confident: true };
    if (video.closest(BILLBOARD)) return { kind: "billboard", confident: true };

    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return { kind: "unknown", confident: false };

    // The billboard is the one video that spans most of the window and sits at
    // the very top of the document. A preview modal is roughly one and a half
    // cards wide and can be anywhere. Both tests have to pass, so a modal over
    // the first row cannot be mistaken for the hero.
    const wide = rect.width >= innerWidth * 0.7;
    const atTop = rect.top + scrollY < innerHeight * 0.5;
    if (wide && atTop) return { kind: "billboard", confident: false };

    return { kind: "unknown", confident: false };
  }

  // An unclassified video on a browse page is treated as a hover preview,
  // because on this site that is what nearly all of them are. The cost of the
  // choice, if Netflix renames the billboard: a user who switched previews off
  // but wanted the hero trailer kept would lose it too, and a user who did the
  // opposite would keep both. Both are "the setting stopped being precise",
  // which is the failure this whole file is arranged around.
  function wanted(kind) {
    return kind === "billboard" ? settings.stopAutoplayBillboard : settings.stopAutoplayPreviews;
  }

  function stop(video, classification) {
    stops.set(video, (stops.get(video) || 0) + 1);

    try {
      // Muted first: pause() takes effect on the next tick, and this is what
      // makes the difference between silence and a syllable of trailer.
      video.muted = true;
      video.autoplay = false;
      video.pause();
    } catch (e) {
      // A video being torn down mid-call throws. There is nothing to fix and
      // nothing to tell the user, and letting it escape would take the rest of
      // the pass with it.
      return;
    }

    // Hiding is cosmetic and only ever applied where we are sure: a paused
    // billboard would otherwise sit on a frozen first frame instead of the
    // still hero artwork Netflix has already loaded behind it. The preview
    // modal is deliberately left visible — it carries content.js's IMDb chip,
    // and removing it would break another feature to fix this one.
    if (classification.kind === "billboard" && classification.confident) {
      video.classList.add("nrx-browse-stilled");
    }
  }

  function consider(video) {
    if (!(video instanceof HTMLMediaElement)) return;
    if (leaveAlone(video)) return;

    // A play() within a moment of a real click or Enter is the user's, not
    // Netflix's. This is what keeps the billboard's own replay button working,
    // and it is why hovering — which produces no gesture — is unaffected.
    if (Date.now() - lastGesture < GESTURE_GRACE_MS) {
      approved.add(video);
      video.classList.remove("nrx-browse-stilled");
      return;
    }

    const classification = classify(video);
    if (!wanted(classification.kind)) return;

    stop(video, classification);
  }

  // Only Enter and Space count as keyboard activation. Arrow keys move focus
  // along a row, and if Netflix ever opens a preview on focus, counting those
  // would hand every keyboard user the autoplay we just took away.
  function noteGesture(event) {
    if (!event.isTrusted) return;
    lastGesture = Date.now();
  }

  addEventListener("pointerdown", noteGesture, { capture: true, passive: true });
  addEventListener("touchstart", noteGesture, { capture: true, passive: true });
  addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") noteGesture(event);
    },
    { capture: true, passive: true }
  );

  // `play` fires on the request, `playing` when frames start; both are caught
  // because a video that was already loading when this script ran will only
  // announce the second.
  addEventListener("play", (event) => consider(event.target), { capture: true });
  addEventListener("playing", (event) => consider(event.target), { capture: true });

  // For anything already running when the page loaded or when the setting was
  // switched on mid-session — no event is coming for those.
  function sweepVideos() {
    if (!settings.stopAutoplayPreviews && !settings.stopAutoplayBillboard) return;
    for (const video of document.querySelectorAll("video")) {
      if (!video.paused) consider(video);
    }
  }

  // Switching the setting off un-hides immediately; it deliberately does not
  // start anything playing. Nobody turns off "stop autoplay" to be handed a
  // trailer they were not watching a second ago.
  function releaseVideos() {
    for (const video of document.querySelectorAll("video.nrx-browse-stilled")) {
      if (!wanted(classify(video).kind)) video.classList.remove("nrx-browse-stilled");
    }
  }

  // ===========================================================================
  // Feature 42 — remove Continue Watching entries
  // ===========================================================================

  function continueRow(card) {
    // Netflix tags its homepage rows with the list they were built from. When
    // it is there this is exact, and it is the only thing here that knows the
    // row by name — the text is localised, so matching "Continue Watching"
    // would work in English and nowhere else.
    const tagged = card.closest('[data-list-context="continueWatching"]');
    if (tagged) return tagged;

    // Structural fallback, which depends on no class name at all: Continue
    // Watching is the one row made entirely of progress cards. Walk up while
    // no other kind of card is in scope; the first ancestor that swallows one
    // belongs to the page rather than to the row, so the last one that did not
    // is the row — header included, which is what makes the whole thing go.
    let node = card.parentElement;
    let row = null;
    let depth = 0;

    while (node && depth++ < ROW_ASCENT_LIMIT) {
      if (node === document.body || node.tagName === "MAIN") break;
      if (node.id === "appMountPoint" || node.matches('[data-uia="main-view"]')) break;
      if (node.querySelector(OTHER_CARDS)) break;
      row = node;
      node = node.parentElement;
    }

    return row;
  }

  // Hiding the card anchor alone leaves its slider slot behind as a gap, so the
  // row reads as broken rather than shorter. Climbing to the wrapper that holds
  // only this card closes the gap; the depth cap is what stops a row with one
  // remaining item from taking the row with it.
  function slotFor(card) {
    let node = card;
    let depth = 0;

    while (node.parentElement && depth++ < 3) {
      const parent = node.parentElement;
      if (parent.querySelectorAll(ANY_CARD).length !== 1) break;
      node = parent;
    }

    return node;
  }

  // --- LOCAL HIDING ONLY -----------------------------------------------------
  // This adds a string to chrome.storage.local and sets display:none. That is
  // the entire mechanism, and it is a decision rather than a shortcut.
  //
  // Netflix has its own remove-from-row endpoint, and calling it would look
  // like an improvement: the row would be tidy on the phone and the television
  // too. Do not. It is an authenticated write against the user's real account,
  // it is irreversible from here, it would make an extension that reads a page
  // into one that edits somebody's viewing history, and a bug in it would
  // destroy data we have no way to give back.
  //
  // Everything below is reversible by emptying hiddenTitles in the options
  // page. Nothing leaves the browser. If you are about to make this "actually
  // remove" the title, you are about to break the promise the feature is sold
  // on — go and read the contract instead.
  function setHidden(next) {
    settings.hiddenTitles = next;
    rebuildKeys();
    applyContinueWatching();

    try {
      // Optimistic: the DOM is already updated above, so a storage failure
      // costs the user the memory of the hide rather than the hide itself.
      chrome.storage.local.set({ hiddenTitles: next });
    } catch (e) {
      // Storage gone is not fatal — the hide holds for this page and is
      // forgotten on reload, which is the harmless direction to fail in.
    }
  }

  function hideTitle(raw) {
    const title = typeof raw === "string" ? clean(raw) : "";
    const key = titleKey(title);
    if (!key || hiddenKeys.has(key)) return;

    setHidden(settings.hiddenTitles.concat(title));
    showToast(title);
  }

  function unhideTitle(title) {
    const key = titleKey(title);
    setHidden(settings.hiddenTitles.filter((stored) => titleKey(stored) !== key));
  }

  // --- the dismiss control ---------------------------------------------------
  function makeDismiss(title, variant) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nrx-browse-dismiss" + (variant ? " nrx-browse-dismiss--" + variant : "");

    // A multiplication sign rather than an X, and no icon font: this has to
    // stay legible at 200% zoom on top of arbitrary artwork.
    button.textContent = "×";
    button.setAttribute("aria-label", 'Hide "' + title + '" from Continue Watching');

    // The card is an anchor and the modal is covered in Netflix's own click
    // handlers, so every way of pressing this button has to be stopped from
    // also counting as pressing what it sits on. Without this, dismissing a
    // title would navigate to it.
    const swallow = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    button.addEventListener("pointerdown", swallow);
    button.addEventListener("mousedown", swallow);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      swallow(event);
      hideTitle(title);
    });

    return button;
  }

  function decorateCard(card) {
    const existing = card.querySelector(":scope > .nrx-browse-dismiss");
    const title = titleOf(card);

    // A card with no readable title cannot be hidden by name, so it must not
    // offer a control that claims otherwise — including one left behind from
    // whatever this recycled card used to be.
    if (!title) {
      if (existing) existing.remove();
      return;
    }

    if (existing) {
      // The card is recycled as the row scrolls, so the button may now be
      // sitting on a different title than the one it was labelled for.
      if (existing.dataset.title === title) return;
      existing.remove();
    }

    // content.css already gives Netflix cards a positioning context via
    // .nrx-host, but only once content.js has badged them — which it may never
    // do if the rating lookup is still cold. Our own class restates it so the
    // button is never pinned to some far ancestor.
    card.classList.add("nrx-browse-anchor");

    const button = makeDismiss(title, null);
    button.dataset.title = title;
    card.appendChild(button);
  }

  // The hover preview expands over the card and takes the button on it out of
  // reach, so the same control is offered on the modal. Only where a matching
  // progress card is actually on the page: the preview modal for a partly
  // watched title looks the same wherever it was opened from, and a dismiss
  // button on a title that is not in the row would promise something this
  // feature does not do.
  function decorateModals(cardKeys) {
    if (!cardKeys.size) return;

    const modals = Array.from(document.querySelectorAll(PREVIEW_MODAL)).filter(
      (modal) => !modal.parentElement || !modal.parentElement.closest(PREVIEW_MODAL)
    );

    for (const modal of modals) {
      if (!modal.querySelector(PROGRESS_BAR)) continue;

      const title = modalTitle(modal);
      if (!title || !cardKeys.has(titleKey(title))) continue;

      const existing = modal.querySelector(":scope > .nrx-browse-dismiss");
      if (existing) {
        if (existing.dataset.title === title) continue;
        existing.remove();
      }

      modal.classList.add("nrx-browse-anchor");
      const button = makeDismiss(title, "modal");
      button.dataset.title = title;
      modal.appendChild(button);
    }
  }

  // --- the undo toast --------------------------------------------------------
  // A hide with no visible way back is a trap: the only other undo is a trip to
  // the options page, and the user has just watched a card vanish.
  let toast = null;
  let toastTimer = null;

  function showToast(title) {
    hideToast();

    toast = document.createElement("div");
    toast.className = "nrx-browse-toast";
    toast.setAttribute("role", "status");

    const label = document.createElement("span");
    label.className = "nrx-browse-toast-label";
    label.textContent = "Hidden from Continue Watching: " + title;

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "nrx-browse-toast-undo";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => {
      unhideTitle(title);
      hideToast();
    });

    toast.append(label, undo);
    document.body.appendChild(toast);

    toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    if (toast && toast.isConnected) toast.remove();
    toast = null;
  }

  // --- one pass over the page ------------------------------------------------
  function applyContinueWatching() {
    // Every pass starts from a clean slate and re-decides, rather than tracking
    // what it hid last time. Un-hiding a title, or switching the row back on,
    // is then the same code path as hiding one — and there is no state to go
    // stale when Netflix rebuilds the row underneath us. The clear and the
    // re-apply happen in one synchronous pass, so nothing flashes.
    for (const element of document.querySelectorAll(".nrx-browse-hidden")) {
      element.classList.remove("nrx-browse-hidden");
    }
    for (const element of document.querySelectorAll(".nrx-browse-row-hidden")) {
      element.classList.remove("nrx-browse-row-hidden");
    }

    const cards = document.querySelectorAll(PROGRESS_CARD);
    if (!cards.length) return;

    if (settings.hideContinueWatching) {
      const row = continueRow(cards[0]);
      if (row) {
        row.classList.add("nrx-browse-row-hidden");
        return; // Nothing inside a hidden row is worth decorating.
      }
    }

    const cardKeys = new Set();

    for (const card of cards) {
      decorateCard(card);

      const key = titleKey(titleOf(card) || "");
      if (!key) continue;
      cardKeys.add(key);

      if (hiddenKeys.has(key)) slotFor(card).classList.add("nrx-browse-hidden");
    }

    decorateModals(cardKeys);
  }

  // --- wiring ----------------------------------------------------------------
  function pass() {
    // The player page has none of this on it — no browse rows, and no video
    // this file is ever allowed to touch. Leaving early is partly economy (the
    // observer fires constantly while a film plays) and partly one more layer
    // between us and the one thing that must never break.
    if (isWatchPage()) return;

    try {
      sweepVideos();
      applyContinueWatching();
    } catch (e) {
      // One malformed pass must not take the observer or the settings listener
      // with it. The next pass starts from the DOM as it is and re-decides
      // everything, so a single failure costs nothing beyond itself.
    }
  }

  let passTimer = null;

  function schedule() {
    clearTimeout(passTimer);
    passTimer = setTimeout(pass, PASS_DELAY);
  }

  // One page-lifetime observer, debounced the way content.js, sort.js and
  // genres.js debounce theirs. Never disconnected: it is what notices the row
  // being rebuilt and our own button being swept away with it. A pass writes
  // nothing when nothing changed, so it cannot feed itself.
  const pageObserver = new MutationObserver(schedule);
  pageObserver.observe(document.body, { childList: true, subtree: true });

  // Netflix navigates client-side, so a Back that only changes the URL leaves
  // the observer nothing to see.
  addEventListener("popstate", schedule);

  // A settings change takes effect on the open tab immediately — having to
  // reload Netflix to see a checkbox tick would make the options page feel
  // broken. Same shape as the listener at the bottom of content.js.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    let touched = false;
    for (const key of KEYS) {
      if (changes[key]) {
        settings[key] = normalise(key, changes[key].newValue);
        touched = true;
      }
    }

    if (!touched) return;
    rebuildKeys();
    releaseVideos();
    pass();
  });

  (async function start() {
    try {
      const saved = await chrome.storage.local.get(KEYS);
      for (const key of KEYS) settings[key] = normalise(key, saved[key]);
    } catch (e) {
      // Storage unavailable is not fatal — the defaults are the ones most
      // people would have chosen anyway.
    }

    rebuildKeys();
    pass();
  })();
})();
