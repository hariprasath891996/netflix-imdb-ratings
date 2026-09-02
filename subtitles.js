// Subtitle styling: size, face, colour, backdrop, opacity, and — the one that
// justifies the rest — a lift that raises the subtitles off the bottom of the
// frame, out from under the player controls.
//
// This file writes no styles of its own. Every rule lives in subtitles.css and
// reads custom properties from <html>; all this does is normalise the seven
// settings, put them on the root element, and take them off again. That split is
// deliberate and is explained at the top of the stylesheet: Netflix rewrites the
// timed-text container's inline style on every resize and every fullscreen
// change, and rebuilds the container outright when the track changes, so
// anything applied element by element would have to be re-applied for as long as
// the video ran. A stylesheet is re-matched for free.
//
// The consequence worth stating plainly: this script never queries, reads or
// mutates a single node inside the player. If the selectors in the stylesheet
// are wrong, the feature does nothing at all — it cannot half-apply, and it
// cannot break playback.
//
// It also never reads the subtitle text. Styling what is on screen and
// capturing what it says are different features with different consequences,
// and the second one is not built.
//
// Content scripts injected into the same world share one global lexical scope,
// so a top-level `const` here would collide with content.js's, sort.js's or
// genres.js's and throw before any of them ran. Everything is closed over.
(function () {
  "use strict";

  // The manifest injects this on Prime Video, Amazon and Disney+ as well, and
  // the class names the stylesheet matches are Netflix's own. Prime's and
  // Disney's timed-text DOM has not been looked at, and inventing selectors for
  // players nobody here can open is how a feature ends up shipped and broken at
  // the same time. Netflix only, until someone has actually seen the others.
  if (!/(^|\.)netflix\.com$/.test(location.hostname)) return;

  // defaults.js is injected first and declares WATCH_DEFAULTS in this same
  // shared scope. It is read rather than copied — a second set of numbers here
  // would drift from the options page the first time one of them changed — but
  // it is read defensively, because a bare reference to a missing const throws
  // rather than yielding undefined.
  const DEFAULTS =
    typeof WATCH_DEFAULTS === "object" && WATCH_DEFAULTS ? WATCH_DEFAULTS : {};

  const KEYS = [
    "subsEnabled",
    "subsFontSize",
    "subsFontFamily",
    "subsColour",
    "subsBackdrop",
    "subsOpacity",
    "subsLift"
  ];

  // The bounds the contract sets. They are validation, not defaults: a value
  // outside them is a corrupted or hand-edited setting, and clamping is kinder
  // than either ignoring it or rendering subtitles at 4000%.
  const SIZE_MIN = 50;
  const SIZE_MAX = 250;
  const OPACITY_MIN = 20;
  const OPACITY_MAX = 100;
  const LIFT_MIN = 0;
  const LIFT_MAX = 40;

  const BACKDROPS = ["none", "shadow", "outline", "box"];

  // The two values that mean "leave Netflix alone". Kept as names because the
  // stylesheet's whole approach is that an untouched setting adds no rule at
  // all, and that decision is made against exactly these.
  const NEUTRAL_SIZE = 100;
  const NEUTRAL_OPACITY = 100;
  const NEUTRAL_COLOUR = "#ffffff";

  let settings = null;

  function clamp(value, min, max, fallback) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function normaliseColour(value) {
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim())) {
      return value.trim().toLowerCase();
    }
    return typeof DEFAULTS.subsColour === "string"
      ? DEFAULTS.subsColour
      : NEUTRAL_COLOUR;
  }

  // The one setting that is free text, so the one that gets sanitised. It ends
  // up inside a CSS declaration, and while setProperty() rejects a value it
  // cannot parse — there is no declaration to break out of — a family list is
  // still narrowed to the characters a family list can legitimately contain,
  // and capped, rather than trusted because it happens to be hard to abuse.
  //
  // A generic is appended so a name the machine does not have falls back to
  // something sane instead of to whatever the UA picks for an unknown family.
  function normaliseFamily(value) {
    if (typeof value !== "string") return "";
    const cleaned = value
      .replace(/[^A-Za-z0-9 _\-,'"]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (!cleaned) return "";
    return /\b(sans-serif|serif|monospace|cursive|fantasy|system-ui)\s*$/i.test(
      cleaned
    )
      ? cleaned
      : cleaned + ", sans-serif";
  }

  function normalise(saved) {
    return {
      enabled:
        typeof saved.subsEnabled === "boolean"
          ? saved.subsEnabled
          : DEFAULTS.subsEnabled === true,
      size: clamp(
        saved.subsFontSize,
        SIZE_MIN,
        SIZE_MAX,
        typeof DEFAULTS.subsFontSize === "number"
          ? DEFAULTS.subsFontSize
          : NEUTRAL_SIZE
      ),
      family: normaliseFamily(
        typeof saved.subsFontFamily === "string"
          ? saved.subsFontFamily
          : DEFAULTS.subsFontFamily
      ),
      colour: normaliseColour(saved.subsColour),
      backdrop: BACKDROPS.includes(saved.subsBackdrop)
        ? saved.subsBackdrop
        : BACKDROPS.includes(DEFAULTS.subsBackdrop)
          ? DEFAULTS.subsBackdrop
          : "shadow",
      opacity: clamp(
        saved.subsOpacity,
        OPACITY_MIN,
        OPACITY_MAX,
        typeof DEFAULTS.subsOpacity === "number"
          ? DEFAULTS.subsOpacity
          : NEUTRAL_OPACITY
      ),
      lift: clamp(
        saved.subsLift,
        LIFT_MIN,
        LIFT_MAX,
        typeof DEFAULTS.subsLift === "number" ? DEFAULTS.subsLift : LIFT_MIN
      )
    };
  }

  // Netflix is one page from load to logout, so the route has to be watched
  // rather than read once. Playback is /watch/<id>, allowing for the locale
  // segment Netflix puts in front of it in some markets.
  //
  // Strictly the stylesheet is already inert on the browse surface — nothing
  // there carries the timed-text class — but leaving the flags on <html> while
  // the user browsed would be claiming to do something the extension is not
  // doing, and would be the first thing to mislead whoever debugs this next.
  function onPlayback() {
    return /(^|\/)watch(\/|$)/.test(location.pathname);
  }

  // Everything the feature does to the page, in one function, on one element.
  // Each flag is written only when the setting is off its neutral value, so a
  // user who changed nothing but the lift gets exactly one rule applied and
  // Netflix's own type, colour and sizing everywhere else.
  function apply() {
    const root = document.documentElement;
    if (!root) return;

    const style = root.style;
    const live = settings && settings.enabled && onPlayback();

    if (!live) {
      // Removed rather than zeroed, so nothing of ours is left behind on the
      // browse surface or after the feature is switched off.
      root.removeAttribute("data-nrx-subs");
      root.removeAttribute("data-nrx-subs-size");
      root.removeAttribute("data-nrx-subs-family");
      root.removeAttribute("data-nrx-subs-colour");
      root.removeAttribute("data-nrx-subs-backdrop");
      root.removeAttribute("data-nrx-subs-opacity");
      root.removeAttribute("data-nrx-subs-lift");
      style.removeProperty("--nrx-subs-size");
      style.removeProperty("--nrx-subs-family");
      style.removeProperty("--nrx-subs-colour");
      style.removeProperty("--nrx-subs-opacity");
      style.removeProperty("--nrx-subs-lift");
      return;
    }

    if (settings.size !== NEUTRAL_SIZE) {
      style.setProperty("--nrx-subs-size", String(settings.size));
      root.setAttribute("data-nrx-subs-size", "on");
    } else {
      style.removeProperty("--nrx-subs-size");
      root.removeAttribute("data-nrx-subs-size");
    }

    if (settings.family) {
      style.setProperty("--nrx-subs-family", settings.family);
      root.setAttribute("data-nrx-subs-family", "on");
    } else {
      style.removeProperty("--nrx-subs-family");
      root.removeAttribute("data-nrx-subs-family");
    }

    // White is Netflix's own colour, so choosing it is choosing not to
    // interfere — and interfering anyway would strip the colours a track sets
    // for itself, which some use to tell speakers apart.
    if (settings.colour !== NEUTRAL_COLOUR) {
      style.setProperty("--nrx-subs-colour", settings.colour);
      root.setAttribute("data-nrx-subs-colour", "on");
    } else {
      style.removeProperty("--nrx-subs-colour");
      root.removeAttribute("data-nrx-subs-colour");
    }

    if (settings.opacity !== NEUTRAL_OPACITY) {
      style.setProperty("--nrx-subs-opacity", String(settings.opacity));
      root.setAttribute("data-nrx-subs-opacity", "on");
    } else {
      style.removeProperty("--nrx-subs-opacity");
      root.removeAttribute("data-nrx-subs-opacity");
    }

    if (settings.lift > 0) {
      style.setProperty("--nrx-subs-lift", String(settings.lift));
      root.setAttribute("data-nrx-subs-lift", "on");
    } else {
      style.removeProperty("--nrx-subs-lift");
      root.removeAttribute("data-nrx-subs-lift");
    }

    // The backdrop has no neutral: one of the four is always in force, and the
    // stylesheet keys off the value rather than a flag.
    root.setAttribute("data-nrx-subs-backdrop", settings.backdrop);

    // Written last, so a repaint that catches this mid-update sees the flags
    // and the properties already in place rather than a half-configured state.
    root.setAttribute("data-nrx-subs", "on");
  }

  // --- watching the route ---------------------------------------------------

  let lastPlayback = null;

  function syncRoute() {
    const playing = onPlayback();
    if (playing === lastPlayback) return;
    lastPlayback = playing;
    apply();
  }

  let observer = null;
  let routeTimer = null;

  // Netflix navigates client-side and does not announce it, so entering and
  // leaving the player is noticed the way genres.js notices its own surface
  // changing: one debounced observer, never a timer loop. The callback is a
  // string comparison and returns immediately when the route has not moved,
  // which matters because the timed-text container mutates on every cue.
  //
  // Only running while the feature is enabled — a user who leaves subtitle
  // styling off, which is the default, pays nothing for it at all.
  function watchRoute() {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => {
      clearTimeout(routeTimer);
      routeTimer = setTimeout(syncRoute, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    addEventListener("popstate", syncRoute);
  }

  function unwatchRoute() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    clearTimeout(routeTimer);
    removeEventListener("popstate", syncRoute);
  }

  function refresh() {
    lastPlayback = onPlayback();
    apply();
    if (settings && settings.enabled) watchRoute();
    else unwatchRoute();
  }

  // A settings change should land on the open tab immediately: someone tuning
  // the lift is watching the subtitles move while they drag, and having to
  // reload the player to see each step would make the setting untunable.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!KEYS.some((key) => changes[key])) return;
    // Re-normalised from the whole set rather than patched key by key, because
    // the flags written above are decided by combinations of them.
    chrome.storage.local
      .get(KEYS)
      .then((saved) => {
        settings = normalise(saved);
        refresh();
      })
      .catch(() => {
        // Storage gone means the extension was reloaded or updated underneath
        // this tab. The old styling stays until the page is reloaded, which is
        // the quiet failure rather than the loud one.
      });
  });

  (async function start() {
    try {
      settings = normalise(await chrome.storage.local.get(KEYS));
    } catch (e) {
      // Storage unavailable is not fatal, it is simply the feature not running.
      settings = normalise({});
    }
    refresh();
  })();
})();
