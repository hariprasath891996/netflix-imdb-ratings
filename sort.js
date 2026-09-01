// Sorts a Netflix grid by the IMDb ratings content.js has already badged onto
// it. Runs after content.js, in the same isolated world, and reads its badges
// without ever writing to them — the badge is content.js's element, and the
// only thing this file wants from it is the number.
//
// Only grids. My List and the genre pages lay their tiles out in a wrapping
// container that is ours to reorder; the row surfaces (standard-card,
// ranked-card, progress-card) are horizontal carousels that Netflix scrolls and
// virtualises itself, and reordering those would be a fight with its own
// scroller rather than a feature.

// Content scripts injected into the same world share one global lexical scope,
// so a top-level `const filter` here would collide with content.js's and throw
// before either file ran. Everything below is closed over instead.
(function () {
  "use strict";

  // The manifest injects this file on Prime Video and Amazon as well, where
  // nothing below would match anyway. Saying so out loud beats relying on a
  // selector to miss: Prime's grids are a separate measurement problem, and
  // this file should not be the thing that quietly starts guessing at them.
  if (!/(^|\.)netflix\.com$/.test(location.hostname)) return;

  // The grid tile. Verified on the live site: a static DIV with no aria-label
  // of its own, carrying content.js's badge once the title resolves.
  const TILE = '[data-uia="title-card-container"]';

  // My List was measured at 17 tiles and a genre page at 58. Eight is well
  // under both while being far more than any stray tile a non-grid page might
  // render, so the control never appears somewhere it has nothing to sort.
  const MIN_TILES = 8;

  // A wrapping grid puts tiles on rows at different heights; a carousel has
  // every tile on one line. 60px is comfortably less than a tile's ~147px
  // height and comfortably more than sub-pixel jitter within a row.
  const MIN_ROW_SPREAD = 60;

  // Ratings land in bursts as content.js resolves a screenful, so a restack
  // waits for the burst to finish rather than running once per badge.
  const RESTACK_DELAY = 400;

  // Tiles that arrive after a sort park at the end until the next restack
  // places them properly. Any flex/grid child without an explicit order
  // defaults to 0, which would shoot a brand-new unrated tile to the very top —
  // so every child gets an explicit order, and newcomers get this one.
  const TAIL_ORDER = 1e6;

  let container = null;
  let bar = null;
  let ratingBtn = null;
  let netflixBtn = null;
  let statusEl = null;
  let pendingEl = null;

  let sorted = false;
  let strategy = "order";
  let strategyChecked = false;

  // Netflix's own order, captured at mount. The `order` strategy never moves a
  // node, so under it the live child list is already this list and naturalOrder()
  // reads it straight from the DOM; the DOM-move fallback has no such luxury,
  // and reconstructing what Netflix meant from a grid we have already shuffled
  // is exactly the guesswork this capture exists to avoid.
  let baseline = [];

  let gridObserver = null;
  let gridListeners = null;
  let barListeners = null;
  let restackTimer = null;
  let pendingRatings = 0;
  let pointerOnTile = false;
  let suppress = false;

  // --- finding the grid -----------------------------------------------------
  // Structural, not URL-based. /browse/my-list and /browse/genre/<id> are the
  // two surfaces this was measured on, but a path test would both miss any
  // third grid Netflix ships and fire on a genre URL that has not rendered yet.
  // The presence of a wrapping block of grid tiles is the actual precondition,
  // so that is what gets tested.
  function findGrid() {
    const tiles = document.querySelectorAll(TILE);
    if (tiles.length < MIN_TILES) return null;

    let top = Infinity;
    let bottom = -Infinity;
    for (const tile of tiles) {
      const box = tile.getBoundingClientRect();
      if (!box.width) continue; // not laid out yet, or off-screen and collapsed
      top = Math.min(top, box.top);
      bottom = Math.max(bottom, box.top);
    }
    if (bottom - top < MIN_ROW_SPREAD) return null; // one line: a carousel

    // Lowest common ancestor of every tile. Netflix's class names are
    // CSS-in-JS hashes that change on each deploy, so the container cannot be
    // named — but it can be derived, and derivation survives a redeploy.
    let node = tiles[0];
    for (const tile of tiles) {
      while (node && !node.contains(tile)) node = node.parentElement;
    }
    if (!node) return null;

    // The LCA is often a padding wrapper one or two levels above the element
    // that actually lays the tiles out. Reordering a wrapper's single child
    // reorders nothing, so descend while there is only one child to descend to.
    while (
      node.children.length === 1 &&
      node.firstElementChild.querySelectorAll(TILE).length === tiles.length
    ) {
      node = node.firstElementChild;
    }

    // If the tiles turn out to be bucketed into wrapper rows, this lands on a
    // handful of buckets rather than the tiles themselves, and reordering
    // buckets would shuffle blocks of titles while claiming to sort titles.
    // Bailing is the right answer to that: no control at all beats a control
    // that produces an order nobody asked for.
    //
    // Counting children is not enough to detect that. Measured on a live genre
    // page: 58 tiles sit inside 11 row containers, so a count test passes on
    // 11 and we would happily sort rows by whichever tile happened to be first
    // in each. The test that actually means "these children are the tiles" is
    // that no single child holds more than one of them.
    if (node.children.length < MIN_TILES) return null;
    for (const child of node.children) {
      if (child.querySelectorAll(TILE).length > 1) return null;
    }
    return node;
  }

  // --- reading a rating off a tile -----------------------------------------
  // A tile with no badge yet and a tile whose badge shows "—" are the same
  // answer here: not a number. They are not the same thing — one is pending and
  // one is unrated — but neither is a score, and the sort must never treat
  // either as a zero.
  function ratingOf(item) {
    const badge = item.querySelector(".nrx-badge[data-rating]");
    if (!badge) return null;
    const value = parseFloat(badge.dataset.rating);
    return Number.isFinite(value) ? value : null;
  }

  function naturalOrder() {
    if (strategy === "order") return Array.from(container.children);
    return baseline.filter((item) => item.parentElement === container);
  }

  function computeSequence() {
    const rated = [];
    const rest = [];
    for (const item of naturalOrder()) {
      const value = ratingOf(item);
      if (value === null) rest.push(item);
      else rated.push({ item, value });
    }

    // Array#sort is stable, and the input is already in Netflix's order, so two
    // 8.1s stay in the order Netflix chose rather than swapping on every
    // restack.
    rated.sort((a, b) => b.value - a.value);

    // Unrated tiles are appended as a block, never interleaved. An unmatched
    // title is missing information, not a bad score, and burying it among the
    // 4s would be the badge lying by placement.
    return rated.map((entry) => entry.item).concat(rest);
  }

  // --- applying an order ----------------------------------------------------
  // CSS `order` is the preferred lever precisely because it changes nothing:
  // the DOM stays exactly as Netflix built it, so React never finds a child
  // where it did not put one, content.js's MutationObserver never sees a burst
  // of moves, and restoring is a matter of dropping a style rather than
  // rebuilding a list. The DOM-move fallback exists only for a container that
  // turns out not to lay its children out that way.
  function applySequence(sequence) {
    if (strategy === "order") {
      sequence.forEach((item, index) => {
        item.style.order = String(index + 1);
      });
      return;
    }

    // insertBefore moves the existing node — it never clones — so Netflix's own
    // click and hover listeners ride along untouched.
    suppress = true;
    try {
      let next = null;
      for (let i = sequence.length - 1; i >= 0; i--) {
        container.insertBefore(sequence[i], next);
        next = sequence[i];
      }
    } finally {
      // Our own moves would otherwise come back through the observer as
      // "the grid changed" and schedule a restack of the restack.
      if (gridObserver) gridObserver.takeRecords();
      suppress = false;
    }
  }

  // A container can report display:grid and still ignore `order` — if it places
  // its children explicitly, or if the element measured was a wrapper after
  // all. A sort button that silently does nothing is worse than no button, so
  // the first sort is checked by measurement and the strategy switched once if
  // the tile that should have moved did not.
  function verifyStrategy(sequence, before) {
    strategyChecked = true;
    if (!before) return;
    const after = sequence[0].getBoundingClientRect();
    if (after.top !== before.top || after.left !== before.left) return;

    // Read Netflix's order off the untouched DOM before switching, because
    // afterwards naturalOrder() answers from the capture instead — and the
    // capture is only as fresh as the last tile it was told about.
    baseline = naturalOrder();
    strategy = "dom";
    for (const item of container.children) item.style.order = "";
    applySequence(sequence);
  }

  function sortNow() {
    const natural = naturalOrder();
    const sequence = computeSequence();

    // Only worth measuring when the sort claims to move the top tile; if the
    // best-rated title was already first, nothing moving proves nothing.
    const before =
      !strategyChecked && strategy === "order" && sequence[0] && sequence[0] !== natural[0]
        ? sequence[0].getBoundingClientRect()
        : null;

    applySequence(sequence);
    if (!strategyChecked && strategy === "order") verifyStrategy(sequence, before);

    sorted = true;
    pendingRatings = 0;
    update();
  }

  function restore() {
    if (strategy === "order") {
      // Exact by construction: the DOM was never touched, so dropping the
      // property leaves the browser reading Netflix's own child order —
      // including any tiles that lazy-loaded in while we were sorted.
      for (const item of container.children) item.style.order = "";
    } else {
      applySequence(naturalOrder());
    }
    sorted = false;
    pendingRatings = 0;
    update();
  }

  // --- ratings that arrive after the sort -----------------------------------
  // content.js resolves a tile only when it scrolls into view, so pressing sort
  // on a 58-tile grid typically sorts the dozen that are known and stacks the
  // other 46 behind them. Those 46 resolve as they are scrolled to, and each
  // one makes the current order a little bit wrong.
  //
  // The honest fix is to restack, and the trade-off is that restacking moves
  // tiles the user may be about to click. So a restack is batched and then held
  // for as long as the pointer is actually over a tile or focus is inside the
  // grid, and released the moment it is not. In practice that means the grid
  // re-settles in the gaps between hovers instead of jumping out from under the
  // cursor. Because `order` never changes the container's height, a restack
  // also never moves the scroll position — the tiles rearrange, the page does
  // not lurch.
  function scheduleRestack() {
    clearTimeout(restackTimer);
    restackTimer = setTimeout(flushRestack, RESTACK_DELAY);
  }

  function flushRestack() {
    restackTimer = null;
    if (!sorted || !container) return;

    // Held, not cancelled: pointerout and focusout both reschedule, and the
    // pending count stays on screen so the delay is visible rather than
    // mysterious.
    if (pointerOnTile || container.contains(document.activeElement)) return;

    applySequence(computeSequence());
    pendingRatings = 0;
    update();
  }

  // --- the control ----------------------------------------------------------
  // textContent is only written when it actually changes. Writing it
  // unconditionally would mutate the DOM, wake the page observer, and re-enter
  // this function every 300ms forever.
  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function update() {
    if (!bar) return;

    const total = container.querySelectorAll(TILE).length;
    const rated = container.querySelectorAll(".nrx-badge[data-rating]").length;

    // No aria-live here on purpose: this count ticks up on every scroll, and a
    // polite region would read the grid's loading progress aloud continuously.
    // The state a screen reader needs is on the buttons, where aria-pressed
    // announces it once, when it changes.
    setText(statusEl, `${rated} of ${total} rated`);

    const showPending = sorted && pendingRatings > 0;
    if (showPending) setText(pendingEl, `+${pendingRatings} new`);
    pendingEl.hidden = !showPending;

    // Nothing to sort by yet. Better a visibly inert button with a count beside
    // it explaining why than one that appears to work and reorders nothing.
    ratingBtn.disabled = rated === 0;

    ratingBtn.setAttribute("aria-pressed", String(sorted));
    netflixBtn.setAttribute("aria-pressed", String(!sorted));
  }

  function buildBar() {
    const element = document.createElement("div");
    element.className = "nrx-sort-bar";
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", "Sort this grid by IMDb rating");

    const label = document.createElement("span");
    label.className = "nrx-sort-label";
    label.textContent = "Sort";
    label.setAttribute("aria-hidden", "true"); // the group's own label says it

    ratingBtn = document.createElement("button");
    ratingBtn.type = "button";
    ratingBtn.className = "nrx-sort-btn";
    ratingBtn.dataset.mode = "rating";
    ratingBtn.textContent = "IMDb rating";
    ratingBtn.setAttribute("aria-label", "Sort by IMDb rating, highest first");
    ratingBtn.title = "Highest IMDb rating first. Unrated titles go to the end.";

    netflixBtn = document.createElement("button");
    netflixBtn.type = "button";
    netflixBtn.className = "nrx-sort-btn";
    netflixBtn.dataset.mode = "netflix";
    netflixBtn.textContent = "Netflix order";
    netflixBtn.title = "Put the grid back exactly as Netflix arranged it";

    statusEl = document.createElement("span");
    statusEl.className = "nrx-sort-status";
    statusEl.title = "Ratings resolve as tiles scroll into view";

    pendingEl = document.createElement("span");
    pendingEl.className = "nrx-sort-pending";
    pendingEl.hidden = true;
    pendingEl.title = "New ratings arrived; the order updates as soon as you are not pointing at a tile";

    element.append(label, ratingBtn, netflixBtn, statusEl, pendingEl);
    return element;
  }

  // Netflix rebuilds this subtree on navigation and can take our control with
  // it, so the bar is re-created rather than assumed — which means its buttons
  // are new elements needing new handlers, on a controller of their own so that
  // a re-attach cannot leave two generations of listeners on the page.
  function attachBar() {
    const parent = container.parentElement;
    if (!parent) return;

    // Any older bar still standing — from a previous container, or a second
    // injection of this file — is cleared first, which is what makes a
    // duplicate impossible rather than merely unlikely.
    if (barListeners) barListeners.abort();
    for (const stray of document.querySelectorAll(".nrx-sort-bar")) stray.remove();

    bar = buildBar();
    barListeners = new AbortController();
    const signal = barListeners.signal;

    // Pressing this while already sorted forces a restack. That is the escape
    // hatch from the hold below: whatever the pointer was doing, it is on this
    // button now.
    ratingBtn.addEventListener("click", sortNow, { signal });
    netflixBtn.addEventListener("click", restore, { signal });

    parent.insertBefore(bar, container);
  }

  // --- mounting -------------------------------------------------------------
  function mount(next) {
    container = next;

    const display = getComputedStyle(container).display;
    strategy = /flex|grid/.test(display) ? "order" : "dom";
    strategyChecked = false;
    baseline = Array.from(container.children);
    sorted = false;
    pendingRatings = 0;
    pointerOnTile = false;

    attachBar();
    if (!bar) { container = null; return; }

    gridListeners = new AbortController();
    const signal = gridListeners.signal;

    container.addEventListener("pointerover", (event) => {
      const target = event.target;
      const onTile = target instanceof Element && !!target.closest(TILE);
      if (onTile === pointerOnTile) return;
      pointerOnTile = onTile;
      if (!onTile && pendingRatings) scheduleRestack(); // moved into a gutter
    }, { signal });

    container.addEventListener("pointerleave", () => {
      pointerOnTile = false;
      if (pendingRatings) scheduleRestack();
    }, { signal });

    container.addEventListener("focusout", () => {
      if (pendingRatings) scheduleRestack();
    }, { signal });

    gridObserver = new MutationObserver((records) => {
      if (suppress) return;

      let newRatings = 0;
      let newItems = false;

      for (const record of records) {
        if (record.target === container) newItems = true;
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList.contains("nrx-badge")) {
            if (node.dataset.rating) newRatings++;
          } else if (node.querySelector(".nrx-badge[data-rating]")) {
            // A whole tile arriving with its badge already on it.
            newRatings++;
          }
        }
      }

      if (newItems) adoptNewItems();
      if (sorted && newRatings) pendingRatings += newRatings;
      if (sorted && (newRatings || newItems)) scheduleRestack();
      if (newRatings || newItems) update();
    });

    // content.js builds the badge fully — data-rating included — before
    // appending it, so watching for the added node is enough; there is no later
    // attribute write to catch.
    gridObserver.observe(container, { childList: true, subtree: true });

    update();
  }

  // Netflix appends tiles to the same container when it loads more of a genre.
  function adoptNewItems() {
    if (strategy === "dom") {
      for (const item of container.children) {
        if (!baseline.includes(item)) baseline.push(item);
      }
      return;
    }

    baseline = Array.from(container.children);
    if (!sorted) return;
    for (const item of container.children) {
      if (!item.style.order) item.style.order = String(TAIL_ORDER);
    }
  }

  function unmount() {
    if (restackTimer) { clearTimeout(restackTimer); restackTimer = null; }
    if (gridObserver) { gridObserver.disconnect(); gridObserver = null; }
    if (gridListeners) { gridListeners.abort(); gridListeners = null; }
    if (barListeners) { barListeners.abort(); barListeners = null; }

    // A container can be swapped for a different grid while the old one is
    // still in the document — Netflix caches pages. Leaving our order values on
    // it would strand it in a sort with no control to undo it.
    if (container && container.isConnected && sorted && strategy === "order") {
      for (const item of container.children) item.style.order = "";
    }

    if (bar) { bar.remove(); bar = null; }
    ratingBtn = netflixBtn = statusEl = pendingEl = null;
    container = null;
    baseline = [];
    sorted = false;
    pendingRatings = 0;
    pointerOnTile = false;
  }

  function sync() {
    const found = findGrid();

    if (!found) { unmount(); return; }
    if (found !== container) { unmount(); mount(found); return; }
    if (!bar || !bar.isConnected) { attachBar(); }
    update();
  }

  // One page-lifetime observer, debounced the same way content.js debounces
  // its own: Netflix adds tiles in bursts, and a burst should cost one pass.
  // It is deliberately never disconnected — it is the thing that notices the
  // grid being replaced — while everything scoped to a particular grid hangs
  // off the observer and AbortController that unmount() tears down.
  let syncTimer = null;
  const pageObserver = new MutationObserver(() => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 300);
  });

  pageObserver.observe(document.body, { childList: true, subtree: true });
  sync();
})();
