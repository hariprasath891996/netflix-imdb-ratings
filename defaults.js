// Shared by the content script and the options page, so the defaults are
// defined once. Loaded before both — see manifest.json and options.html.
//
// These are the RAG thresholds: at or above HIGH is green, at or above MID is
// amber, below MID is red. Users can override both in the extension settings.
const RAG_DEFAULTS = {
  tierHigh: 7.5,
  tierMid: 6.5
};

// The dim-filter has its own const rather than folding into RAG_DEFAULTS,
// because other files destructure that object's exact shape. Off by default,
// and anchored to tierHigh so a first-time user who enables it gets "hide
// anything I wouldn't call worth it" rather than an arbitrary number.
const FILTER_DEFAULTS = {
  filterEnabled: false,
  filterMin: RAG_DEFAULTS.tierHigh
};

// --- v0.4.0: the watching group ---------------------------------------------
// These control what the extension does around the video rather than around the
// choice, and they are kept in one object for a reason that outlives tidiness:
// none of them read IMDb data. IMDb publishes its datasets for non-commercial
// use only, so anything built on a rating can never be sold. Everything below
// is our own code moving Netflix's own furniture, which makes this object — and
// not the badge — the only part of the extension that could ever carry a price.
//
// Defaults lean towards "do the thing the user installed this for": autoplay
// off and intro-skipping on, because someone who enables a Netflix extension is
// not asking for more Netflix behaviour. Anything that changes what plays next,
// or that hides a title, defaults to off — those are decisions, not preferences.
const WATCH_DEFAULTS = {
  // Browse surface
  stopAutoplayPreviews: true,
  stopAutoplayBillboard: true,
  hideContinueWatching: false,
  hiddenTitles: [],

  // Pick something for me
  pickMinRating: RAG_DEFAULTS.tierHigh,
  pickKinds: "all",
  pickIncludeUnrated: false,

  // Player
  playerSkipIntro: true,
  playerSkipRecap: true,
  playerSkipCredits: false,
  playerSpeedEnabled: true,
  playerSpeedPersist: false,
  // A kill switch for the in-player keys (j, l, n, c). It exists because these
  // are unmodified single letters, which is the one chord space Netflix itself
  // uses — so unlike Shift+B/G/P/E, a future Netflix binding really could
  // collide, and the user needs a way out that is not uninstalling.
  playerShortcuts: true,

  // Subtitles
  subsEnabled: false,
  subsFontSize: 100,
  subsFontFamily: "",
  subsColour: "#ffffff",
  subsBackdrop: "shadow",
  subsOpacity: 100,
  subsLift: 0,

  // Export
  exportFormat: "csv"
};
