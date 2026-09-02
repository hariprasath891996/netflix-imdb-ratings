// Three things the player itself should have done: skip the bits nobody
// watches, run at whatever speed suits, and answer more than five keys.
//
// This file is the one part of the extension that touches playback, and the
// boundary it works inside is worth stating once at the top rather than
// discovering later: Netflix's video is Widevine-protected. Nothing here reads
// a frame, draws to a canvas, or goes anywhere near the media pipeline. It
// clicks Netflix's own buttons and it sets public properties on an
// HTMLMediaElement — `playbackRate` and `currentTime` — which is exactly what
// the player's own controls do. That line is not a style preference; crossing
// it would be circumvention, and it is why frame capture is not on the roadmap.
//
// Content scripts injected into the same world share one global lexical scope,
// so a top-level `const` here would collide with content.js's, sort.js's or
// genres.js's and throw before any of them ran. Everything below is closed
// over instead.
//
// --- keyboard map -----------------------------------------------------------
// All of these are player-only: they do nothing outside /watch. Every one of
// them is either absent from Netflix or badly served by it, which is the whole
// admission test — rebinding space, f, m or the arrows would be taking a
// working shortcut away from someone who already knows it.
//
//   [   playback speed down one step (0.25)
//   ]   playback speed up one step
//   \   playback speed back to 1x
//       Netflix's own speed menu stops at 0.5x and 1.5x. This runs 0.25x-4x.
//
//   (no seek keys — j and l were removed after they were measured breaking
//    playback outright. The reasoning is kept where seekBy used to live, so
//    that anyone tempted to add them back reads the evidence first.)
//
//   n   next episode
//       Netflix has the control but no key for it, so the only way to move on
//       is to find the mouse.
//
//   c   hide/show the subtitle layer
//       Netflix's subtitle track lives four clicks deep in a menu, and there is
//       no key at all. Note what this does and does not do: it hides the cues
//       Netflix has already rendered, locally. It does not change the track
//       Netflix has selected, because doing that means driving Netflix's own
//       menu and writing the choice back to the account — and this extension
//       does not write to anyone's Netflix account.
//
// Two switches, not one: [, ] and \ answer to `playerSpeedEnabled`, while n and
// c answer to `playerShortcuts`. The second exists because those two are
// unmodified single letters — Netflix's own chord space — so a future Netflix
// binding really could collide with them in a way it cannot with the rest.
//
// Deliberately not bound, both for the same reason: previous episode, because
// Netflix's player has no previous control to click; and seeking, because the
// only mechanism that worked broke playback and the safe one does nothing. A
// shortcut that silently does nothing is worse than an absent one, and one that
// kills the stream is worse than both.
(function () {
  "use strict";

  // Every selector below is Netflix's. Prime Video and Disney+ have their own
  // player routes and their own markup, and guessing at them from here would
  // ship three broken features rather than one working one.
  if (!/(^|\.)netflix\.com$/.test(location.hostname)) return;

  // --- what "in the player" means --------------------------------------------
  // Netflix is a single-page app: /browse to /watch is a pushState, with no
  // load event and no unload. Reading location once at startup would leave
  // every feature here dead for anyone who started on the homepage, which is
  // everyone. The URL is re-read on every pass instead.
  const WATCH_PATH = /^\/watch\/(\d+)/;

  function episodeKey() {
    const match = WATCH_PATH.exec(location.pathname);
    return match ? match[1] : null;
  }

  // The player's own root. Used to scope every query, so a stray button
  // elsewhere in the app can never be mistaken for a player control, and as
  // the parent for the toast — which matters more than it looks, because an
  // overlay that is not a descendant of the fullscreen element is not rendered
  // at all in fullscreen.
  const PLAYER_ROOTS = [
    '[data-uia="player"]',
    ".watch-video",
    ".NFPlayer"
  ];

  function playerRoot() {
    for (const selector of PLAYER_ROOTS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  // Netflix mounts hover-preview players on browse pages too, so "the video on
  // the page" is only unambiguous once we know we are on /watch. Scoped to the
  // player root where there is one; the bare fallback is for the case where
  // Netflix has renamed its container and the root lookup came back empty,
  // which should still leave speed and seeking working.
  function currentVideo() {
    if (!episodeKey()) return null;
    const root = playerRoot();
    const video = (root || document).querySelector("video");
    return video instanceof HTMLVideoElement ? video : null;
  }

  // --- settings ---------------------------------------------------------------
  // Read once, then subscribe. Same shape as the block at the bottom of
  // content.js: one get, then onChanged filtered to the local area, so a
  // setting toggled in the options page takes effect on a tab that is already
  // mid-episode rather than after a reload.
  const KEYS = [
    "playerSkipIntro",
    "playerSkipRecap",
    "playerSkipCredits",
    "playerSpeedEnabled",
    "playerSpeedPersist",
    "playerShortcuts"
  ];

  const settings = {
    playerSkipIntro: WATCH_DEFAULTS.playerSkipIntro,
    playerSkipRecap: WATCH_DEFAULTS.playerSkipRecap,
    playerSkipCredits: WATCH_DEFAULTS.playerSkipCredits,
    playerSpeedEnabled: WATCH_DEFAULTS.playerSpeedEnabled,
    playerSpeedPersist: WATCH_DEFAULTS.playerSpeedPersist,
    playerShortcuts: WATCH_DEFAULTS.playerShortcuts
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of KEYS) {
      if (!changes[key]) continue;
      const value = changes[key].newValue;
      settings[key] = typeof value === "boolean" ? value : WATCH_DEFAULTS[key];
    }
  });

  (async function loadSettings() {
    try {
      const saved = await chrome.storage.local.get(KEYS);
      for (const key of KEYS) {
        if (typeof saved[key] === "boolean") settings[key] = saved[key];
      }
    } catch (e) {
      // Storage unavailable is not fatal — the defaults are the shipped
      // behaviour, and skipping an intro is not worth a thrown error over.
    }
  })();

  // --- the toast --------------------------------------------------------------
  // One element, reused. Re-parented on every show rather than parked
  // somewhere at startup, because the right parent changes: in fullscreen only
  // a descendant of the fullscreen element is painted, and Netflix replaces the
  // player subtree often enough that a node appended once will not still be
  // attached an episode later.
  let toastEl = null;
  let toastTimer = null;

  function toastHost() {
    return document.fullscreenElement || playerRoot() || document.body;
  }

  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "nrx-player-toast";

      // Announced rather than silent: a speed change with no visible indicator
      // is confusing enough sighted, and invisible otherwise.
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
    }

    const host = toastHost();
    if (toastEl.parentNode !== host) host.appendChild(toastEl);

    toastEl.textContent = text;
    toastEl.classList.add("nrx-player-toast--on");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.classList.remove("nrx-player-toast--on");
    }, 1100);
  }

  // --- feature 38: auto-skip --------------------------------------------------
  // Netflix's class names are CSS-in-JS hashes that change on every deploy, so
  // the only stable hook is `data-uia` — Netflix's own test-automation
  // attribute, which their QA depends on. Substring matching rather than
  // equality, because the exact value has carried suffixes before
  // ("-draining") and a prefix change would otherwise silently kill the
  // feature.
  //
  // Text is a fallback and never the primary. The visible label is "Skip
  // Intro" in English, "Intro überspringen" in German and something else again
  // in Hindi — keying off it would ship a feature that works for one locale.
  const SKIP_RULES = [
    {
      kind: "intro",
      setting: "playerSkipIntro",
      selectors: ['[data-uia*="skip-intro" i]'],
      text: /skip\s*intro/i,
      requireEndOfEpisode: false
    },
    {
      kind: "recap",
      setting: "playerSkipRecap",
      selectors: [
        '[data-uia*="skip-recap" i]',
        '[data-uia*="skip-preplay" i]',
        '[data-uia*="skip-previously" i]'
      ],
      text: /skip\s*(recap|previously|preplay)/i,
      requireEndOfEpisode: false
    },
    {
      kind: "credits",
      setting: "playerSkipCredits",
      selectors: [
        '[data-uia*="skip-credits" i]',
        '[data-uia*="next-episode-seamless" i]'
      ],
      text: /next\s*episode/i,

      // The one rule that moves you to different content, and the only one
      // where a wrong match is expensive rather than merely useless: matching
      // something in the control bar would advance the episode the moment
      // playback started. Requiring that most of the episode has already
      // played makes that failure impossible rather than unlikely.
      requireEndOfEpisode: true
    }
  ];

  // Auto-clicking is opt-in per rule and blind to everything else, but blind
  // is not the same as safe. Nothing whose hook reads like leaving, closing or
  // discarding is ever clicked, and neither is anything in the persistent
  // control bar — those are the buttons a mis-tuned substring would find
  // first, and they are all things the user is entitled to press themselves.
  const NEVER_AUTOCLICK = /control-|back|close|exit|cancel|dismiss|delete|remove|report|sign-?out|logout/i;

  // Fired-once bookkeeping. Two layers, because they fail differently: the
  // kind set is what stops a second intro-skip after Netflix re-renders the
  // button, and the node set is what stops a burst of mutations in the same
  // tick from clicking one element three times. A skip that fires twice skips
  // two things, which is the exact bug this feature would be judged on.
  let firedKinds = new Set();
  let clickedNodes = new WeakSet();

  function uiaOf(el) {
    return el.getAttribute("data-uia") || "";
  }

  function clickable(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (!el.isConnected) return false;
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;

    // Netflix pre-mounts these controls and reveals them, so presence in the
    // DOM is not presence on screen. Clicking a laid-out-nowhere button skips
    // an intro that has not started.
    if (!el.getClientRects().length) return false;

    if (NEVER_AUTOCLICK.test(uiaOf(el))) return false;
    return true;
  }

  function nearTheEnd(video) {
    if (!video || !isFinite(video.duration) || video.duration <= 0) return false;
    return video.currentTime / video.duration >= 0.75;
  }

  function findSkipTarget(rule, root) {
    for (const selector of rule.selectors) {
      for (const el of root.querySelectorAll(selector)) {
        if (clickable(el)) return el;
      }
    }

    // Only reached when Netflix has renamed or dropped the attribute
    // altogether. English-only by construction, which is why it is last.
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      if (uiaOf(el)) continue;
      const label = (el.textContent || "").trim();
      if (!label || label.length > 40) continue;
      if (rule.text.test(label) && clickable(el)) return el;
    }

    return null;
  }

  function runAutoSkip() {
    const root = playerRoot();
    if (!root) return;

    const video = currentVideo();

    for (const rule of SKIP_RULES) {
      if (!settings[rule.setting]) continue;
      if (firedKinds.has(rule.kind)) continue;
      if (rule.requireEndOfEpisode && !nearTheEnd(video)) continue;

      const target = findSkipTarget(rule, root);
      if (!target || clickedNodes.has(target)) continue;

      firedKinds.add(rule.kind);
      clickedNodes.add(target);
      target.click();
    }
  }

  // --- feature 40: playback speed ---------------------------------------------
  const SPEED_MIN = 0.25;
  const SPEED_MAX = 4;
  const SPEED_STEP = 0.25;

  // What the user asked for, as opposed to what the element currently reports.
  // Separate because Netflix resets the element and we need to know whether a
  // reset was ours or theirs.
  let desiredRate = 1;

  // How many times we will put the rate back after Netflix has taken it away,
  // before conceding. Refilled by a keypress and by a new episode.
  //
  // This is the anti-loop rule, and it is deliberately a budget rather than a
  // condition. Netflix may reset playbackRate when it swaps sources, and there
  // is no way from here to tell "swapped the source, restore it" apart from
  // "the site is actively refusing this rate". A budget makes the second case
  // terminate: we lose the setting, the user presses ] again if they still
  // want it, and nothing spins. Losing a preference is a smaller failure than
  // two pieces of code fighting over a property forty times a second.
  const REAPPLY_BUDGET = 3;
  let reapplyLeft = REAPPLY_BUDGET;

  function formatRate(rate) {
    return `${Number(rate.toFixed(2))}x`;
  }

  function applyRate(video, rate) {
    if (!video) return;
    try {
      // defaultPlaybackRate as well as playbackRate: it is the value the
      // element falls back to when it loads new media, so setting both is what
      // gives the rate any chance of surviving a source swap without us
      // having to chase it.
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
    } catch (e) {
      // A rate the element refuses (outside its supported range) throws rather
      // than clamping. Nothing to recover — the toast will simply be a lie for
      // one second, which is better than a broken player.
    }
  }

  function setRate(next) {
    const video = currentVideo();
    if (!video) return;

    const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, next));
    desiredRate = Math.round(clamped / SPEED_STEP) * SPEED_STEP;
    reapplyLeft = REAPPLY_BUDGET;
    applyRate(video, desiredRate);
    toast(formatRate(desiredRate));
  }

  // Capture on the document, not a listener bound to the element. Media events
  // do not bubble, but a capturing listener on an ancestor still sees them on
  // the way down — which means this survives Netflix swapping the <video> out
  // without any re-binding, and there is no element to leak.
  document.addEventListener("ratechange", (event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    if (!episodeKey() || desiredRate === 1) return;

    const video = event.target;
    if (Math.abs(video.playbackRate - desiredRate) < 0.001) return;

    // Somebody else moved it. That is either Netflix reloading the source or
    // Netflix's own speed menu, and we cannot tell which.
    if (reapplyLeft <= 0) {
      // Conceded. Adopt whatever the player settled on so the next keypress
      // steps from a real number rather than from a rate that is not playing.
      desiredRate = video.playbackRate;
      return;
    }

    reapplyLeft -= 1;
    applyRate(video, desiredRate);
  }, { capture: true });

  // A fresh source starts at 1x. Re-applying here rather than waiting for the
  // ratechange above means the first second of an episode plays at the right
  // speed instead of jumping.
  document.addEventListener("loadedmetadata", (event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    if (!episodeKey() || desiredRate === 1) return;
    applyRate(event.target, desiredRate);
  }, { capture: true });

  // --- feature 41: the rest of the shortcuts -----------------------------------
  // SEEKING IS NOT BOUND, AND THIS IS THE RECORD OF WHY.
  //
  // `j` and `l` used to jump thirty seconds with `video.currentTime += n`. On an
  // ordinary <video> that is correct. Netflix is not an ordinary video: it is
  // Widevine-protected and fed through Media Source Extensions, so Netflix's
  // player — not the browser — owns the buffer and decides what data exists at
  // what timestamp. Writing currentTime moves the element somewhere its player
  // never agreed to and has no data for, and the pipeline fails.
  //
  // Measured live, not guessed: a clean twenty-second control period with the
  // stream untouched (healthy, advanced exactly 20.0s), then one seek. The
  // video element was gone inside 700ms and the page became Netflix error
  // M7375. Reproduced twice in three attempts. Not recoverable without a reload.
  //
  // The obvious repair was to hand the seek to Netflix instead, by dispatching
  // its own arrow keys — it seeks ten seconds per press. That was tried and
  // measured too: playback survived, and Netflix moved by 0.0s. It ignores
  // untrusted keyboard events. Safe, and completely inert.
  //
  // That leaves no route. Clicking the scrubber would mean computing a pixel
  // position on a control bar Netflix unmounts when it hides, which is a worse
  // bargain than not having the feature. So the keys are gone rather than dead:
  // this file already refused to bind previous-episode on the grounds that a
  // silently dead key is worse than none, and the same rule decides this.
  //
  // If it is ever revisited, the thing to find is a seek Netflix's own player
  // performs. Do not reintroduce a currentTime write; it breaks playback.

  const NEXT_EPISODE = [
    '[data-uia*="next-episode-seamless" i]',
    '[data-uia="control-next"]',
    '[data-uia*="next-episode" i]'
  ];

  function clickNextEpisode() {
    const root = playerRoot();
    if (!root) return;

    for (const selector of NEXT_EPISODE) {
      for (const el of root.querySelectorAll(selector)) {
        if (el instanceof HTMLElement && el.getClientRects().length) {
          el.click();
          toast("Next episode");
          return;
        }
      }
    }

    // Netflix unmounts the control bar when it hides it, so on a still player
    // there is nothing to find. A synthetic mousemove is what a real user does
    // by accident on the way to the button; one retry, then give up rather
    // than sit in a timer.
    root.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    setTimeout(() => {
      for (const selector of NEXT_EPISODE) {
        const el = root.querySelector(selector);
        if (el instanceof HTMLElement && el.getClientRects().length) {
          el.click();
          toast("Next episode");
          return;
        }
      }
    }, 200);
  }

  // Held on the root element rather than on the player subtree, because
  // Netflix replaces that subtree and would take the class with it. Kept
  // across episodes on purpose — Netflix's own subtitle choice persists, and a
  // toggle that quietly re-enabled itself every episode would be a worse
  // surprise than one that stays put. Cleared on leaving the player.
  let subtitlesHidden = false;

  function toggleSubtitles() {
    subtitlesHidden = !subtitlesHidden;
    document.documentElement.classList.toggle("nrx-player-subs-off", subtitlesHidden);
    toast(subtitlesHidden ? "Subtitles hidden" : "Subtitles shown");
  }

  // One handler for every chord. Capture, for the reason content.js and
  // genres.js both give: Netflix binds keys on the document and stops
  // propagation on the ones it claims, so a bubbling listener is only ever
  // told about keys Netflix did not want.
  addEventListener("keydown", (event) => {
    // Modified chords belong to the browser and to the rest of the extension
    // (Shift+B, Shift+G, Shift+P, Shift+E). Everything here is unmodified, so
    // nothing here can collide with any of them.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    // Typing is typing. Netflix's search box is the obvious one, but this also
    // covers the genre picker's input and anything an options panel mounts.
    const target = event.target;
    if (target instanceof Element) {
      if (target.isContentEditable) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    }

    if (!episodeKey()) return;

    const key = event.key;

    if (key === "[" || key === "]" || key === "\\") {
      if (!settings.playerSpeedEnabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "[") setRate(desiredRate - SPEED_STEP);
      else if (key === "]") setRate(desiredRate + SPEED_STEP);
      else setRate(1);
      return;
    }

    // The kill switch, and it has to be checked here rather than inside each
    // case: turning these off has to mean the event is left completely alone —
    // no preventDefault, no stopPropagation, nothing swallowed — so that
    // Netflix sees exactly what it would see with this extension uninstalled.
    // Scoped to j/l/n/c on purpose. The speed keys above have already returned
    // by this point and answer to playerSpeedEnabled instead, because these are
    // unmodified single letters in Netflix's own chord space while [, ] and \
    // are not, and someone may well want one control without the other.
    if (!settings.playerShortcuts) return;

    switch (key.toLowerCase()) {
      case "n":
        event.preventDefault();
        event.stopPropagation();
        clickNextEpisode();
        return;
      case "c":
        event.preventDefault();
        event.stopPropagation();
        toggleSubtitles();
        return;
      default:
    }
  }, { capture: true });

  // --- route changes ----------------------------------------------------------
  let lastEpisode = null;

  function onEpisodeChange(key) {
    lastEpisode = key;

    // A new episode is a new set of things to skip. Both layers are rebuilt
    // rather than emptied so nothing can survive in the WeakSet by holding a
    // reference to a node Netflix kept.
    firedKinds = new Set();
    clickedNodes = new WeakSet();
    reapplyLeft = REAPPLY_BUDGET;

    if (!key) {
      // Left the player. The subtitle override is a player-only affordance and
      // has no meaning on a browse page, so it does not follow the user there.
      subtitlesHidden = false;
      document.documentElement.classList.remove("nrx-player-subs-off");
      desiredRate = 1;
      return;
    }

    // Default off, and off means off: carrying 2x into the next episode
    // without being asked is a surprise rather than a feature. The user still
    // has the key if they want it again.
    if (!settings.playerSpeedPersist) desiredRate = 1;
  }

  function tick() {
    const key = episodeKey();
    if (key !== lastEpisode) onEpisodeChange(key);
    if (!key) return;
    runAutoSkip();
  }

  // A MutationObserver rather than an interval, because the skip button is
  // mounted and unmounted by React and a mutation is exactly the event that
  // means "something appeared". Debounced the way content.js and sort.js
  // debounce theirs — Netflix rebuilds in bursts, and a burst should cost one
  // pass. The debounce is short because the button is only on screen for a few
  // seconds; the early-out in tick() is what keeps that cheap on browse pages.
  //
  // data-uia is in the attribute filter as well as the child list, because
  // Netflix has previously revealed a control by changing its hook rather than
  // by mounting it.
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(tick, 120);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-uia"]
  });

  // A Back out of the player changes the URL and touches nothing else, which
  // would leave the observer with nothing to report and the speed override
  // still armed.
  addEventListener("popstate", tick);

  tick();
})();
