// Background service worker.
//
// The content script (which runs inside the Netflix page) cannot call OMDb
// directly without tripping over CORS, and we don't want the API key sitting
// in a context Netflix's own scripts can read. So the content script asks us,
// and we do the fetch out here.

const OMDB_URL = "https://www.omdbapi.com/";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// OMDb's free tier is 1,000 requests/day. A single Netflix browse page can show
// 100+ cards, and the same title shows up on several rows, so we dedupe hard:
// this map holds in-flight requests so N cards for one title = 1 network call.
const inFlight = new Map();

function cacheKeyFor(title) {
  return `rating:${title.toLowerCase()}`;
}

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return apiKey || null;
}

async function readCache(title) {
  const key = cacheKeyFor(title);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) return null;
  return entry.value;
}

async function writeCache(title, value) {
  await chrome.storage.local.set({
    [cacheKeyFor(title)]: { at: Date.now(), value }
  });
}

// Netflix disambiguates titles with suffixes the work itself doesn't carry:
// "The Office (U.S.)", "Hunter X Hunter (2011)", "Pushpa 2 (Reloaded Version)".
// Stripping these unconditionally would break any title that legitimately ends
// in brackets, so this is only ever used as a second attempt after a miss.
function withoutTrailingParenthetical(title) {
  return title.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

async function askOmdb(apiKey, title) {
  const url = new URL(OMDB_URL);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("t", title);
  const response = await fetch(url);
  return response.json();
}

async function fetchRating(title) {
  const apiKey = await getApiKey();
  if (!apiKey) return { error: "no-key" };

  let data;
  try {
    data = await askOmdb(apiKey, title);

    // Retry as a fallback rather than normalising up front, so a title that
    // really does end in brackets still gets its exact match tried first.
    if (data.Response === "False" && !/api key/i.test(data.Error || "")) {
      const stripped = withoutTrailingParenthetical(title);
      if (stripped && stripped !== title) {
        const retry = await askOmdb(apiKey, stripped);
        if (retry.Response !== "False") data = retry;
      }
    }
  } catch (e) {
    // Network blips are temporary — never cache them, or one flaky moment
    // poisons the title for 30 days.
    return { error: "network" };
  }

  if (data.Response === "False") {
    // A bad key also comes back as Response:False, but it means something very
    // different from "no such film" — surface it so the user can fix it.
    if (/api key/i.test(data.Error || "")) return { error: "bad-key" };
    const miss = { found: false };
    await writeCache(title, miss);
    return miss;
  }

  const value = {
    found: true,
    rating: data.imdbRating && data.imdbRating !== "N/A" ? data.imdbRating : null,
    votes: data.imdbVotes && data.imdbVotes !== "N/A" ? data.imdbVotes : null,
    year: data.Year || null,
    imdbID: data.imdbID || null
  };
  await writeCache(title, value);
  return value;
}

async function lookup(title) {
  const cached = await readCache(title);
  if (cached) return cached;

  if (inFlight.has(title)) return inFlight.get(title);

  const promise = fetchRating(title).finally(() => inFlight.delete(title));
  inFlight.set(title, promise);
  return promise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "lookup" && message.title) {
    lookup(message.title).then(sendResponse);
    return true; // keeps the channel open for the async reply
  }

  if (message?.type === "clearCache") {
    chrome.storage.local.get(null).then(async (all) => {
      const ratingKeys = Object.keys(all).filter((k) => k.startsWith("rating:"));
      await chrome.storage.local.remove(ratingKeys);
      sendResponse({ cleared: ratingKeys.length });
    });
    return true;
  }
});
