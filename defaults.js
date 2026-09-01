// Shared by the content script and the options page, so the defaults are
// defined once. Loaded before both — see manifest.json and options.html.
//
// These are the RAG thresholds: at or above HIGH is green, at or above MID is
// amber, below MID is red. Users can override both in the extension settings.
const RAG_DEFAULTS = {
  tierHigh: 7.5,
  tierMid: 6.5
};
