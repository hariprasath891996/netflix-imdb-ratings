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
//
// Two container shapes are recognised, and each gets its own lever:
//
//   flat     the tiles (or one-tile wrappers) are siblings in one child list.
//            Netflix does not ship this today, but it is the shape worth
//            keeping first in line: on a flex or grid parent it sorts by CSS
//            `order` alone and never touches the DOM at all.
//
//   buckets  what Netflix actually builds, measured on both surfaces:
//            container (block) > row (block) > cell (inline-block) > tile,
//            one cell per tile — 58 tiles on a genre page have 58 distinct
//            parents spread across 11 rows; My List is the same component with
//            3. Nothing here is flex or grid, so `order` is inert, and even a
//            row that did honour it would only sort itself. Sorting this shape
//            means moving cells between rows, which is a destructive edit to a
//            subtree React owns — hence the capture, the re-render detector and
//            the resize handler further down. Those three are not defensive
//            padding; they are the price of the only lever this shape has.

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
  // so every child gets an explicit order, and newcomers get this one. Flat
  // shape only: a grid sorted by DOM moves already has a real tail, and a
  // newcomer appended to it is already in it.
  const TAIL_ORDER = 1e6;

  // React putting its own children back where it wants them is worth answering
  // once or twice — a re-render can land mid-sort simply because the two
  // happened at the same moment. It stops being worth answering when the answer
  // keeps getting undone: at that point two components are taking turns
  // rewriting one subtree, and the only way to not be in a loop is to leave.
  // The window is what separates "twice in a second" from "twice in a session".
  const MAX_REAPPLY = 2;
  const REAPPLY_WINDOW = 4000;

  // Long enough that a drag across the screen edge is one settle rather than
  // forty, short enough that the grid does not sit visibly unsorted afterwards.
  const RESIZE_SETTLE = 350;

  let container = null;
  let bar = null;
  let ratingBtn = null;
  let netflixBtn = null;
  let statusEl = null;
  let pendingEl = null;
  let noteEl = null;

  let sorted = false;
  let shape = "flat";
  let strategy = "order";
  let strategyChecked = false;

  // Netflix's own order, captured at mount. The `order` strategy never moves a
  // node, so under it the live child list is already this list and naturalOrder()
  // reads it straight from the DOM; the DOM-move fallback has no such luxury,
  // and reconstructing what Netflix meant from a grid we have already shuffled
  // is exactly the guesswork this capture exists to avoid.
  let baseline = [];

  // The same idea for the bucketed shape, where "Netflix's order" is two facts
  // per cell rather than one — which row it was in, and where in that row. Both
  // are gone from the DOM the instant a cell is moved, so both are written down
  // first: rowPlan is [{ row, cells }] in document order, and it is the only
  // thing restore() ever plays back from.
  let rowPlan = [];

  // Every cell the capture has ever accounted for. What it is really for is
  // telling a cell that arrived since the last sort apart from one we placed —
  // the first is the grid growing, the second is the page rewriting our work,
  // and they call for opposite responses.
  let knownCells = null;

  // The exact order the last sort left the grid in, which is what the re-render
  // detector compares the live grid against. Null means there is nothing of
  // ours on screen to defend.
  let applied = null;

  let reapplyCount = 0;
  let reapplyAt = 0;
  let note = "";

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

    // Two shapes, tried in the order they deserve. The flat one is checked
    // first and its test is left exactly as strict as it was: it is not a
    // fallback that the bucketed reader has made redundant, it is the better
    // container to be handed, and loosening it so the real Netflix DOM squeaked
    // through would have thrown that away and sorted rows as if they were
    // titles. The bucketed reader is a second recognised shape beside it, with
    // its own equally strict test.
    if (isFlat(node)) return { node, shape: "flat", rows: null };

    const rows = readBuckets(node);
    if (rows) return { node, shape: "buckets", rows };

    // Some third arrangement nobody has measured. No control at all beats a
    // control that produces an order nobody asked for.
    return null;
  }

  // How many titles moving this one element would move. Counting the element
  // itself as well as its descendants is what lets the same test read a bare
  // tile and a wrapper around a tile as the same thing — one movable title —
  // without either shape needing a branch of its own.
  function countTiles(element) {
    return (element.matches(TILE) ? 1 : 0) + element.querySelectorAll(TILE).length;
  }

  // A container whose child list IS the grid, so that a sort is a permutation
  // of one list and nothing else.
  //
  // Counting children is not enough to establish that. Measured on a live genre
  // page: 58 tiles sit inside 11 row containers, so a count test passes on 11
  // and we would happily sort rows by whichever tile happened to be first in
  // each. The test that actually means "these children are the tiles" is that
  // no single child holds more than one of them.
  function isFlat(node) {
    if (node.children.length < MIN_TILES) return false;
    for (const child of node.children) {
      if (countTiles(child) > 1) return false;
    }
    return true;
  }

  // The bucketed shape: container > rows > one cell per tile. Returns the row
  // elements in document order, or null if this is not that shape.
  //
  // Recognised strictly, on purpose, because the whole sort rests on "moving
  // this element moves exactly one title". A row child holding two tiles, or
  // holding none, is a component nobody has measured — a group header, a
  // double-width feature cell — and moving it would either drag a second title
  // along or leave a hole in the grid. Either way the honest answer is to not
  // recognise the shape rather than to move it and hope.
  //
  // A child of the container holding no tiles is a different case entirely: a
  // spacer, a load-more sentinel, the row Netflix has not filled yet. It is not
  // a row of ours, it is simply skipped, and it stays where it is through every
  // sort and every restore.
  function readBuckets(node) {
    const rows = [];
    let cells = 0;

    for (const child of node.children) {
      if (!child.querySelector(TILE)) continue;
      if (!child.children.length) return null;

      // A row may wrap its cells before laying them out, and measurement says
      // it does: on a live My List the shape is
      //
      //   .galleryLockups > .rowContainer > (one wrapper) > cell > tile
      //
      // so reading `.rowContainer`'s direct children finds a single element
      // holding six tiles, the cell test sees 6 instead of 1, and the whole
      // grid is declined. The sort control then never appears, which is exactly
      // what was observed: 17 tiles on screen and no way to order them.
      //
      // This is the same descent the lowest-common-ancestor walk above already
      // performs, for the same reason — a wrapper with one child is not a level
      // of the grid, it is padding — so it is applied per row as well. The
      // condition stays strict: descend only while the single child still holds
      // every tile the row holds, so a wrapper that drops one is not followed.
      let holder = child;
      const inRow = holder.querySelectorAll(TILE).length;
      while (
        holder.children.length === 1 &&
        holder.firstElementChild.querySelectorAll(TILE).length === inRow
      ) {
        holder = holder.firstElementChild;
      }

      for (const cell of holder.children) {
        if (countTiles(cell) !== 1) return null;
      }
      rows.push(holder);
      cells += holder.children.length;
    }

    // One row is not a bucketed grid, it is a flat container one level down —
    // and the single-child descent above has already handed that case to the
    // flat path, where it belongs.
    if (rows.length < 2) return null;

    // Every tile under this container has to be in a cell in a row. If the
    // count comes up short there are tiles somewhere this reader did not look,
    // and a sort would quietly leave them out of the ordering.
    if (cells !== node.querySelectorAll(TILE).length) return null;

    return rows;
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

  // Netflix's arrangement, written down before the first move. A cell that has
  // since been removed from the page is dropped rather than carried: it is not
  // part of any order any more, and computeSequence() would otherwise try to
  // place a node that is not in the document.
  function capture(rows) {
    rowPlan = rows.map((row) => ({ row, cells: Array.from(row.children) }));
    knownCells = new Set();
    for (const entry of rowPlan) {
      for (const cell of entry.cells) knownCells.add(cell);
    }
    applied = null;
  }

  function naturalOrder() {
    if (strategy === "order") return Array.from(container.children);

    // Read out of the capture, row by row, which is the only place Netflix's
    // arrangement still exists once a cell has been moved.
    if (strategy === "buckets") {
      const cells = [];
      for (const entry of rowPlan) {
        for (const cell of entry.cells) {
          if (cell.isConnected) cells.push(cell);
        }
      }
      return cells;
    }

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

    if (strategy === "buckets") {
      layoutRows(sequence);
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

  // --- laying out the bucketed shape ----------------------------------------
  // Cells are inline-block and rows are block, so a row is exactly as tall as
  // one tile and exactly as wide as the cells inside it. That is what makes the
  // grid a grid, and it is also what a sort can destroy: deal seven cells into
  // a row that held six and the row wraps, taking every row below it with it.
  //
  // So the sort is a redistribution rather than a reordering. Every cell in the
  // grid is dealt back out across the rows in sorted order, and each row takes
  // exactly the number of cells the capture says it held — the best-rated title
  // lands in the first slot of the first row, and the grid keeps the shape it
  // had before anybody pressed anything.
  //
  // appendChild moves the existing node; nothing here clones, so Netflix's own
  // listeners and content.js's badge ride along inside the cell untouched. And
  // because every cell is appended exactly once, in sequence order, a cell that
  // was in this row and belongs in a later one is carried out of it by that
  // later row's turn rather than needing to be removed first.
  function layoutRows(sequence) {
    suppress = true;
    try {
      let index = 0;
      let last = null;

      for (const entry of rowPlan) {
        // A row React has replaced under us is not ours to fill. Filling it
        // would be arguing with the re-render that pageReordered() is about to
        // report, and the point of that report is to stop rather than argue.
        if (entry.row.parentElement !== container) continue;
        last = entry.row;
        for (let i = 0; i < entry.cells.length && index < sequence.length; i++) {
          entry.row.appendChild(sequence[index++]);
        }
      }

      // Only reachable if the capture's total capacity shrank between the last
      // adoption and now. A long final row is a visibly wrong grid; a cell
      // stranded mid-grid in the order it happened to be left in is a wrong
      // grid nobody can see, which is worse.
      while (last && index < sequence.length) last.appendChild(sequence[index++]);

      applied = sequence.slice(0, index);
    } finally {
      // Our own moves would otherwise come back through the observer as
      // "the grid changed" and schedule a restack of the restack.
      if (gridObserver) gridObserver.takeRecords();
      suppress = false;
    }
  }

  // Netflix's arrangement, played back from the capture rather than derived
  // from anything on screen — the screen no longer knows. Each row is refilled
  // with the cells it was holding at capture time, in the order it was holding
  // them, which puts every cell back in the row it came from and at the index
  // it came from.
  function restoreRows() {
    suppress = true;
    try {
      for (const entry of rowPlan) {
        if (entry.row.parentElement !== container) continue;
        for (const cell of entry.cells) {
          // A cell React has deleted stays deleted. appendChild would happily
          // put it back on screen, and a restore that resurrects a title the
          // page removed is this file inventing content.
          if (cell.isConnected) entry.row.appendChild(cell);
        }
      }
      applied = null;
    } finally {
      if (gridObserver) gridObserver.takeRecords();
      suppress = false;
    }
  }

  // A title removed from My List takes its cell with it. Dropping it from the
  // capture keeps the restore exact for everything that is left and keeps each
  // row's capacity honest. The alternative — reading the missing cell as
  // evidence that the page rewrote our order — would undo the sort every time
  // somebody tidied their list.
  function pruneCapture() {
    let dropped = false;
    for (const entry of rowPlan) {
      if (entry.cells.every((cell) => cell.isConnected)) continue;
      entry.cells = entry.cells.filter((cell) => cell.isConnected);
      dropped = true;
    }
    if (!dropped) return;

    knownCells = new Set();
    for (const entry of rowPlan) {
      for (const cell of entry.cells) knownCells.add(cell);
    }
    if (applied) applied = applied.filter((cell) => cell.isConnected);
  }

  // Whether every row the capture describes is still where it was recorded.
  // When this stops being true the capture describes a page that no longer
  // exists, and nothing built on it — the restore least of all — means anything
  // until it has been retaken.
  function captureStale() {
    for (const entry of rowPlan) {
      if (entry.row.parentElement !== container) return true;
    }
    return false;
  }

  // --- the page rewriting our work ------------------------------------------
  // React can re-render this grid at any moment and put its own children back
  // in its own order, which silently undoes a sort. Re-applying is the obvious
  // answer and the wrong reflex: a re-render answered by a sort can be answered
  // by another re-render, and two components taking turns rewriting one subtree
  // is a loop that burns the tab. So it is detected, answered a bounded number
  // of times, and then conceded — see noteReconcile().
  //
  // Only cells the capture already knows are compared. A cell that arrived
  // since the last sort is Netflix loading more of the grid, which is the
  // restack's business; counting it as evidence of a rewrite would make every
  // scroll look like a fight.
  function pageReordered() {
    let index = 0;
    for (const entry of rowPlan) {
      // The rows themselves being replaced is the loudest possible version of
      // this: the capture now points at elements that are no longer in the page.
      if (entry.row.parentElement !== container) return true;
      for (const cell of entry.row.children) {
        if (!knownCells.has(cell)) continue;
        if (cell !== applied[index++]) return true;
      }
    }
    return index !== applied.length;
  }

  function noteReconcile() {
    const now = Date.now();
    if (now - reapplyAt > REAPPLY_WINDOW) reapplyCount = 0;
    reapplyAt = now;

    if (++reapplyCount > MAX_REAPPLY) { concede(); return; }

    // Through the restack rather than straight into a sort, so a re-render that
    // lands while the pointer is over a tile is still held rather than yanking
    // the grid out from under it.
    scheduleRestack();
  }

  // Standing down, visibly. The grid is in Netflix's order because Netflix just
  // put it there, so the buttons are made to agree with the screen and the bar
  // says what happened. A sort button left reading "pressed" over a grid that
  // is no longer sorted would be the same lie as a button that does nothing.
  function concede() {
    sorted = false;
    pendingRatings = 0;
    applied = null;
    reapplyCount = 0;

    // React's children are back in React's order, which is Netflix's — so this
    // is the one moment after a sort when a fresh capture is not guesswork.
    const found = findGrid();
    if (found && found.node === container && found.shape === "buckets") capture(found.rows);

    note = "Netflix rebuilt this grid";
    update();
  }

  // The one re-render this file can see coming. Netflix recomputes how many
  // cells fit on a row when the window changes width, and a re-render landing
  // while cells sit in rows React did not put them in is the worst case here:
  // React deletes a child from the row its own model says holds it, and if we
  // moved that child the call throws inside Netflix's own reconciler.
  //
  // So the divergence is closed first and reopened afterwards. Netflix debounces
  // its own resize work while this listener runs synchronously on the event,
  // which is what makes "first" achievable rather than hopeful. The grid sits
  // visibly unsorted for the length of the drag, with the button still pressed —
  // that is the honest state: the sort is still on, it is being recomputed.
  function onResize() {
    if (!sorted) return;
    restoreRows();
    clearTimeout(restackTimer);
    restackTimer = setTimeout(resettle, RESIZE_SETTLE);
  }

  // After the resize settles the rows may be new elements holding a different
  // number of cells each, so the capture is retaken before the sort goes back
  // on. Retaking it is safe for the same reason it is safe in concede(): what
  // is on screen is Netflix's own arrangement, because we put it back there
  // before Netflix touched it.
  function resettle() {
    restackTimer = null;
    if (!sorted || !container) return;

    // Failing to read the shape back is not on its own a reason to stop: the
    // capture may still describe live rows, and sorting against those is better
    // than leaving the button pressed over a grid that is no longer sorted. It
    // is a reason to stop when the capture is stale too, because then there is
    // nothing left to sort against.
    const found = findGrid();
    if (found && found.node === container && found.shape === "buckets") capture(found.rows);
    else if (captureStale()) { concede(); return; }

    applySequence(computeSequence());
    pendingRatings = 0;
    update();
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

    // Only ever reached from the button, so pressing it is the user asking
    // again after a concession — which is exactly the moment to forget that a
    // previous attempt was overwritten and give the page another chance.
    reapplyCount = 0;
    note = "";
    update();
  }

  function restore() {
    if (strategy === "order") {
      // Exact by construction: the DOM was never touched, so dropping the
      // property leaves the browser reading Netflix's own child order —
      // including any tiles that lazy-loaded in while we were sorted.
      for (const item of container.children) item.style.order = "";
    } else if (strategy === "buckets") {
      restoreRows();
    } else {
      applySequence(naturalOrder());
    }
    note = "";
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
  // cursor. Because `order` never changes the container's height — and because
  // the bucketed layout hands every row back the number of cells it started
  // with — a restack never moves the scroll position either: the tiles
  // rearrange, the page does not lurch.
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

    // The rows this sort was planned against are not in the page any more, so
    // re-plan against the ones that replaced them rather than dealing cells
    // into detached elements and calling the result a sorted grid.
    if (strategy === "buckets" && captureStale()) { resettle(); return; }

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

    // Why the grid went back to Netflix's order without anybody asking it to.
    // Silently reverting would leave the sort button looking broken, which is
    // both unfair to the page and useless to the person looking at it.
    if (note) setText(noteEl, note);
    noteEl.hidden = !note;

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

    // Shares the amber with the pending count because it is the same class of
    // message — what is on screen is not what you asked for — and the two can
    // never show at once: conceding clears the pending count on its way past.
    noteEl = document.createElement("span");
    noteEl.className = "nrx-sort-note";
    noteEl.hidden = true;
    noteEl.title = "Netflix re-rendered the grid and undid the sort. Press again to re-apply.";

    element.append(label, ratingBtn, netflixBtn, statusEl, pendingEl, noteEl);
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
  function mount(found) {
    container = found.node;
    shape = found.shape;

    if (shape === "buckets") {
      // No self-check to run here, unlike the flat shape below. `order` is not
      // an unproven lever on this container, it is an inapplicable one —
      // measured display:block over display:inline-block on both surfaces — and
      // an appendChild either moves the cell or the element was not in the
      // document. The measurement that does matter for this shape happens
      // afterwards, in pageReordered(), and it asks a different question: not
      // "did the move take effect" but "did it survive".
      strategy = "buckets";
      strategyChecked = true;
      capture(found.rows);
    } else {
      const display = getComputedStyle(container).display;
      strategy = /flex|grid/.test(display) ? "order" : "dom";
      strategyChecked = false;
      baseline = Array.from(container.children);
    }

    sorted = false;
    pendingRatings = 0;
    pointerOnTile = false;
    reapplyCount = 0;
    note = "";

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

    // Only the bucketed shape has anything at stake in a resize: it is the only
    // one whose cells sit in parents React did not put them in.
    if (strategy === "buckets") addEventListener("resize", onResize, { signal });

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

          // Under the bucketed shape a new tile lands inside a row, or inside a
          // whole new row, and never on the container itself — so the target
          // test above sees none of it and the arrival has to be recognised by
          // what it contains.
          if (strategy === "buckets" && countTiles(node)) newItems = true;
        }

        // And a title leaving — removed from My List, dropped by a re-render —
        // is the same event in reverse. It changes the count on the bar and the
        // capacity of the row it left, and under the bucketed shape it too
        // happens a level down from the container.
        if (strategy === "buckets") {
          for (const node of record.removedNodes) {
            if (node.nodeType === 1 && countTiles(node)) newItems = true;
          }
        }
      }

      // Asked before anything is adopted. Adoption is what teaches the capture
      // where the newcomers are, and once it has, there is no longer any way to
      // tell a page re-render apart from the grid having simply grown.
      let undone = false;
      if (strategy === "buckets") {
        pruneCapture();
        undone = sorted && applied !== null && pageReordered();
      }

      if (newItems) adoptNewItems();

      if (undone) { noteReconcile(); update(); return; }

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
    if (strategy === "buckets") { adoptRows(); return; }

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

  // Netflix loads a genre page a screenful at a time, appending whole rows of
  // cells. The capture has to learn about them, and the thing that makes that
  // safe rather than lossy is this: a cell we have never moved is, by
  // definition, still exactly where Netflix put it, so recording its position
  // now records Netflix's own arrangement and the restore stays exact rather
  // than becoming approximate.
  //
  // A new row is recorded whole. A cell appended to a row we already know goes
  // on the end of that row's recorded list, because the end is where Netflix
  // appended it — the one case this gets wrong is Netflix inserting into the
  // middle of a row it has already rendered, which neither surface does.
  //
  // Newcomers are not parked anywhere the way the flat path parks them (see
  // TAIL_ORDER). A grid sorted by moving cells already has a real tail, and a
  // cell Netflix has just appended is already in it — which is also where an
  // as-yet-unrated title belongs — until the next restack deals it back out
  // with everything else.
  function adoptRows() {
    const known = new Map(rowPlan.map((entry) => [entry.row, entry]));
    const next = [];

    // Rebuilt from the live child list rather than appended to, so that a row
    // Netflix inserts anywhere but the end is still filled in the order it is
    // read in. A recorded row that is no longer a child of the container is
    // dropped here, which is only ever reached when the sort is off — while it
    // is on, that same condition is what pageReordered() reports as a rebuild,
    // and it is answered before anything gets to this function.
    for (const child of container.children) {
      if (!child.querySelector(TILE)) continue;

      const entry = known.get(child);
      if (entry) {
        for (const cell of child.children) {
          if (knownCells.has(cell)) continue;
          if (countTiles(cell) !== 1) continue;
          entry.cells.push(cell);
          knownCells.add(cell);
        }
        next.push(entry);
        continue;
      }

      const cells = Array.from(child.children).filter((cell) => countTiles(cell) === 1);
      if (!cells.length) continue;
      for (const cell of cells) knownCells.add(cell);
      next.push({ row: child, cells });
    }

    rowPlan = next;
  }

  function unmount() {
    if (restackTimer) { clearTimeout(restackTimer); restackTimer = null; }
    if (gridObserver) { gridObserver.disconnect(); gridObserver = null; }
    if (gridListeners) { gridListeners.abort(); gridListeners = null; }
    if (barListeners) { barListeners.abort(); barListeners = null; }

    // A container can be swapped for a different grid while the old one is
    // still in the document — Netflix caches pages. Leaving our order on it
    // would strand it in a sort with no control to undo it.
    //
    // The bucketed shape has that problem and a sharper one behind it: React's
    // model of that subtree still says each cell is in the row it was rendered
    // into, so putting the cells back is also what keeps a later deletion from
    // throwing inside Netflix's own reconciler. It is the last chance to close
    // the divergence, and worth taking even when the grid is on its way out.
    if (container && container.isConnected && sorted) {
      if (strategy === "order") {
        for (const item of container.children) item.style.order = "";
      } else if (strategy === "buckets") {
        restoreRows();
      } else {
        applySequence(naturalOrder());
      }
    }

    if (bar) { bar.remove(); bar = null; }
    ratingBtn = netflixBtn = statusEl = pendingEl = noteEl = null;
    container = null;
    baseline = [];
    rowPlan = [];
    knownCells = null;
    applied = null;
    reapplyCount = 0;
    note = "";
    sorted = false;
    pendingRatings = 0;
    pointerOnTile = false;
  }

  // Whether the grid we are mounted on is still the grid, asked independently
  // of whether findGrid() can recognise one this instant.
  function holdingUp() {
    if (!container || !container.isConnected) return false;
    if (strategy !== "buckets") return false;
    return !captureStale();
  }

  function sync() {
    const found = findGrid();

    // A grid that has momentarily stopped being recognisable is not the same
    // thing as a grid that has gone away, and only the second is a reason to
    // tear down. Anything Netflix draws into the container — a hover preview, a
    // placeholder mid-load — can fail the strict read for a moment, and
    // unmounting on that would pull the bar and undo the sort under the very
    // pointer that caused it. Recognition still has to be strict to mount; it
    // does not have to be strict to stay.
    if (!found) {
      if (holdingUp()) { update(); return; }
      unmount();
      return;
    }

    // The shape is part of the identity. The same element can be read as flat
    // one moment and bucketed the next — a genre page that has rendered one row
    // so far, say — and continuing with the wrong lever on it would sort by a
    // strategy the container no longer has.
    if (found.node !== container || found.shape !== shape) {
      unmount();
      mount(found);
      return;
    }

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
