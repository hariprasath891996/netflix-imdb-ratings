// Takes the list you are looking at off Netflix and puts it in a file on your
// own disk. Shift+E on My List or on the viewing-activity page.
//
// Nothing here is sent anywhere. There is no fetch, no XHR, no sendBeacon, no
// WebSocket and no message to the background worker in this file, and that is a
// design decision rather than an oversight: an export feature is the one place
// in an extension where a user has handed over their entire watch history in a
// single structured blob, and the only trustworthy version of that feature is
// one where the data never leaves the tab it was read in. The file is built in
// memory, handed to the browser's own download machinery, and forgotten.
//
// It is also entirely a reader. It scrapes the page Netflix already rendered
// and calls no Netflix API, authenticated or otherwise — see contract rule 5.
//
// Content scripts injected into the same world share one global lexical scope,
// so a top-level `const` here would collide with content.js's, sort.js's or
// genres.js's and throw before any of them ran. Everything below is closed over
// instead.
(function () {
  "use strict";

  // The manifest injects this file on Prime Video, Amazon and Disney+ as well,
  // where every selector below is meaningless and the two page shapes this
  // reads do not exist. Same guard as genres.js.
  if (!/(^|\.)netflix\.com$/.test(location.hostname)) return;

  // --- the two surfaces -----------------------------------------------------
  // My List is a wrapping grid of the same tile component the genre pages use,
  // so it is read the same way content.js and sort.js read those. Viewing
  // activity is not a grid at all — it is an old-school table of rows that
  // predates the card components by years — so it needs its own reader.
  //
  // Paths rather than structure, unlike sort.js's grid detection, because the
  // question here is different. sort.js asks "is there a grid I could sort",
  // which any genre page answers yes to; this asks "which of two named lists
  // did the user mean", and a genre page is neither. Netflix has moved the
  // viewing-activity page between three paths over the years and old links
  // still resolve, so all three are matched.
  const MY_LIST = /^\/browse\/my-list\b/i;
  const HISTORY = /^\/(viewingactivity|settings\/viewed|account\/viewed)\b/i;

  // Shift+E over a playing film should do nothing at all rather than throw a
  // toast across it. The player is never either surface, so this is only about
  // not answering.
  const PLAYER = /^\/watch\b/i;

  // The grid tile, straight from sort.js — a static DIV wrapping an anchor.
  // This is the single assumption that silently empties a My List export if
  // Netflix retires it: no tiles matched reads exactly like an empty list.
  // Guarded against by counting and by saying the count out loud.
  const TILE = '[data-uia="title-card-container"]';

  // My List has rendered as a grid every time it has been looked at, but the
  // row components are matched too because a homepage-shaped My List would
  // otherwise export as empty rather than as itself. Costs one selector.
  const ROW_CARDS =
    '[data-uia="standard-card"],[data-uia="ranked-card"],[data-uia="progress-card"]';

  // Netflix's viewing activity table. `.retableRow` is a plain hand-written
  // class rather than a CSS-in-JS hash, which is why it has survived redeploys
  // that renamed everything around it — but it is still a class name and not a
  // data-uia contract, so it is the second selector that can quietly empty an
  // export. The attribute form is a hedge against it being suffixed.
  const HISTORY_ROWS = ".retableRow,[class~='retableRow']";

  // What content.js pins on each card. Everything this file knows about a
  // title beyond its name comes off this element's dataset — the ratings were
  // already fetched once, and fetching them again to export them would be both
  // wasteful and a network call this file has promised not to make.
  const BADGE = ".nrx-badge";

  // --- settings -------------------------------------------------------------
  // Read once at start, then kept current by the storage listener at the
  // bottom. Never polled — contract rule 7.
  let format = WATCH_DEFAULTS.exportFormat;

  // A stored value is whatever the last version of the options page happened to
  // write, so anything that is not the one recognised alternative lands on the
  // default rather than being applied literally. An unrecognised value must not
  // produce a file with no format at all.
  function normaliseFormat(value) {
    return value === "json" ? "json" : WATCH_DEFAULTS.exportFormat;
  }

  // --- reading a title off the page -----------------------------------------
  // The same fallback chain as content.js's titleFromCard(), reimplemented here
  // rather than called. content.js is not wrapped in an IIFE, so its function is
  // technically reachable from this scope — but reaching for it would couple the
  // export to another agent's private helper, and the day that file is wrapped
  // (which contract rule 2 says it should be) this feature would break with a
  // ReferenceError rather than a missing column.
  //
  // The normalisation is deliberately *lighter* than content.js's. That one
  // folds curly quotes and dashes to ASCII because it is about to match the
  // string against IMDb's index, where the plain forms are what is stored. This
  // one is producing a file for a person to read, and a person wants the title
  // as Netflix spells it — including its own punctuation, and including every
  // Korean, Japanese and Devanagari character untouched. Only whitespace and
  // Netflix's own "Watch … now" label wrapper are cleaned up.
  function titleFrom(card) {
    const own = card.getAttribute("aria-label");
    if (own && own.trim()) return tidy(own);

    const labelled = card.querySelector("[aria-label]");
    const inner = labelled && labelled.getAttribute("aria-label");
    if (inner && inner.trim()) return tidy(inner);

    const img = card.querySelector("img[alt]");
    if (img && img.alt.trim()) return tidy(img.alt);

    return "";
  }

  function tidy(raw) {
    return String(raw)
      .replace(/\s+/g, " ")
      .replace(/^watch\s+/i, "")
      .replace(/\s+(now|on netflix)$/i, "")
      .trim();
  }

  // Netflix's own link for the title, with the query string dropped. That query
  // string is `tctx=…`, a tracking context token encoding which row, which
  // position and which session the click came from — it is noise in a
  // spreadsheet and it is the one part of the href that describes the user
  // rather than the title, so it is not written to a file.
  function netflixUrlFrom(card) {
    const anchor = card.matches("a[href]") ? card : card.querySelector("a[href]");
    if (!anchor) return "";
    try {
      const url = new URL(anchor.getAttribute("href"), location.origin);
      // A card that somehow links off-site is not this title's Netflix page,
      // and writing it into a column labelled netflix_url would be a lie.
      if (url.origin !== location.origin) return "";
      return url.origin + url.pathname;
    } catch (e) {
      return "";
    }
  }

  // --- reading a badge ------------------------------------------------------
  // Every field is absent-by-default. A card that scrolled past before its
  // lookup finished, a title IMDb has never heard of, and a title with no
  // rating are three different things, and all three are honestly represented
  // by an empty cell. None of them are represented by a zero.
  function badgeFieldsFrom(card) {
    const fields = { year: "", kind: "", rating: "", votes: "", imdbId: "" };
    const badge = card.querySelector(BADGE);
    if (!badge) return fields;

    const data = badge.dataset;
    if (data.rating) fields.rating = data.rating;
    if (data.votes) fields.votes = data.votes;
    if (data.imdbId) fields.imdbId = data.imdbId;
    if (data.kind) fields.kind = data.kind;

    // The year comes off data-year like every other field: content.js stamps it
    // from IMDb's own startYear, and only when that is a plausible integer
    // year, so what is read here is data rather than rendered text. When the
    // year is unknown the attribute is absent and the column is empty — which
    // is the same absent-by-default rule as the four fields above.
    //
    // Not range-checked again here. content.js validates before it stamps, and
    // a second copy of the same bounds in this file would only drift out of
    // step with it; the one check that belongs here is that the attribute is
    // actually a whole number, so a value mangled by anything on the page
    // becomes an empty cell instead of a stray string in a year column.
    if (data.year) {
      const year = Number(data.year);
      if (Number.isInteger(year)) fields.year = String(year);
    }

    return fields;
  }

  // --- collecting My List ---------------------------------------------------
  function collectGrid() {
    const cards = document.querySelectorAll(`${TILE},${ROW_CARDS}`);
    const rows = [];

    // A title can only appear once in My List, but Netflix re-renders tiles in
    // ways that have been observed to leave a stale copy in the tree for a
    // frame or two, and a duplicated row in an export looks like a bug in the
    // user's list rather than in ours. Keyed on the link where there is one,
    // because two different titles can share a name and never share an id.
    const seen = new Set();

    // row -> the inline `order` sort.js put on it, or null. See orderAsShown().
    const order = new Map();

    for (const card of cards) {
      // A row card nested inside a grid tile would otherwise be counted twice.
      // The outer element wins, since that is the one carrying the badge.
      if (card.parentElement && card.parentElement.closest(`${TILE},${ROW_CARDS}`)) continue;

      const title = titleFrom(card);
      const url = netflixUrlFrom(card);
      if (!title && !url) continue; // nothing identifiable: not a row, not an entry

      const key = url || `title:${title}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const row = Object.assign({ title, netflixUrl: url }, badgeFieldsFrom(card));

      // Captured here, next to the card it came off, rather than in a second
      // pass over the same NodeList. A second pass would have to reproduce
      // every skip above exactly, and the moment it drifted the orders would be
      // paired with the wrong rows — which is a shuffled export, not an error.
      order.set(row, inlineOrderNear(card));
      rows.push(row);
    }

    return orderAsShown(rows, order);
  }

  // sort.js sorts the grid by setting an inline `order` on each flex/grid child
  // rather than by moving nodes, which means that after a rating sort the DOM
  // order and the order on screen are different things. Exporting DOM order
  // there would hand back a file that is not the list the user is looking at —
  // they sorted it for a reason and the file should honour that.
  //
  // Read rather than assumed: if nothing on the page carries an inline order,
  // nothing is reordered, and DOM order is kept exactly as it was. sort.js's
  // other strategy moves nodes for real, in which case DOM order is already the
  // visible order and this does nothing either.
  function orderAsShown(rows, order) {
    let anyOrder = false;
    for (const value of order.values()) {
      if (value !== null) { anyOrder = true; break; }
    }
    if (!anyOrder) return rows;

    // A tile with no inline order among tiles that have one is a newcomer
    // sort.js has not placed yet; it sits where the DOM has it rather than
    // being shot to the front by a key of zero.
    // Array.prototype.sort is stable, so ties keep their relative DOM
    // positions rather than swapping unpredictably.
    return rows
      .map((row, index) => {
        const value = order.get(row);
        return { row, key: value === null ? index : value, index };
      })
      .sort((a, b) => a.key - b.key || a.index - b.index)
      .map((entry) => entry.row);
  }

  // The element sort.js styles is the grid's direct child, which is often a
  // wrapper a level or two above the tile itself. Walk up a short way looking
  // for the inline order rather than assuming the tile carries it; bounded,
  // because past a handful of levels we are reading somebody else's layout.
  function inlineOrderNear(card) {
    let node = card;
    for (let depth = 0; node && depth < 6; depth += 1) {
      const raw = node.style && node.style.order;
      if (raw) {
        const value = Number(raw);
        if (Number.isFinite(value)) return value;
      }
      node = node.parentElement;
    }
    return null;
  }

  // --- collecting viewing history -------------------------------------------
  // No badges here: content.js's card selectors match none of this markup, so
  // the rating, vote and IMDb id columns come out empty on this surface. That
  // is correct rather than unfortunate — the alternative is a lookup per row,
  // which is data this file has no business fetching on the user's behalf while
  // they are trying to save a file.
  function collectHistory() {
    const rows = [];

    for (const row of document.querySelectorAll(HISTORY_ROWS)) {
      const anchor = row.querySelector('a[href*="/title/"]') || row.querySelector("a[href]");
      const titleCell = row.querySelector(".col.title") || anchor;
      const title = tidy(titleCell ? titleCell.textContent : "");
      if (!title) continue;

      const dateCell = row.querySelector(".col.date");
      const watched = tidy(dateCell ? dateCell.textContent : "");

      let url = "";
      if (anchor) {
        try {
          const parsed = new URL(anchor.getAttribute("href"), location.origin);
          if (parsed.origin === location.origin) url = parsed.origin + parsed.pathname;
        } catch (e) {
          url = "";
        }
      }

      // Deliberately not de-duplicated, unlike the grid. Watching the same
      // episode twice on two evenings is two entries in the user's history and
      // must be two rows in their file; collapsing them would be this feature
      // editing the record rather than exporting it.
      rows.push({
        watched,
        title,
        netflixUrl: url,
        year: "",
        kind: "",
        rating: "",
        votes: "",
        imdbId: ""
      });
    }

    return rows;
  }

  // --- CSV ------------------------------------------------------------------
  // RFC 4180, plus the two things RFC 4180 does not cover and that matter more
  // than it does in practice.
  //
  // Quoting: a field is quoted only when it contains a comma, a double quote,
  // a CR or an LF, and inside a quoted field every double quote is doubled.
  // That is the whole of the RFC and it is genuinely all that is needed for
  // commas and newlines inside a film title.
  //
  // Formula injection: a cell whose text begins =, +, - or @ is executed as a
  // formula by Excel, Sheets, LibreOffice and Numbers when the file is opened.
  // Every value in this file came off a web page, which makes that a live
  // injection route rather than a curiosity — a title is attacker-controllable
  // in exactly the way a spreadsheet formula should never be. Quoting does NOT
  // prevent it; Excel parses the quotes off and evaluates what is inside. The
  // fix that actually works is a leading apostrophe, which every one of those
  // programs reads as "the rest of this cell is text". Tab and CR are included
  // because they are the same vector by a different lead character.
  //
  // The cost is real and worth naming: a film honestly titled "-30-" exports
  // with a leading apostrophe. A visible apostrophe in one rare title is a far
  // better outcome than a file that runs code when it is opened.
  function csvField(value) {
    let text = value === null || value === undefined ? "" : String(value);
    if (text === "") return "";

    if (/^\s*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;

    return text;
  }

  // CRLF between records, as the RFC specifies. Excel is happy with either;
  // some older importers are not happy with bare LF.
  function toCsv(columns, rows) {
    const lines = [columns.map((column) => csvField(column.header)).join(",")];
    for (const row of rows) {
      lines.push(columns.map((column) => csvField(row[column.key])).join(","));
    }
    return `${lines.join("\r\n")}\r\n`;
  }

  // --- JSON -----------------------------------------------------------------
  // Unknown is null here rather than "", because JSON has a word for unknown
  // and CSV does not. Nothing is guessed into either.
  function toJson(surface, columns, rows) {
    return `${JSON.stringify(
      {
        source: "IMDb Ratings for Netflix",
        list: surface.id,
        pageUrl: location.origin + location.pathname,
        exportedAt: new Date().toISOString(),
        capturedCount: rows.length,
        // Carried in the file as well as the toast, because the file outlives
        // the toast and whoever opens it later deserves to know the count is a
        // snapshot of what was rendered rather than the length of the list.
        note: surface.caveat,
        items: rows.map((row) => {
          const item = {};
          for (const column of columns) {
            const value = row[column.key];
            item[column.key] = value === "" || value === undefined ? null : value;
          }
          return item;
        })
      },
      null,
      2
    )}\n`;
  }

  // --- handing the file to the browser --------------------------------------
  // No `downloads` permission, by contract rule 4 and because this does not
  // need one. A content script runs in an isolated world but against the page's
  // own document and origin, so URL.createObjectURL() here mints an ordinary
  // same-origin blob: URL, and an anchor carrying `download` and pointing at a
  // same-origin URL is honoured rather than treated as a navigation. The click
  // happens inside the keydown handler, so it is a user gesture and never hits
  // Chrome's automatic-download heuristics.
  //
  // The anchor is put in the document before it is clicked. A detached anchor
  // does work in current Chrome, but the attached form is what every browser
  // has always supported and the cost is two DOM operations.
  //
  // The object URL is revoked on a later task rather than immediately after
  // click(). Revoking synchronously has historically raced the download's own
  // read of the blob and produced a zero-byte or failed download; a revoke on
  // the next tick releases the memory just as surely with no race.
  function saveFile(filename, mime, parts) {
    const blob = new Blob(parts, { type: mime });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Local date, not the ISO one, because the filename is read by a person who
  // is in their own timezone and a file saved late on the 2nd should not be
  // called the 3rd.
  function stamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  // --- the toast ------------------------------------------------------------
  // No stylesheet of its own — this file owns no CSS — so the handful of rules
  // it needs live inline on the element. Namespaced anyway, so that anything
  // sweeping up after us has a name to sweep on.
  //
  // Not animated at all, which is the simplest way to honour
  // prefers-reduced-motion: there is no motion to reduce.
  let toastEl = null;
  let toastTimer = null;

  function toast(message) {
    if (toastEl && toastEl.isConnected) toastEl.remove();
    clearTimeout(toastTimer);

    toastEl = document.createElement("div");
    toastEl.className = "nrx-export-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");

    // Above Netflix's player chrome, which sits around z-index 1000, using the
    // same band content.js's tooltip uses.
    toastEl.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:32px",
      "transform:translateX(-50%)",
      "z-index:2147483000",
      "max-width:min(560px,calc(100vw - 32px))",
      "box-sizing:border-box",
      "padding:12px 16px",
      "border-radius:6px",
      "border:1px solid rgba(255,255,255,0.18)",
      "background:#181818",
      "color:#fff",
      // Unitless line-height and a rem-relative size so the toast still reads
      // at 200% browser zoom rather than clipping.
      "font:500 0.875rem/1.45 Netflix Sans,Helvetica Neue,Helvetica,Arial,sans-serif",
      "text-align:center",
      "box-shadow:0 6px 24px rgba(0,0,0,0.55)",
      "cursor:pointer",
      "white-space:pre-line"
    ].join(";");

    toastEl.addEventListener("click", () => toastEl.remove());
    document.body.appendChild(toastEl);

    // Inserted empty, then filled on the next frame. A live region that already
    // has its text when it enters the document is a new region rather than a
    // changed one, and screen readers are inconsistent about announcing those —
    // this is the same reason genres.js sets its status text after mounting the
    // element rather than before. The count is the whole message here, so it
    // being announced is not a nicety.
    const el = toastEl;
    requestAnimationFrame(() => {
      if (el.isConnected) el.textContent = message;
    });

    // Long, because the message it usually carries is a count plus an
    // instruction, and an instruction that vanishes in two seconds is decoration.
    toastTimer = setTimeout(() => {
      if (toastEl && toastEl.isConnected) toastEl.remove();
    }, 9000);
  }

  // --- the two surfaces, described once -------------------------------------
  // Columns are per surface rather than one shared schema with a blank column:
  // a My List export has no "watched" date and never will, and an always-empty
  // column in a spreadsheet reads as missing data rather than as a column that
  // does not apply.
  const BASE_COLUMNS = [
    { key: "title", header: "title" },
    { key: "year", header: "year" },
    { key: "kind", header: "kind" },
    { key: "rating", header: "imdb_rating" },
    { key: "votes", header: "imdb_votes" },
    { key: "imdbId", header: "imdb_id" },
    { key: "netflixUrl", header: "netflix_url" }
  ];

  function surfaceFor(pathname) {
    if (MY_LIST.test(pathname)) {
      return {
        id: "my-list",
        label: "My List",
        file: `netflix-my-list-${stamp()}`,
        columns: BASE_COLUMNS,
        collect: collectGrid,
        // Netflix builds tiles as they approach the viewport, so a 300-title
        // list has perhaps forty in the DOM until you have scrolled it. Saying
        // so is the whole of the honesty here: the alternative — scrolling the
        // page automatically — hijacks the window, fights Netflix's own scroll
        // restoration, and is exactly the kind of thing an extension should not
        // do behind someone's back. Telling them costs one sentence.
        caveat:
          "Netflix only builds tiles as you scroll. Scroll to the bottom of " +
          "My List first, then export again, to capture the rest.",
        empty:
          "No titles found on this page. If My List has only just loaded, " +
          "give it a moment and press Shift+E again."
      };
    }

    if (HISTORY.test(pathname)) {
      return {
        id: "viewing-history",
        label: "viewing history",
        file: `netflix-viewing-history-${stamp()}`,
        columns: [{ key: "watched", header: "watched" }].concat(BASE_COLUMNS),
        collect: collectHistory,
        // Different mechanism from the grid, so a different sentence. This page
        // pages in with a button rather than on scroll, and it carries no
        // badges at all, which is why the IMDb columns come out empty.
        caveat:
          "Only the rows currently on the page are included — use Netflix's " +
          "own Show More button to load the rest, then export again. IMDb " +
          "columns are empty here: this page has no rating badges to read.",
        empty:
          "No history rows found on this page. If it has only just loaded, " +
          "give it a moment and press Shift+E again."
      };
    }

    return null;
  }

  // --- doing it -------------------------------------------------------------
  // Two exports a second apart are a user who scrolled and asked again; two a
  // few milliseconds apart are a key the browser is repeating, or a keydown
  // that reached us twice. Only the second kind is refused, and it is refused
  // here rather than in the handler because a stray double-fire from any source
  // ends up in the downloads folder just as surely as a held key does.
  const COOLDOWN = 1000;
  let lastRunAt = 0;

  function run() {
    const now = Date.now();
    if (now - lastRunAt < COOLDOWN) return;
    lastRunAt = now;

    const surface = surfaceFor(location.pathname);
    if (!surface) {
      toast(
        "Export works on My List and on your viewing activity.\n" +
          "Open netflix.com/browse/my-list or netflix.com/viewingactivity and press Shift+E."
      );
      return;
    }

    try {
      const rows = surface.collect();

      // No rows means no file. Writing a header-only CSV would look like a
      // successful export of an empty list, and the one thing this feature must
      // never do is claim the list is shorter than it is.
      if (!rows.length) {
        toast(surface.empty);
        return;
      }

      if (format === "json") {
        // No BOM on JSON. RFC 8259 forbids one and several parsers reject it
        // outright, so the byte-order mark that rescues the CSV would break the
        // JSON.
        saveFile(`${surface.file}.json`, "application/json;charset=utf-8", [
          toJson(surface, surface.columns, rows)
        ]);
      } else {
        // The BOM, as a separate leading part so it is unambiguously the first
        // three bytes of the file. Without it Excel on Windows decodes a
        // UTF-8 CSV as the system code page, which turns every Korean, Japanese
        // and Devanagari title into mojibake — this is the default state of a
        // real Netflix list, not an edge case. Other tools skip the BOM; Excel
        // needs it; so it is always written.
        saveFile(`${surface.file}.csv`, "text/csv;charset=utf-8", [
          "\uFEFF",
          toCsv(surface.columns, rows)
        ]);
      }

      const noun = rows.length === 1 ? "entry" : "entries";
      toast(`Exported ${rows.length} ${noun} from ${surface.label}.\n${surface.caveat}`);
    } catch (error) {
      // A failed export must say so. Silence here would look identical to a
      // download the browser swallowed, and the user would go looking in their
      // downloads folder for a file that was never built.
      toast("Export failed. Nothing was saved, and nothing was sent anywhere.");
    }
  }

  // Shift+E, for export. Same reasoning as content.js's Shift+B and genres.js's
  // Shift+G: Netflix's own shortcuts are unmodified single keys and the
  // browser's are all Ctrl/Cmd/Alt chords, so plain Shift is the gap between
  // them. Capture, because Netflix binds keys on the document and stops
  // propagation on the ones it claims.
  addEventListener(
    "keydown",
    (event) => {
      if (!event.shiftKey || event.key.toLowerCase() !== "e") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // A held key repeats at the OS key-repeat rate, and every repeat is a
      // fresh keydown. Without this, leaning on the chord asks for a file
      // several times a second. run() has its own cooldown behind this, because
      // this flag is the browser's word and the cooldown is ours.
      if (event.repeat) return;

      // Shift+E while typing is a capital E, not a command. Includes the search
      // box and any other field on the page.
      const target = event.target;
      if (target instanceof Element) {
        if (target.isContentEditable) return;
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      }

      // Over a playing film, do nothing rather than explain — a toast across
      // the picture is the intrusion this extension keeps not being.
      if (PLAYER.test(location.pathname)) return;

      event.preventDefault();
      run();
    },
    { capture: true }
  );

  // A settings change takes effect on the open tab immediately: someone who
  // switches to JSON in the options page and comes back to a Netflix tab
  // already open should get JSON, not have to reload first.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.exportFormat) format = normaliseFormat(changes.exportFormat.newValue);
  });

  (async function start() {
    try {
      const saved = await chrome.storage.local.get(["exportFormat"]);
      format = normaliseFormat(saved.exportFormat);
    } catch (e) {
      // Storage unavailable is not fatal — the default format is perfectly
      // usable, and an export in the wrong format still beats no export.
    }
  })();
})();
