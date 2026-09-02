// The on-page filter status bar.
//
// Observed live on 2 Sep 2026: a signed-in Netflix homepage with 21 of 21 cards
// dimmed, the filter set strictly enough to bury an 8.8, and nothing anywhere on
// the page saying a filter was on, what it was hiding, or how to stop it. The
// only route back was the settings page. A user in that state does not conclude
// "my filter is strict"; they conclude the extension is broken.
//
// So this file adds the one thing that state was missing: a visible, countable,
// undoable statement of what is being dimmed and why. It renders nothing at all
// when no filter is active, which is the difference between a status indicator
// and clutter.
//
// What it deliberately does NOT do: touch cards. content.js owns the dim pass
// and re-runs it on every storage change, so clearing a filter here is one
// storage write and content.js does the rest. The only exception is the peek,
// which is a class on <html> and a CSS override — no card is touched, and no
// setting is changed.
//
// Content scripts injected into the same world share one global lexical scope,
// so a top-level `const` here would collide with content.js's, sort.js's or
// genres.js's and throw before any of them ran. Everything below is closed over.
(function () {
  "use strict";

  // No hostname guard, deliberately. The four filters are platform-agnostic —
  // they judge IMDb metadata stamped on a badge, not a Netflix DOM — so this bar
  // is as correct on Prime Video, Amazon and Disney+ as it is on Netflix.
  // genres.js returns early off Netflix because its category IDs are Netflix's;
  // nothing here is.

  // --- the settings ---------------------------------------------------------
  // Read, never redefined. FILTER_DEFAULTS lives in defaults.js and
  // META_FILTER_DEFAULTS and FILTER_KEYS in content.js, both of which the
  // manifest loads before this file, so both are in scope by the time this runs.
  //
  // Every reference to them is guarded with `typeof`, which is safe even when
  // the binding does not exist at all — because it might not. content.js is
  // being edited in parallel and could reasonably end up wrapped in an IIFE,
  // which would take its top-level consts out of the shared scope. When that
  // happens the guards fall back to each setting's own "off" value, which is the
  // one fallback that cannot invent a filter nobody asked for.
  const KEYS =
    typeof FILTER_KEYS !== "undefined" && Array.isArray(FILTER_KEYS)
      ? FILTER_KEYS.slice()
      : ["filterEnabled", "filterMin", "filterRuntimeMax", "filterKinds", "filterGenres"];

  function sharedDefault(key) {
    if (typeof FILTER_DEFAULTS !== "undefined" && FILTER_DEFAULTS && key in FILTER_DEFAULTS) {
      return FILTER_DEFAULTS[key];
    }
    if (
      typeof META_FILTER_DEFAULTS !== "undefined" &&
      META_FILTER_DEFAULTS &&
      key in META_FILTER_DEFAULTS
    ) {
      return META_FILTER_DEFAULTS[key];
    }
    // Only reached if both objects are out of scope. These are the "off" values
    // — false, no minutes, every kind, no genres — not a guess at a threshold.
    // filterMin has no off value, so it reports null and the chip prints no
    // number rather than a number nobody stored.
    switch (key) {
      case "filterEnabled":
        return false;
      case "filterMin":
        return null;
      case "filterRuntimeMax":
        return null;
      case "filterKinds":
        return "all";
      case "filterGenres":
        return [];
      default:
        return undefined;
    }
  }

  // content.js's normaliser is the single place a stored value is interpreted,
  // and reusing it is what stops this bar and the dim pass disagreeing about
  // whether a filter is on. The local branch below is only the fallback for when
  // that function is out of scope; keep the two in step.
  function normalise(key, value) {
    if (typeof normaliseFilter === "function") return normaliseFilter(key, value);

    switch (key) {
      case "filterEnabled":
        return typeof value === "boolean" ? value : sharedDefault(key);
      case "filterMin":
        return typeof value === "number" && Number.isFinite(value) ? value : sharedDefault(key);
      case "filterRuntimeMax":
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
      case "filterKinds":
        return value === "movies" || value === "series" ? value : "all";
      case "filterGenres":
        return Array.isArray(value)
          ? value
              .filter((genre) => typeof genre === "string" && genre.trim())
              .map((genre) => genre.trim().toLowerCase())
          : [];
      default:
        return value;
    }
  }

  let settings = {};
  for (const key of KEYS) settings[key] = normalise(key, undefined);

  // --- what counts as active ------------------------------------------------
  // Each filter says so in its own value rather than sharing one switch, exactly
  // as content.js reads them: a genre is on because a genre is chosen, not
  // because the rating filter happens to be armed.
  function ratingOn() {
    return settings.filterEnabled === true;
  }

  function runtimeOn() {
    const max = settings.filterRuntimeMax;
    return typeof max === "number" && Number.isFinite(max) && max > 0;
  }

  function kindOn() {
    return settings.filterKinds === "movies" || settings.filterKinds === "series";
  }

  function genresOn() {
    return Array.isArray(settings.filterGenres) && settings.filterGenres.length > 0;
  }

  function anyOn() {
    return ratingOn() || runtimeOn() || kindOn() || genresOn();
  }

  // --- attributing a dimmed card to a filter --------------------------------
  // A second copy of content.js's four predicates, and the report says so. It
  // exists because a chip that says "Films only" without saying how much of the
  // page it is burying is exactly the un-diagnosable state this file was written
  // to end.
  //
  // The drift is contained by preferring content.js's own functions whenever
  // they are in scope: they read content.js's live filter state, so no
  // threshold is interpreted twice. The local copies below only run when those
  // are unreachable, and if they ever disagree the symptom is a wrong number on
  // a chip, never a wrongly dimmed card — this file never dims anything.
  function badgeFailsRating(badge) {
    if (typeof failsRating === "function") return failsRating(badge);
    if (!ratingOn()) return false;
    const value = parseFloat(badge.dataset.rating);
    const min = settings.filterMin;
    if (typeof min !== "number" || !Number.isFinite(min)) return false;
    return Number.isFinite(value) && value < min;
  }

  function badgeFailsRuntime(badge) {
    if (typeof failsRuntime === "function") return failsRuntime(badge);
    if (!runtimeOn()) return false;
    if (badge.dataset.kind !== "movie") return false; // series runtimes are one episode
    const minutes = Number(badge.dataset.runtime);
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    return minutes > settings.filterRuntimeMax;
  }

  function badgeFailsKind(badge) {
    if (typeof failsKind === "function") return failsKind(badge);
    if (!kindOn()) return false;
    if (!badge.dataset.kind) return false;
    return settings.filterKinds === "movies"
      ? badge.dataset.kind !== "movie"
      : badge.dataset.kind !== "series";
  }

  function badgeFailsGenres(badge) {
    if (typeof failsGenres === "function") return failsGenres(badge);
    if (!genresOn()) return false;
    if (!badge.dataset.genres) return false;
    // Sharing one genre is enough to pass, so the failure is "shares none" —
    // the negation matters, and getting it the wrong way round here would put
    // exactly the wrong number on the chip.
    const have = badge.dataset.genres.split("|");
    return !settings.filterGenres.some((genre) => have.includes(genre));
  }

  // --- counting -------------------------------------------------------------
  // Read off the DOM rather than recomputed, because content.js has already done
  // the work and redoes it on every settings change. `.nrx-dimmed` sits on the
  // card, which is an ancestor-or-self of the badge's host, so asking the badge
  // ties both numbers to one population: of the titles on this page that have a
  // rating, this many are pushed back.
  //
  // Unrated cards are counted in neither number, which is the honest reading —
  // content.js never dims one, so they are not "shown despite the filter", they
  // are simply outside its jurisdiction.
  let counts = { rated: 0, dimmed: 0, rating: 0, runtime: 0, kind: 0, genres: 0 };

  function recount() {
    const next = { rated: 0, dimmed: 0, rating: 0, runtime: 0, kind: 0, genres: 0 };
    const badges = document.querySelectorAll(".nrx-badge[data-rating]");

    for (const badge of badges) {
      next.rated += 1;
      if (!badge.closest(".nrx-dimmed")) continue;
      next.dimmed += 1;

      // Overlapping on purpose: a 45-minute romcom fails length and genre at
      // once, and both chips should own up to it. The per-chip numbers can
      // therefore sum to more than the total, which is why the headline states
      // the total separately rather than adding the chips up.
      if (badgeFailsRating(badge)) next.rating += 1;
      if (badgeFailsRuntime(badge)) next.runtime += 1;
      if (badgeFailsKind(badge)) next.kind += 1;
      if (badgeFailsGenres(badge)) next.genres += 1;
    }

    counts = next;
  }

  // --- labels ---------------------------------------------------------------
  function ratingText() {
    const min = settings.filterMin;
    return typeof min === "number" && Number.isFinite(min)
      ? `Below IMDb ${min.toFixed(1)}`
      : "Below your rating floor"; // no stored number: say so rather than invent one
  }

  function runtimeText() {
    const max = settings.filterRuntimeMax;
    if (max >= 60) {
      const hours = Math.floor(max / 60);
      const mins = max % 60;
      return mins ? `Over ${hours}h ${mins}m` : `Over ${hours}h`;
    }
    return `Over ${max} min`;
  }

  // Stored lower-cased so content.js's genre comparison is a plain includes();
  // title-cased back for display, hyphen parts included, so "film-noir" reads as
  // IMDb writes it.
  function genreText(genre) {
    return genre
      .split("-")
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join("-");
  }

  // The chips, in the order the settings page lists the filters, so the two
  // surfaces read the same way round. Each carries what it takes to clear
  // itself, which is what keeps the click handler from re-deriving any of this.
  function activeChips() {
    const chips = [];

    if (ratingOn()) {
      chips.push({
        id: "rating",
        label: ratingText(),
        count: counts.rating,
        // The number is kept, only the switch is thrown. Someone who clears the
        // rating filter from here and re-arms it in settings expects their 8.0
        // to still be an 8.0.
        clear: { filterEnabled: false },
        cleared: "Rating filter off"
      });
    }

    if (runtimeOn()) {
      chips.push({
        id: "runtime",
        label: runtimeText(),
        count: counts.runtime,
        clear: { filterRuntimeMax: null },
        cleared: "Length filter off"
      });
    }

    if (kindOn()) {
      chips.push({
        id: "kind",
        label: settings.filterKinds === "movies" ? "Films only" : "Series only",
        count: counts.kind,
        clear: { filterKinds: "all" },
        cleared: "Showing films and series again"
      });
    }

    // One chip per genre rather than one for the set. The genre rule is an OR —
    // a title passes on any one match — so a five-genre list is five separate
    // moods, and dropping the one that no longer fits should not cost the other
    // four. No count on these for the same reason: the rule cannot attribute a
    // dimmed card to one member of an OR, and a number that could not be
    // defended is worse than none.
    if (genresOn()) {
      for (const genre of settings.filterGenres) {
        chips.push({
          id: `genre:${genre}`,
          label: genreText(genre),
          count: null,
          clear: { filterGenres: settings.filterGenres.filter((g) => g !== genre) },
          cleared: `${genreText(genre)} removed`
        });
      }
    }

    return chips;
  }

  function everythingOff() {
    return {
      filterEnabled: false,
      filterRuntimeMax: null,
      filterKinds: "all",
      filterGenres: []
      // filterMin is left alone on purpose: it is the user's number, not a
      // filter. Clearing all should mean "stop hiding things", not "forget what
      // I consider good".
    };
  }

  // --- writing --------------------------------------------------------------
  // The only writes this file makes. content.js's storage.onChanged listener is
  // registered before this file loads and re-runs the dim pass by itself, so
  // nothing here has to touch a card to undo one.
  function write(patch, announcement) {
    // Applied locally first so the chip disappears on the click rather than on
    // the round trip; onChanged confirms it a moment later either way.
    for (const key of Object.keys(patch)) {
      if (KEYS.includes(key)) settings[key] = normalise(key, patch[key]);
    }
    if (announcement) announce(announcement);
    sync();

    try {
      const done = chrome.storage.local.set(patch);
      if (done && typeof done.catch === "function") done.catch(() => {});
    } catch (e) {
      // An invalidated extension context (a reload while the tab is open) is the
      // realistic cause. The bar is already showing the cleared state, and the
      // page will agree with it on its next load.
    }
  }

  // --- the peek -------------------------------------------------------------
  // The escape hatch for "what did it hide?". Netflix users are browsing, and
  // making someone destroy a setting to check what a filter buried is the wrong
  // trade — so this un-dims everything without writing anything, by putting one
  // class on <html> that filters.css reads. No card is touched, no storage key
  // moves, and the counts do not change: `.nrx-dimmed` is still on every card it
  // was on, which is also what lets the peek outline them.
  //
  // Hold or tap, one control: press and hold to look and let go to stop, or tap
  // once to keep it on. The toggle releases itself after ten seconds so it can
  // never be mistaken for a setting — the whole point is that it is borrowed
  // time, and the bar says so while it runs.
  const PEEK_CLASS = "nrx-filters-peek";
  const PEEK_HOLD_MS = 250;
  const PEEK_TIMEOUT_MS = 10000;

  let peeking = false;
  let peekTimer = null;
  let pressStartedAt = 0;

  function startPeek(temporary) {
    clearTimeout(peekTimer);
    peekTimer = null;
    if (!peeking) {
      peeking = true;
      document.documentElement.classList.add(PEEK_CLASS);
    }
    if (!temporary) {
      peekTimer = setTimeout(() => endPeek(), PEEK_TIMEOUT_MS);
      announce("Peeking past the filters. This changes nothing and ends on its own.");
    }
    paint();
  }

  function endPeek() {
    clearTimeout(peekTimer);
    peekTimer = null;
    if (!peeking) return;
    peeking = false;
    document.documentElement.classList.remove(PEEK_CLASS);
    paint();
  }

  // --- the DOM --------------------------------------------------------------
  let root = null;
  let bar = null;
  let countEl = null;
  let chipsEl = null;
  let peekBtn = null;
  let clearBtn = null;
  let liveEl = null;

  // What the chips currently say. Rebuilding them on every recount would move
  // focus out from under a keyboard user mid-scroll, so the row is only rebuilt
  // when the set of active filters actually changes; the numbers on it are
  // updated in place.
  let chipSignature = "";

  // Which chip in the row was last cleared, so focus can be put back where it
  // was rather than on <body>. Reset the moment it is used.
  let lastClearedIndex = -1;

  function announce(message) {
    if (liveEl) liveEl.textContent = message;
  }

  function build() {
    root = document.createElement("div");
    root.className = "nrx-filters-root";

    // Where the bar goes, and why there.
    //
    // Bottom-LEFT, fixed. The bottom-right corner is spoken for: genres.js and
    // pick.js share `.nrx-launcher` there and either may grow another button, so
    // anything parked beside it is a collision waiting for the next feature.
    // Diagonally opposite is the one position that cannot be reached by that
    // column however tall it gets.
    //
    // It also has to miss the site's own chrome, on four sites. Netflix's is all
    // top-anchored — the nav bar, the profile menu, the search field — and its
    // hover previews grow out of the row that owns them; Prime Video and
    // Disney+ are the same shape. None of the four puts a fixed control in the
    // bottom-left, and every one of them treats it as artwork, which the bar is
    // built to sit on top of legibly rather than to avoid.
    //
    // The one thing it can meet there is browse.js's undo toast, which is
    // centred at bottom: 34px. That toast is transient and appended later, so at
    // equal z-index it paints over this bar for the seconds it exists, which is
    // the right precedence: an action someone just took beats a status they can
    // read whenever they like. Below ~720px the bar lifts above the launcher
    // instead — see filters.css.
    bar = document.createElement("section");
    bar.className = "nrx-filters-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "IMDb filters on this page");

    const head = document.createElement("div");
    head.className = "nrx-filters-head";

    const mark = document.createElement("span");
    mark.className = "nrx-filters-mark";
    mark.setAttribute("aria-hidden", "true");

    countEl = document.createElement("p");
    countEl.className = "nrx-filters-count";

    head.append(mark, countEl);

    chipsEl = document.createElement("div");
    chipsEl.className = "nrx-filters-chips";
    chipsEl.setAttribute("role", "group");
    chipsEl.setAttribute("aria-label", "Active filters. Each button clears its own filter.");

    const actions = document.createElement("div");
    actions.className = "nrx-filters-actions";

    peekBtn = document.createElement("button");
    peekBtn.type = "button";
    peekBtn.className = "nrx-filters-btn nrx-filters-peek-btn";
    peekBtn.setAttribute("aria-pressed", "false");
    peekBtn.addEventListener("pointerdown", onPeekPointerDown);
    // Keyboard activation only. A mouse or touch press also fires click, and
    // detail === 0 is what tells the two apart — without it a hold would toggle
    // the peek back on the instant it was released.
    peekBtn.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      if (peeking) endPeek();
      else startPeek(false);
    });

    clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "nrx-filters-btn nrx-filters-clear";
    clearBtn.textContent = "Clear all";
    clearBtn.setAttribute("aria-label", "Clear every filter and show everything");
    clearBtn.addEventListener("click", () => {
      endPeek();
      write(everythingOff(), "All filters cleared. Nothing on this page is dimmed.");
    });

    actions.append(peekBtn, clearBtn);

    // Polite, and deliberately not wrapped around the counts. The numbers change
    // on every scroll burst as new rows resolve, and a live region reading
    // "nineteen of forty-one" every few seconds would make the page unusable
    // with a screen reader on. This announces the things the user did — a filter
    // cleared, a peek started — and the counts are read on demand from the
    // region above.
    liveEl = document.createElement("p");
    liveEl.className = "nrx-filters-live";
    liveEl.setAttribute("role", "status");
    liveEl.setAttribute("aria-live", "polite");

    bar.append(head, chipsEl, actions, liveEl);
    root.appendChild(bar);
    return root;
  }

  function onPeekPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    pressStartedAt = Date.now();
    startPeek(true);

    // On window rather than the button: a hold that wanders off the button
    // should still end when the finger or mouse comes up, and pointercancel is
    // what a touch turning into a scroll arrives as.
    const release = () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      // A quick tap means "hold it on"; a real hold means "I have seen enough".
      if (Date.now() - pressStartedAt < PEEK_HOLD_MS) startPeek(false);
      else endPeek();
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
  }

  // --- rendering ------------------------------------------------------------
  function chipButton(chip, index) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nrx-filters-chip";
    button.dataset.chip = chip.id;
    button.dataset.index = String(index);

    const label = document.createElement("span");
    label.className = "nrx-filters-chip-label";
    label.textContent = chip.label;

    const tally = document.createElement("span");
    tally.className = "nrx-filters-chip-count";
    tally.setAttribute("aria-hidden", "true"); // the accessible name below says it in words

    const cross = document.createElement("span");
    cross.className = "nrx-filters-chip-x";
    cross.setAttribute("aria-hidden", "true");
    cross.textContent = "✕";

    button.append(label, tally, cross);
    button.addEventListener("click", () => {
      endPeek();
      // Focus would otherwise land on <body> when the chip is removed, which
      // strands a keyboard user at the top of the document. Remember where in
      // the row they were and put them back on whatever now occupies it.
      lastClearedIndex = index;
      write(chip.clear, `${chip.cleared}.`);
    });

    return button;
  }

  function paintChip(button, chip) {
    const tally = button.querySelector(".nrx-filters-chip-count");
    const hasCount = typeof chip.count === "number";
    tally.textContent = hasCount ? String(chip.count) : "";
    tally.hidden = !hasCount;

    button.setAttribute(
      "aria-label",
      hasCount
        ? `${chip.label} — dimming ${chip.count} ${chip.count === 1 ? "title" : "titles"}. Clear this filter.`
        : `${chip.label} — clear this filter.`
    );
    button.title = `Clear: ${chip.label}`;
  }

  // The numbers and the peek state, repainted on every pass. Cheap enough to be
  // unconditional: four text nodes and two attributes.
  function paint() {
    if (!bar) return;

    const chips = activeChips();
    const plural = counts.dimmed === 1 ? "title" : "titles";

    if (peeking) {
      countEl.textContent = `Peeking — ${counts.dimmed} dimmed ${plural} shown, nothing changed`;
    } else if (counts.dimmed > 0) {
      countEl.textContent = `${counts.dimmed} of ${counts.rated} rated ${plural} dimmed here`;
    } else {
      // The filter is on and hiding nothing yet. Worth saying rather than
      // hiding the bar, because the next row to load may well be dimmed and a
      // bar that blinked in and out of existence as you scrolled would be
      // worse than one that stays and reads honestly.
      countEl.textContent = `Filtering ${counts.rated} rated ${counts.rated === 1 ? "title" : "titles"} — none dimmed here`;
    }

    bar.dataset.peeking = peeking ? "true" : "false";
    bar.dataset.state = counts.dimmed > 0 ? "dimming" : "idle";

    // Nothing dimmed on this screen means nothing to see through, and a control
    // that would do visibly nothing is worse than one that is not offered. It
    // comes back the moment a row loads that the filter buries.
    peekBtn.hidden = counts.dimmed === 0 && !peeking;

    peekBtn.textContent = peeking ? "Stop peeking" : "Peek";
    peekBtn.setAttribute("aria-pressed", peeking ? "true" : "false");
    peekBtn.setAttribute(
      "aria-label",
      peeking
        ? "Stop peeking and dim the filtered titles again"
        : "Peek past the filters — hold to look, tap to keep it on. Changes no settings."
    );
    peekBtn.title = peeking
      ? "Stop peeking (Esc)"
      : "Hold to see through the dimming, or tap to keep it on for ten seconds";

    // Chips are rebuilt only when the set changes; otherwise their numbers are
    // updated where they stand so focus survives a scroll.
    const signature = chips.map((chip) => chip.id).join("|");
    if (signature !== chipSignature) {
      chipSignature = signature;
      chipsEl.textContent = "";
      chips.forEach((chip, index) => chipsEl.appendChild(chipButton(chip, index)));

      // Put focus back into the row after a chip removed itself, on the chip
      // that took its place — or the one before it, when the last was cleared.
      if (lastClearedIndex >= 0 && document.activeElement === document.body) {
        const buttons = chipsEl.querySelectorAll(".nrx-filters-chip");
        const target = buttons[Math.min(lastClearedIndex, buttons.length - 1)] || clearBtn;
        if (target && target.isConnected) target.focus();
      }
      lastClearedIndex = -1;
    }

    const buttons = chipsEl.querySelectorAll(".nrx-filters-chip");
    chips.forEach((chip, index) => {
      if (buttons[index]) paintChip(buttons[index], chip);
    });
  }

  // --- surviving the page ---------------------------------------------------
  // Whether the bar belongs on screen at all. Two conditions, both necessary:
  // a filter has to be on, and there has to be something for it to judge. The
  // second is what keeps the bar off the player and off a detail page without
  // any site-specific path matching — no rated badges means no population to
  // report on, and a bar reading "0 of 0" over the video controls would be the
  // clutter this feature is supposed to be the opposite of.
  function belongsHere() {
    return anyOn() && counts.rated > 0;
  }

  function sync() {
    recount();

    if (!belongsHere()) {
      endPeek();
      if (root && root.isConnected) root.remove();
      chipSignature = "";
      return;
    }

    if (!root) build();

    // Re-appending the same element keeps every listener on it, so a re-render
    // that swept it away costs one appendChild rather than a rebuild.
    if (!root.isConnected) {
      document.body.appendChild(root);
      chipSignature = ""; // the chips went with it, so the row must be rebuilt
    }

    // Anything else claiming to be this bar — a stale copy from before a
    // re-render, or a second injection of this file — goes, rather than sitting
    // under ours.
    for (const stray of document.querySelectorAll(".nrx-filters-root")) {
      if (stray !== root) stray.remove();
    }

    paint();
  }

  // One page-lifetime observer, debounced the way content.js, sort.js and
  // genres.js debounce theirs: sites rebuild in bursts, and a burst should cost
  // one pass. Never a polling interval — the counts move when the DOM moves.
  //
  // Mutations inside our own subtree are ignored. Rebuilding the chip row is a
  // childList change, and without this the bar would schedule a pass in
  // response to its own repaint.
  let syncTimer = null;
  const pageObserver = new MutationObserver((records) => {
    if (root && records.every((record) => root.contains(record.target))) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 300);
  });

  pageObserver.observe(document.body, { childList: true, subtree: true });

  // Escape ends the peek, capturing and consumed, so it beats the site's own
  // Escape handling — which closes previews and exits the player, and would
  // otherwise fire underneath someone trying to stop peeking. Only while
  // peeking: every other Escape on the page is none of this file's business.
  addEventListener(
    "keydown",
    (event) => {
      if (!peeking || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endPeek();
      if (peekBtn && peekBtn.isConnected) peekBtn.focus();
    },
    { capture: true }
  );

  // content.js's listener is registered first — the manifest loads it first —
  // so by the time this one runs the dim pass has already been re-applied and
  // the DOM is telling the truth. The short delay is belt and braces for the
  // day that stops being true: a second pass a beat later costs one
  // querySelectorAll and settles any disagreement.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!KEYS.some((key) => key in changes)) return;

    for (const key of KEYS) {
      if (changes[key]) settings[key] = normalise(key, changes[key].newValue);
    }
    sync();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 120);
  });

  // Client-side navigation changes the page under the bar without touching the
  // DOM in a way the observer can see.
  addEventListener("popstate", sync);

  // Settings first, so the bar never renders a filter the user turned off two
  // sessions ago and then corrects itself a frame later.
  (async function start() {
    try {
      const saved = await chrome.storage.local.get(KEYS);
      for (const key of KEYS) settings[key] = normalise(key, saved[key]);
    } catch (e) {
      // Storage unavailable is not fatal: every key is already on its own "off"
      // value, so the bar simply does not appear — which is the correct failure
      // for a status indicator that cannot read the status.
    }
    sync();
  })();
})();
