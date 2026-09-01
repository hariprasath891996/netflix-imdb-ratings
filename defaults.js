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
