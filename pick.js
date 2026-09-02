// "Pick one for me" — a button in the shared bottom-right launcher, and
// Shift+P.
//
// Every other randomiser extension shuffles blindly, which is why none of them
// are worth keeping: a random draw from a catalogue you have already decided
// against is just a slower way of scrolling. This one draws from the badges
// content.js has already put on the page, so the pool is titles the user has
// said, in their own settings, that they would watch. That is the whole feature.
// The panel is a way of showing one; the filter is the product.
//
// Nothing here fetches, scrolls, or invents. The pool is what is in the DOM at
// the moment the panel is asked for, and the panel says so out loud — a count the
// user can check against the page in front of them is what makes the rest of it
// believable.
//
// Content scripts injected into the same world share one global lexical scope,
// so a top-level `const` here would collide with content.js's, sort.js's or
// genres.js's and throw before any of them ran. Everything below is closed over.
(function () {
  "use strict";

  // Not guarded by hostname. Unlike genres.js — which traffics in Netflix's own
  // category IDs and would be nonsense anywhere else — this feature only needs
  // badges, and badges are on every platform the manifest injects into. That
  // asymmetry is the thing the shared launcher below has to survive: on Netflix
  // the corner holds two buttons, everywhere else it holds this one.

  // --- what a card looks like ----------------------------------------------
  // A deliberate copy of the card selectors in content.js's PLATFORMS map,
  // rather than a reach across files for the real thing. Two reasons, and the
  // second is the important one:
  //
  //   1. Coupling to another agent's internals through the shared script scope
  //      is invisible in both files and breaks silently when either moves.
  //   2. If this copy goes stale, nothing here breaks. The card is only ever
  //      used to widen the search for a title and a link; when no selector
  //      matches, everything falls back to the badge's own host element, which
  //      content.js guarantees exists because it is where the badge was put.
  //
  // Every platform's selectors are listed together rather than switched on the
  // hostname: they are all attribute selectors on attributes only one site
  // uses, so the union can never match the wrong thing.
  const CARD_SELECTORS = [
    '[data-uia="standard-card"]',
    '[data-uia="ranked-card"]',
    '[data-uia="progress-card"]',
    '[data-uia="title-card-container"]',
    '[data-testid="card"]',
    '[data-testid="set-item"]'
  ].join(",");

  // Used in one sentence of the footer, which explains why the pool is small.
  // "This site" is the fallback rather than a guess, so a host added to the
  // manifest without a line here reads slightly generically instead of wrongly.
  const SITE = /(^|\.)netflix\.com$/.test(location.hostname)
    ? "Netflix"
    : /(^|\.)primevideo\.com$/.test(location.hostname) ||
      /(^|\.)amazon\.[a-z.]+$/.test(location.hostname)
      ? "Prime Video"
      : /(^|\.)disneyplus\.com$/.test(location.hostname)
        ? "Disney+"
        : "This site";

  // How long the ring sits on a card after "Show it on the page". Long enough
  // to find with the eye after a scroll, short enough not to become decoration.
  const SPOTLIGHT_MS = 2600;

  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(location.hostname);

  // Where the corner button has no business appearing. The player is the
  // obvious one — a floating button over a film is exactly the intrusion this
  // is trying not to be — and the rest are pages with no catalogue on them to
  // draw from.
  //
  // Deliberately not a guess about every surface of every site. Netflix's are
  // the paths genres.js already established; Disney+ plays at /play and /video;
  // Prime plays in place on the page it was already on and gives us no path to
  // key off, which is stated here rather than papered over with a selector that
  // would go stale. Anything not matched shows the button, because everywhere
  // else on these sites is a page with cards on it.
  //
  // Only the button is path-aware. Shift+P still works everywhere it worked
  // before, including the player — the chord is a thing the user asked for, and
  // taking it away because a fixture would look wrong there would be trading a
  // capability for a decoration.
  const HIDDEN_PATHS = IS_NETFLIX
    ? /^\/(watch|profiles|login|signup|password|simpleSignUp)\b/i
    : /^\/(play|video)\b/i;

  function triggerBelongsHere() {
    // Netflix's bare "/" is the signed-out marketing page; every signed-in
    // surface has a path segment. Elsewhere "/" is the storefront home, which
    // is full of cards and is the best page on the site for this button.
    if (IS_NETFLIX && location.pathname === "/") return false;
    return !HIDDEN_PATHS.test(location.pathname);
  }

  // --- the shared launcher --------------------------------------------------
  // The bottom-right corner is shared with genres.js, and neither file owns it:
  // whichever runs first creates the container, the other finds it by selector.
  //
  // The manifest injects genres.js before pick.js, so on Netflix that file is
  // usually the creator and this one joins. Nothing here leans on that, and it
  // is not reliably true anyway: genres.js returns early off Netflix, so on
  // Prime Video, Amazon and Disney+ this file creates the container and is the
  // only button in it. Both directions are the same two lines.
  //
  // The contract is three things and no more:
  //   - the container is `.nrx-launcher`;
  //   - an item in it carries `nrx-launcher-item`, which is what takes the item
  //     out of its own fixed positioning and hands the corner to the container;
  //   - `data-launch` fixes the stacking order, so a re-mount after a re-render
  //     cannot swap the two buttons round under the user's cursor.
  // It is styled in pick.css, which is the file the launcher arrived with.
  function launcher() {
    let bar = document.querySelector(".nrx-launcher");
    if (!bar || !bar.isConnected) {
      bar = document.createElement("div");
      bar.className = "nrx-launcher";
      document.body.appendChild(bar);
    }
    return bar;
  }

  // --- settings -------------------------------------------------------------
  // Read once at start, then kept current by the storage listener at the bottom
  // — the same bargain content.js makes, for the same reason: a threshold the
  // user has just changed in the options tab should apply to the very next
  // press of Shift+P, without a reload.
  //
  // WATCH_DEFAULTS and RAG_DEFAULTS come from defaults.js, which the manifest
  // loads first. They are read rather than re-declared so there is exactly one
  // place a default lives; the `typeof` guards cover the one case where that is
  // not true, which is defaults.js failing to parse.
  const FALLBACK_MIN =
    typeof WATCH_DEFAULTS === "object" && Number.isFinite(WATCH_DEFAULTS.pickMinRating)
      ? WATCH_DEFAULTS.pickMinRating
      : typeof RAG_DEFAULTS === "object" && Number.isFinite(RAG_DEFAULTS.tierHigh)
        ? RAG_DEFAULTS.tierHigh
        : 7.5;

  const settings = {
    pickMinRating: FALLBACK_MIN,
    pickKinds: "all",
    pickIncludeUnrated: false
  };

  // The badge's own two thresholds. tierHigh doubles as the documented fallback
  // for a minimum that has never been set — "worth watching" is a line the user
  // may already have drawn once, and asking them to draw it twice is the kind of
  // small rudeness that makes a settings page feel long. Both are here so the
  // score in the panel is coloured by exactly the rule that coloured the badge.
  let tierHigh = FALLBACK_MIN;
  let pickMinInherited = true;
  let tierMid =
    typeof RAG_DEFAULTS === "object" && Number.isFinite(RAG_DEFAULTS.tierMid)
      ? RAG_DEFAULTS.tierMid
      : 6.5;

  // Anything unrecognised lands on the setting's own safe value rather than
  // being applied literally. A stored `pickMinRating` of "7.5" as a string, or
  // a `pickKinds` from a future build, must never quietly empty the pool.
  function normalise(key, value) {
    switch (key) {
      case "pickMinRating":
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      case "pickKinds":
        return value === "movies" || value === "series" ? value : "all";
      case "pickIncludeUnrated":
        return typeof value === "boolean" ? value : false;
      default:
        return value;
    }
  }

  function applySettings(saved) {
    const min = normalise("pickMinRating", saved.pickMinRating);
    tierHigh =
      typeof saved.tierHigh === "number" && Number.isFinite(saved.tierHigh)
        ? saved.tierHigh
        : FALLBACK_MIN;
    tierMid =
      typeof saved.tierMid === "number" && Number.isFinite(saved.tierMid)
        ? saved.tierMid
        : typeof RAG_DEFAULTS === "object" && Number.isFinite(RAG_DEFAULTS.tierMid)
          ? RAG_DEFAULTS.tierMid
          : 6.5;

    // Whether the floor is the user's own or borrowed from tierHigh has to be
    // remembered, not just resolved. The storage listener below rebuilds this
    // record from `settings`, and by then an inherited floor is an ordinary
    // number indistinguishable from a chosen one — so without this flag, the
    // first change of any watched key would quietly freeze the floor at
    // whatever tierHigh happened to be, and moving the green boundary in an
    // open tab would stop following. The settings page resolves it in exactly
    // this order; the two must not drift.
    pickMinInherited = min === null;
    settings.pickMinRating = min === null ? tierHigh : min;
    settings.pickKinds = normalise("pickKinds", saved.pickKinds);
    settings.pickIncludeUnrated = normalise("pickIncludeUnrated", saved.pickIncludeUnrated);
  }

  // --- reading a badge ------------------------------------------------------
  // Everything this feature knows comes from an element content.js already put
  // on the page. No lookup message is sent, and the reason is worth stating: a
  // `lookup` would return exactly what the badge is already wearing, because
  // the badge was built from one. Re-asking would cost a round trip per
  // candidate to re-learn what is sitting in the DOM.
  //
  // The contract between the two files is content.js's `stampMetadata` and
  // `renderBadge`: rating, votes, year, kind, runtime, genres, run status and
  // IMDb id are all dataset keys, and every one of them is optional —
  // content.js writes a key only when the field actually parsed, precisely so
  // that an absent key reads as "nobody knows" rather than as a zero.
  //
  // Exactly one thing is still read out of `data-tip-base`: the "listed on
  // IMDb as..." line, which content.js composes there and nowhere else. It is
  // parsed defensively and treated as optional, so rewording the tooltip costs
  // that one note and nothing else.
  //
  // The year used to be read out of that same string, back when content.js did
  // not stamp one. It does now, so the year is read as data and there is no
  // fallback to the tooltip for it — a silent fallback to a rendered string is
  // precisely the coupling that was worth removing, because it lets a reworded
  // display line change what this panel says with nothing to catch it.

  function clean(raw) {
    // Same normalisation content.js applies to a card label, for the same
    // reason: these strings are full of typographic punctuation, and a title
    // shown with a curly apostrophe next to a badge showing a straight one
    // looks like two different titles.
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

  // Netflix's row cards carry the title on the anchor itself; its grid tiles
  // and Prime's articles carry it on a descendant. Both shapes are handled the
  // way content.js handles them, and then the search widens upwards a little —
  // because this starts from the badge's host, which on Prime is an inner
  // packshot that may sit below the element holding the label.
  //
  // The upward walk is bounded hard. Two levels above the card is still the
  // title's own wrapper; eight would be the row, and a row's aria-label
  // ("Trending Now") is exactly the wrong answer delivered confidently.
  function labelWithin(element) {
    const own = element.getAttribute("aria-label");
    if (own && own.trim()) return clean(own);

    const labelled = element.querySelector("[aria-label]");
    const inner = labelled && labelled.getAttribute("aria-label");
    if (inner && inner.trim()) return clean(inner);

    const img = element.querySelector("img[alt]");
    if (img && img.alt.trim()) return clean(img.alt);

    return null;
  }

  function titleFor(card, host) {
    const fromCard = labelWithin(card);
    if (fromCard) return fromCard;

    if (host !== card) {
      const fromHost = labelWithin(host);
      if (fromHost) return fromHost;
    }

    let node = card.parentElement;
    for (let depth = 0; node && depth < 2; depth++, node = node.parentElement) {
      const found = labelWithin(node);
      if (found) return found;
    }
    return null;
  }

  // The tooltip's lines after the first. The first line is the score and the
  // vote count, both of which are dataset keys, so nothing here looks at it.
  // Any line below it is either the IMDb title content.js printed because it
  // differs from the site's label, or the modifier-click hint. The hint is
  // identified and dropped; whatever is left is the matched title.
  function matchedTitle(badge) {
    const base = badge.dataset.tipBase;
    if (!base) return {};

    const out = {};
    for (const line of base.split("\n").slice(1)) {
      const text = line.trim();
      if (!text || /-click to open imdb$/i.test(text)) continue;
      out.matched = text.replace(/\s*\(closest match\)$/i, "").trim();
      out.approximate = /\(closest match\)$/i.test(text);
      break;
    }

    return out;
  }

  // The year, straight off the badge. content.js stamps `data-year` from
  // IMDb's own startYear, and only when it is a plausible year — so the only
  // thing left to check here is that it survived the round trip through an
  // attribute as a whole number. Re-testing the range would be a second copy
  // of a rule that already lives in content.js, and a second copy is a second
  // thing to drift.
  function yearOf(badge) {
    const year = Number(badge.dataset.year);
    return Number.isInteger(year) ? year : null;
  }

  function readBadge(badge) {
    // content.js appends the badge to a host it has just given .nrx-host, so
    // the parent is the framing box by construction. closest() is the belt to
    // that braces, in case the badge ever gains a wrapper.
    const host = badge.closest(".nrx-host") || badge.parentElement;
    if (!host) return null;

    const card = host.closest(CARD_SELECTORS) || host;
    const title = titleFor(card, host);
    if (!title) return null; // nothing to put in front of the user

    const rating = parseFloat(badge.dataset.rating);
    const votes = Number(badge.dataset.votes);
    const named = matchedTitle(badge);

    return {
      badge,
      host,
      card,
      title,
      rating: Number.isFinite(rating) ? rating : null,
      votes: Number.isFinite(votes) && votes > 0 ? votes : null,
      kind: badge.dataset.kind || null, // "movie" | "series" | absent
      runtime: Number(badge.dataset.runtime) || null,
      genres: badge.dataset.genres ? badge.dataset.genres.split("|") : [],
      confidence: badge.dataset.confidence || null, // "low" | "gem" | absent
      runStatus: badge.dataset.runStatus || null,
      imdbId: badge.dataset.imdbId || null,
      year: yearOf(badge),
      matched: named.matched || null,
      approximate: named.approximate === true,
      // Identity, for de-duplication and for not picking the same title twice
      // in a row. The IMDb id when there is one, because the homepage shows the
      // same film under three different rows and often under two labels.
      key: badge.dataset.imdbId || title.toLowerCase()
    };
  }

  // --- the pool -------------------------------------------------------------
  // Re-collected on every draw rather than cached. Cards arrive as the user
  // scrolls, so a pool captured when the panel opened would go stale in the one
  // situation the panel actively suggests — scroll for more, then press again.
  function collect() {
    const stats = { seen: 0, dimmed: 0, unrated: 0, belowBar: 0, wrongKind: 0 };
    const pool = [];
    const seen = new Set();

    const wantKind =
      settings.pickKinds === "movies" ? "movie" : settings.pickKinds === "series" ? "series" : null;

    for (const badge of document.querySelectorAll(".nrx-badge")) {
      const entry = readBadge(badge);
      if (!entry) continue;
      if (seen.has(entry.key)) continue; // the same title in three rows is one title
      seen.add(entry.key);
      stats.seen++;

      // A card the user's own dim filter has pushed back cannot be the thing
      // this recommends — that is the picker arguing with the filter. Same call
      // content.js's best-in-row marker makes, and it has to be the same one:
      // two features disagreeing about whether a title is worth surfacing is
      // worse than either answer.
      if (entry.card.classList.contains("nrx-dimmed") || entry.host.classList.contains("nrx-dimmed")) {
        stats.dimmed++;
        continue;
      }

      if (entry.rating === null) {
        // No rating is not a low rating. It is included only when the user has
        // explicitly asked for the unknown to be in play.
        if (!settings.pickIncludeUnrated) { stats.unrated++; continue; }
      } else if (entry.rating < settings.pickMinRating) {
        stats.belowBar++;
        continue;
      }

      // Kind has to be positively known when the user has narrowed to one.
      // Elsewhere in this extension an absent field means "don't judge it", but
      // that rule is written for dimming, where the cost of not knowing is a
      // title staying visible. Here the cost is offering a series to someone
      // who asked for a film, which they will notice immediately and which
      // makes the whole panel look like it is guessing.
      if (wantKind && entry.kind !== wantKind) { stats.wrongKind++; continue; }

      pool.push(entry);
    }

    return { pool, stats };
  }

  // Rejection sampling rather than `% n`, because the modulo would very slightly
  // favour the first few candidates and a randomiser has nothing to offer
  // except being actually random. Math.random is the fallback for a context
  // without crypto, which https pages are not, but the branch costs a line.
  function randomIndex(count) {
    if (count <= 1) return 0;
    if (typeof crypto === "undefined" || !crypto.getRandomValues) {
      return Math.floor(Math.random() * count);
    }
    const buffer = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / count) * count;
    let value;
    do {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    } while (value >= limit);
    return value % count;
  }

  // --- what a pick looks like on screen -------------------------------------
  function shortVotes(votes) {
    if (votes >= 1000000) return `${(votes / 1000000).toFixed(1)}M`;
    if (votes >= 1000) return `${Math.round(votes / 1000)}K`;
    return String(votes);
  }

  function ratingText(value) {
    return Number(value).toFixed(1);
  }

  function runtimeText(minutes) {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  // IMDb stores its genres capitalised and content.js lower-cases them so the
  // filter comparison is a plain includes(). Putting the case back is display
  // only — the word boundary handles "sci-fi" and "film-noir", which are the
  // two that would otherwise look wrong.
  function genreText(genre) {
    return genre.replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function kindText(kind) {
    if (kind === "movie") return "Film";
    if (kind === "series") return "Series";
    return null;
  }

  // The artwork, found lazily and only for the title actually drawn — a pass
  // over every card's images at collection time would be work for forty-six
  // titles nobody is going to see.
  //
  // The <img> is the usual case on every platform. The computed-style sweep
  // after it is for a tile that paints its poster as a background, which is a
  // shape none of these sites currently uses but which costs almost nothing to
  // survive. Both are capped: no artwork is a fine outcome, and the panel lays
  // out without it.
  function artworkFor(entry) {
    const scopes = entry.host === entry.card ? [entry.card] : [entry.host, entry.card];

    for (const scope of scopes) {
      for (const image of scope.querySelectorAll("img")) {
        const source = image.currentSrc || image.getAttribute("src") || "";
        // data: URIs on these sites are 1px placeholders standing in for an
        // image that has not loaded; showing one would be a grey smear where
        // the poster should be.
        if (!source || source.startsWith("data:")) continue;
        if (image.naturalWidth && image.naturalWidth < 40) continue;
        return source;
      }
    }

    for (const scope of scopes) {
      const candidates = [scope, ...scope.querySelectorAll("*")].slice(0, 24);
      for (const node of candidates) {
        const painted = getComputedStyle(node).backgroundImage;
        const match = painted && painted.match(/url\((['"]?)(https?:[^'")]+)\1\)/);
        if (match) return match[2];
      }
    }

    return null;
  }

  // The card's own link, which is the only honest "go and watch it" this panel
  // can offer: it is the destination the user would have reached by clicking
  // the tile themselves, so it lands wherever the site intends rather than
  // wherever we guessed.
  function linkFor(entry) {
    const anchor =
      (entry.card.matches("a[href]") && entry.card) ||
      entry.card.querySelector("a[href]") ||
      entry.card.closest("a[href]") ||
      entry.host.closest("a[href]");

    if (!anchor) return null;
    const href = anchor.href;
    // A "#" or a javascript: handler is a button wearing an anchor's clothes,
    // and following one would do nothing while looking like it should.
    if (!/^https?:/i.test(href)) return null;
    return href;
  }

  // --- state ----------------------------------------------------------------
  let root = null;
  let trigger = null;
  let backdrop = null;
  let panel = null;
  let bodyEl = null;
  let liveEl = null;
  let watchLink = null;
  let againButton = null;
  let showButton = null;
  let imdbLink = null;
  let provenanceEl = null;
  let barEl = null;
  let caveatEl = null;

  let isOpen = false;
  let opener = null;
  let current = null;   // the entry on screen, or null in the empty state
  let lastKey = null;   // so "pick again" never immediately repeats itself
  let hasDrawn = false; // whether the live region should announce
  let spotlightTimer = null;
  let watchObserver = null;

  const MOD_LABEL =
    /mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? "⌘" : "Ctrl";

  // --- rendering ------------------------------------------------------------
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderPick(entry, stats, poolSize) {
    current = entry;
    bodyEl.textContent = "";

    const source = artworkFor(entry);
    if (source) {
      const art = document.createElement("img");
      art.className = "nrx-pick-art";
      art.src = source;
      // Decorative: the title is spelled out beside it, and "poster for X" read
      // aloud immediately before "X" is noise.
      art.alt = "";
      bodyEl.appendChild(art);
    }

    const details = element("div", "nrx-pick-details");

    const heading = element("h3", "nrx-pick-name", entry.title);
    heading.id = "nrx-pick-name";
    details.appendChild(heading);

    // The score, the same three colours the badge uses, because someone who has
    // learned that green means "worth it" on a card should not have to learn it
    // again here. Tier is recomputed from the live threshold rather than copied
    // off the badge's data-tier, so a threshold changed while the panel is open
    // colours the pick correctly on the next draw.
    const scoreRow = element("div", "nrx-pick-score-row");
    const score = element("span", "nrx-pick-score");
    if (entry.rating === null) {
      score.dataset.tier = "unknown";
      score.textContent = "No IMDb rating";
    } else {
      score.dataset.tier =
        entry.rating >= tierHigh ? "high" : entry.rating >= tierMid ? "mid" : "low";
      score.textContent = ratingText(entry.rating);
      const outOf = element("span", "nrx-pick-outof", "/10");
      score.appendChild(outOf);
    }
    scoreRow.appendChild(score);

    // Everything the badge knows that is a fact rather than a verdict, on one
    // line and in the order it answers questions: how many people said so, is
    // it a film or five seasons, when was it, is it finished, how long is it.
    const facts = [];
    if (entry.votes) facts.push(`${entry.votes.toLocaleString()} votes`);
    const kind = kindText(entry.kind);
    if (kind) facts.push(kind);
    if (entry.year) facts.push(String(entry.year));
    if (entry.runStatus) facts.push(entry.runStatus);
    if (entry.kind === "movie" && entry.runtime) facts.push(runtimeText(entry.runtime));
    if (facts.length) scoreRow.appendChild(element("span", "nrx-pick-facts", facts.join(" · ")));

    details.appendChild(scoreRow);

    if (entry.genres.length) {
      details.appendChild(
        element("div", "nrx-pick-genres", entry.genres.map(genreText).join(" · "))
      );
    }

    // The two things that would make this pick a bad one, said before the user
    // commits rather than discovered afterwards. Both are content.js's own
    // judgements, restated: a thin vote count is as often a wrong match as a
    // real result, and an approximate match means the number on screen may
    // belong to a different film with a similar name.
    if (entry.confidence === "low") {
      details.appendChild(
        element(
          "p",
          "nrx-pick-warn",
          entry.votes
            ? `Thin evidence: only ${entry.votes.toLocaleString()} votes. On a title you recognise, that usually means the match is wrong rather than the score.`
            : "Thin evidence: very few votes behind this score."
        )
      );
    } else if (entry.confidence === "gem") {
      details.appendChild(
        element(
          "p",
          "nrx-pick-note",
          `Under-seen: a strong score on only ${shortVotes(entry.votes)} votes.`
        )
      );
    }

    if (entry.matched && entry.matched.toLowerCase() !== entry.title.toLowerCase()) {
      details.appendChild(
        element(
          "p",
          entry.approximate ? "nrx-pick-warn" : "nrx-pick-note",
          entry.approximate
            ? `Matched to "${entry.matched}" on IMDb — the closest name, not an exact one.`
            : `Listed on IMDb as "${entry.matched}".`
        )
      );
    }

    bodyEl.appendChild(details);

    // --- the actions, updated rather than rebuilt ---------------------------
    // Rebuilding them would destroy the button the user's focus is sitting on
    // every time they pressed it, which is the one interaction this panel has
    // to make effortless.
    const href = linkFor(entry);
    watchLink.hidden = !href;
    if (href) {
      watchLink.href = href;
      watchLink.setAttribute("aria-label", `Watch ${entry.title}`);
    } else {
      watchLink.removeAttribute("href");
    }

    // Netflix rebuilds rows as you scroll, so the card this was drawn from can
    // be gone by the time anyone reaches for it.
    showButton.hidden = !entry.card.isConnected;

    imdbLink.hidden = !entry.imdbId;
    if (entry.imdbId) {
      imdbLink.href = `https://www.imdb.com/title/${entry.imdbId}/`;
      imdbLink.setAttribute("aria-label", `Open ${entry.title} on IMDb in a new tab`);
    }

    // One candidate is a real state and a common one on a fresh homepage with a
    // strict threshold. Saying so is better than a button that appears to do
    // nothing when pressed.
    const alone = poolSize < 2;
    againButton.disabled = alone;
    againButton.textContent = alone ? "Nothing else clears the bar" : "Not that one — pick again";

    renderFooter(stats, poolSize);

    if (hasDrawn) {
      const spoken = [entry.title];
      if (entry.rating !== null) spoken.push(`IMDb ${ratingText(entry.rating)}`);
      if (kind) spoken.push(kind);
      if (entry.year) spoken.push(String(entry.year));
      liveEl.textContent = spoken.join(", ");
    }
    hasDrawn = true;
  }

  // How the constraints read back in prose. The user set them in a settings
  // page they are not currently looking at, and a pool of four is only
  // explicable next to the rules that made it four.
  function barText() {
    const parts = [`IMDb ${ratingText(settings.pickMinRating)} or better`];
    if (settings.pickKinds === "movies") parts.push("films only");
    else if (settings.pickKinds === "series") parts.push("series only");
    if (settings.pickIncludeUnrated) parts.push("unrated titles included");
    return `Your bar: ${parts.join(", ")}.`;
  }

  function renderFooter(stats, poolSize) {
    // The honest line. It is deliberately two numbers rather than one: "picked
    // from 12" alone invites the reading that the page holds twelve titles,
    // and the gap between 12 and 47 is the part that tells the user their
    // threshold is doing something.
    provenanceEl.textContent =
      poolSize > 0
        ? `Drawn at random from ${poolSize} of the ${stats.seen} ${
            stats.seen === 1 ? "title" : "titles"
          } loaded on this page.`
        : `${stats.seen} ${stats.seen === 1 ? "title" : "titles"} loaded on this page.`;

    barEl.textContent = barText();

    caveatEl.textContent =
      `${SITE} only builds cards as you scroll to them, so this drew from what is on the ` +
      "page right now — not from the whole catalogue. Scroll to load more rows, then press " +
      "Shift+P again for a wider draw.";
  }

  function renderEmpty(stats) {
    current = null;
    bodyEl.textContent = "";

    const details = element("div", "nrx-pick-details nrx-pick-empty");

    // Two genuinely different failures, and conflating them would send the user
    // to the wrong fix. Nothing rated at all means the badges have not resolved
    // yet — a page that has just loaded, or a surface with no cards on it, and
    // no threshold change will help. Something rated but nothing passing means
    // the settings are the lever.
    if (stats.seen === 0) {
      const heading = element("h3", "nrx-pick-name", "No rated titles on this page yet");
      heading.id = "nrx-pick-name";
      details.appendChild(heading);
      details.appendChild(
        element(
          "p",
          "nrx-pick-empty-body",
          "Ratings appear as cards scroll into view, and a page that has only just loaded may " +
            "not have any yet. Give it a moment, or scroll down a row or two, and press Shift+P " +
            "again. On a player or account page there are no cards to draw from at all."
        )
      );
    } else {
      const heading = element("h3", "nrx-pick-name", "Nothing here clears your bar");
      heading.id = "nrx-pick-name";
      details.appendChild(heading);

      const reasons = [];
      if (stats.belowBar) {
        reasons.push(`${stats.belowBar} rated below ${ratingText(settings.pickMinRating)}`);
      }
      if (stats.unrated) reasons.push(`${stats.unrated} with no IMDb rating`);
      if (stats.wrongKind) {
        reasons.push(
          `${stats.wrongKind} not ${settings.pickKinds === "movies" ? "films" : "series"}`
        );
      }
      if (stats.dimmed) reasons.push(`${stats.dimmed} dimmed by your filter`);

      const breakdown = reasons.length
        ? `Of the ${stats.seen} ${stats.seen === 1 ? "title" : "titles"} on this page: ${list(
            reasons
          )}.`
        : `None of the ${stats.seen} titles on this page qualified.`;

      details.appendChild(element("p", "nrx-pick-empty-body", breakdown));
      details.appendChild(
        element(
          "p",
          "nrx-pick-empty-body",
          `Two things fix it. Scroll down to load more rows — ${SITE} only builds cards as you ` +
            "reach them — then press Shift+P again. Or lower the minimum rating in the " +
            "extension's settings, which is where your bar is set."
        )
      );
    }

    bodyEl.appendChild(details);

    watchLink.hidden = true;
    showButton.hidden = true;
    imdbLink.hidden = true;
    againButton.disabled = false;
    againButton.textContent = "Look again";

    renderFooter(stats, 0);

    if (hasDrawn) liveEl.textContent = "Nothing on this page clears your bar.";
    hasDrawn = true;
  }

  function list(items) {
    if (items.length === 1) return items[0];
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }

  // --- drawing --------------------------------------------------------------
  function draw() {
    const { pool, stats } = collect();

    if (!pool.length) {
      lastKey = null;
      renderEmpty(stats);
      return;
    }

    // Never the same title twice running when there is anything else to offer.
    // "Not that one" that returns that one is the single most obvious way this
    // control could look broken.
    let choices = pool;
    if (pool.length > 1 && lastKey) {
      const others = pool.filter((entry) => entry.key !== lastKey);
      if (others.length) choices = others;
    }

    const entry = choices[randomIndex(choices.length)];
    lastKey = entry.key;
    renderPick(entry, stats, pool.length);
  }

  // --- showing the card it came from ---------------------------------------
  // The panel closes first, deliberately: the point of this button is to hand
  // the user back to the site's own tile, where hovering, the preview and every
  // control they already know still work.
  function spotlight() {
    if (!current) return;
    const card = current.card;
    if (!card.isConnected) return;

    close();

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView({ block: "center", inline: "center", behavior: reduced ? "auto" : "smooth" });

    // A ring rather than anything that moves the card. Adding a class to the
    // site's own element is what content.js already does to dim one, and this
    // one takes itself off again — nothing here is a lasting change to a page
    // we do not own.
    clearTimeout(spotlightTimer);
    for (const stale of document.querySelectorAll(".nrx-pick-spot")) {
      stale.classList.remove("nrx-pick-spot");
    }
    card.classList.add("nrx-pick-spot");
    spotlightTimer = setTimeout(() => card.classList.remove("nrx-pick-spot"), SPOTLIGHT_MS);

    // Focus follows the eye. close() has just put it back where it came from,
    // which is the right answer for every other exit from this panel and the
    // wrong one for this button — the whole point of it is that the user is now
    // looking somewhere else. preventScroll so the handoff cannot fight the
    // smooth scroll it was issued alongside.
    const stop = card.matches("a[href], button") ? card : card.querySelector("a[href], button");
    if (stop) stop.focus({ preventScroll: true });
  }

  // --- open and close -------------------------------------------------------
  function open() {
    if (isOpen) return;
    mount();
    isOpen = true;
    hasDrawn = false;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    backdrop.hidden = false;
    panel.hidden = false;
    liveEl.textContent = "";
    if (trigger) trigger.setAttribute("aria-expanded", "true");

    draw();

    // The dialog itself rather than a control inside it, so a screen reader
    // reads the panel's name and the pick before announcing a button.
    panel.focus();

    // Only while open, and separate from the page-lifetime sync at the bottom
    // of this file. That one is debounced by 300ms, which is the right answer
    // for a corner button and the wrong one for a dialog the user is looking
    // at: an open panel torn out and put back a third of a second later would
    // flicker and drop focus. This one reacts immediately and does nothing
    // else.
    watchObserver = new MutationObserver(() => {
      if (isOpen && root && !root.isConnected) document.body.appendChild(root);
    });
    watchObserver.observe(document.body, { childList: true });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    current = null;

    backdrop.hidden = true;
    panel.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");

    if (watchObserver) {
      watchObserver.disconnect();
      watchObserver = null;
    }

    // Back where focus came from, and back to the corner button when that no
    // longer exists — the site can navigate underneath an open dialog, and
    // focus landing on <body> would strand a keyboard user at the top of the
    // document with no idea where they are.
    let target = opener && opener.isConnected ? opener : null;
    if (!target && trigger && trigger.isConnected) target = trigger;
    opener = null;
    if (target) target.focus();
  }

  // --- the DOM --------------------------------------------------------------
  function focusables() {
    return [...panel.querySelectorAll('a[href], button:not([disabled]), [tabindex="0"]')].filter(
      (node) => !node.hidden && node.getClientRects().length > 0
    );
  }

  // A dialog that lets Tab wander into the page behind it is one a screen
  // reader user cannot tell they are still inside — and the page behind this
  // one is a grid with a tab stop on every tile. The panel itself is the wrap
  // point when nothing inside it is focusable, which is the empty state with
  // every action hidden.
  function trapTab(event) {
    const stops = focusables();
    if (!stops.length) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function build() {
    const container = element("div", "nrx-pick-root");

    backdrop = element("div", "nrx-pick-backdrop");
    backdrop.hidden = true;
    backdrop.addEventListener("click", close);

    panel = element("div", "nrx-pick-panel");
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "nrx-pick-title");
    panel.setAttribute("aria-describedby", "nrx-pick-name");
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Tab") trapTab(event);
    });

    const header = element("div", "nrx-pick-header");
    const title = element("h2", "nrx-pick-title", "Pick one for me");
    title.id = "nrx-pick-title";

    const dismiss = element("button", "nrx-pick-close", "✕");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Close");
    dismiss.addEventListener("click", close);
    header.append(title, dismiss);

    bodyEl = element("div", "nrx-pick-body");

    // Off-screen rather than hidden, because `hidden` and display:none take a
    // live region out of the accessibility tree and it would announce nothing.
    // Only re-draws are announced: the first one is already covered by the
    // dialog reading its own label and description on open.
    liveEl = element("div", "nrx-pick-live");
    liveEl.setAttribute("role", "status");
    liveEl.setAttribute("aria-live", "polite");

    const actions = element("div", "nrx-pick-actions");

    // A real anchor, so middle-click and the modifier chord keep the meanings
    // the browser already gives them, and so the destination shows in the
    // status bar before anyone commits to it.
    watchLink = element("a", "nrx-pick-go", "Watch this");
    watchLink.hidden = true;
    watchLink.addEventListener("click", (event) => {
      // No preventDefault anywhere on this path: the anchor's own navigation is
      // the feature. This only gets the panel out of the way first, and stays
      // out of the way itself when a modifier means "open it elsewhere".
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      close();
    });

    againButton = element("button", "nrx-pick-again", "Not that one — pick again");
    againButton.type = "button";
    againButton.addEventListener("click", draw);

    showButton = element("button", "nrx-pick-show", "Show it on the page");
    showButton.type = "button";
    showButton.hidden = true;
    showButton.addEventListener("click", spotlight);

    imdbLink = element("a", "nrx-pick-imdb", "IMDb page");
    imdbLink.target = "_blank";
    // noopener because the new tab is IMDb's page and has no business holding a
    // handle back to this window.
    imdbLink.rel = "noopener noreferrer";
    imdbLink.hidden = true;

    actions.append(watchLink, againButton, showButton, imdbLink);

    const footer = element("div", "nrx-pick-footer");
    provenanceEl = element("div", "nrx-pick-provenance");
    barEl = element("div", "nrx-pick-bar");
    caveatEl = element("div", "nrx-pick-caveat");
    const keys = element(
      "div",
      "nrx-pick-keys",
      `Shift+P draws again · Esc closes · ${MOD_LABEL}-click a link for a new tab`
    );
    footer.append(provenanceEl, barEl, caveatEl, keys);

    panel.append(header, bodyEl, liveEl, actions, footer);
    container.append(backdrop, panel);
    return container;
  }

  function mount() {
    if (!root) root = build();
    if (!root.isConnected) document.body.appendChild(root);
  }

  // --- the corner button ----------------------------------------------------
  // Why this exists at all: a chord nobody was told about is not an entry
  // point. Shift+P is the fast path for the second time and every time after,
  // and it stays the fast path — but the first time has to be something a user
  // can find by looking, in the corner where they already look for an
  // extension's own controls. The tooltip names the chord, so the button
  // teaches it rather than replacing it.
  //
  // Built once and kept, like genres.js's. It is never given a tabindex: it is
  // appended to the end of <body>, so it is the last tab stop on the page
  // rather than something a keyboard user has to walk past to reach the site's
  // own content.
  function buildTrigger() {
    const button = element("button", "nrx-pick-trigger nrx-launcher-item", "Pick for me");
    button.type = "button";
    button.dataset.launch = "pick";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Pick something for me to watch");
    button.setAttribute("aria-keyshortcuts", "Shift+P");
    button.title = "Pick something for me to watch (Shift+P)";

    // Exactly what the chord does, for the same reason it does it: pressing
    // again means "not that one". In practice the second half is unreachable —
    // the panel's scrim sits above the launcher — but a button and a chord that
    // disagree about what they mean is not a thing worth shipping to save a
    // line.
    button.addEventListener("click", () => {
      if (isOpen) draw();
      else open();
    });

    return button;
  }

  function syncTrigger() {
    if (!triggerBelongsHere()) {
      // Our button leaves the launcher; the launcher is not ours to remove and
      // genres.js may still have a button in it. An empty one hides itself —
      // see `.nrx-launcher:empty` in pick.css.
      if (trigger && trigger.isConnected) trigger.remove();
      return;
    }

    if (!trigger) trigger = buildTrigger();

    const bar = launcher();
    // Re-appending the same element keeps its listener, so a re-render that
    // swept the corner away costs one appendChild. The parent check stops this
    // re-ordering the stack on every pass; order between the two buttons is
    // CSS's job, not append order's.
    if (trigger.parentElement !== bar) bar.appendChild(trigger);

    // A second injection of this file would otherwise leave two identical
    // buttons in one corner.
    for (const stray of document.querySelectorAll(".nrx-pick-trigger")) {
      if (stray !== trigger) stray.remove();
    }
  }

  // --- keyboard -------------------------------------------------------------
  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  // Shift+P, for pick. Capture, because these sites bind keys on the document
  // and stop propagation on the ones they claim — listening on the way down is
  // what makes the chord work over a card the site has expanded.
  //
  // Pressing it again re-draws rather than closing, which is the difference
  // between this and every other panel in the extension. "I can't decide" is
  // usually answered on the third or fourth try, and holding Shift while
  // tapping P until something appeals is the shortest form that can take.
  // Escape is the way out, and the footer says so.
  addEventListener(
    "keydown",
    (event) => {
      if (!event.shiftKey || event.key.toLowerCase() !== "p") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      event.preventDefault();
      if (isOpen) draw();
      else open();
    },
    { capture: true }
  );

  // Escape at the document level and capturing, so it beats the site's own
  // Escape handling — which closes previews and exits the player, and would
  // otherwise fire underneath a dialog the user was trying to dismiss.
  addEventListener(
    "keydown",
    (event) => {
      if (!isOpen || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    { capture: true }
  );

  // The net under the Tab cycling: anything that lands focus outside an open
  // modal — the site moving focus itself, a click reaching the page behind the
  // scrim — is pulled straight back to the panel.
  addEventListener("focusin", (event) => {
    if (!isOpen || !panel) return;
    if (event.target instanceof Node && panel.contains(event.target)) return;
    panel.focus();
  });

  // --- settings, read once then subscribed ---------------------------------
  // tierHigh and tierMid are not this feature's own keys, but both are read: the
  // first is the documented fallback for an unset minimum, and the pair decides
  // what colour the score wears, which has to agree with the badge it came from.
  const WATCHED_KEYS = ["pickMinRating", "pickKinds", "pickIncludeUnrated", "tierHigh", "tierMid"];

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!WATCHED_KEYS.some((key) => key in changes)) return;

    // Rebuilt as a whole record rather than patched key by key, so applySettings
    // stays the single place a stored value is interpreted — one normaliser, one
    // set of fallbacks, on both the start-up path and this one.
    const merged = {
      // `undefined` while inherited, so applySettings re-runs the fallback
      // against the new tierHigh instead of re-reading a number it resolved
      // earlier. Passing the resolved value here is what would sever the link.
      pickMinRating: pickMinInherited ? undefined : settings.pickMinRating,
      pickKinds: settings.pickKinds,
      pickIncludeUnrated: settings.pickIncludeUnrated,
      tierHigh,
      tierMid
    };
    for (const key of WATCHED_KEYS) {
      if (key in changes) merged[key] = changes[key].newValue;
    }
    applySettings(merged);

    // A threshold changed while the panel is open has changed the pool, and the
    // title on screen may no longer qualify. Re-drawing is the only state that
    // is not a lie; lastKey is cleared first so the current pick is eligible
    // again rather than being excluded from the very draw that re-tests it.
    if (isOpen) {
      lastKey = null;
      draw();
    }
  });

  // --- keeping the corner button on the page --------------------------------
  // The same bargain genres.js makes, for the same reason: the button is now a
  // page-lifetime fixture on sites that rebuild their DOM underneath it, so
  // something has to notice it being swept away. Debounced the way content.js
  // and sort.js debounce theirs — these sites rebuild in bursts, and a burst
  // should cost one pass. syncTrigger() writes nothing when nothing changed, so
  // it cannot feed itself.
  //
  // subtree:true rather than watching <body>'s own children, even though that
  // is where the launcher sits. A client-side navigation from a grid to the
  // player often leaves body's direct children alone while replacing
  // everything below them, and a "pick something" button left floating over a
  // film is the exact failure this is here to prevent.
  let syncTimer = null;
  const pageObserver = new MutationObserver(() => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncTrigger, 300);
  });

  pageObserver.observe(document.body, { childList: true, subtree: true });

  // These sites navigate client-side, and a Back that only changes the URL
  // leaves the observer nothing to see.
  addEventListener("popstate", syncTrigger);

  syncTrigger();

  (async function start() {
    try {
      const saved = await chrome.storage.local.get(WATCHED_KEYS);
      applySettings(saved);
    } catch (e) {
      // Storage unavailable is not fatal — the defaults above are usable, and a
      // picker that refused to open because it could not read a threshold would
      // be worse than one running on 7.5.
    }
  })();
})();
