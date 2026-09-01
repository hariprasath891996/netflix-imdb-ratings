// Background service worker.
//
// Two data sources, deliberately split by what each is good at:
//
//   Ratings  - IMDb publishes every rated title as a bulk dataset (~8 MB
//              gzipped, 1.7M rows, refreshed daily). We import it once into
//              IndexedDB, after which a rating costs zero network calls. No
//              scraper can beat a local lookup.
//
//   Title ID - the one thing the dataset can't do is turn "Laapataa Ladies"
//              into tt21626284, because Netflix's label is often not IMDb's
//              title (that film is filed as "Lost Ladies"). IMDb's own
//              suggestion endpoint resolves it in ~1 KB of JSON. Cached
//              permanently per title, so each one costs a single small call
//              once, ever.
//
// The content script never talks to either; it just asks us for a title.

const RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const SUGGEST_BASE = "https://v2.sg.media-imdb.com/suggestion/x/";

const DB_NAME = "nrx";
const DB_VERSION = 1;
const STORE_RATINGS = "ratings"; // tconst -> { r, v }
const STORE_TITLES = "titles";   // normalised title -> { tconst, label, year }
const STORE_META = "meta";       // bookkeeping

// IMDb regenerates the dataset daily, so the local copy is refreshed on the
// first use of each day. Nothing is hosted and nothing is scheduled: the check
// rides along with a lookup, so the file is only ever fetched on a day the
// extension is actually used, straight from IMDb to this machine.
const DATASET_MAX_AGE_MS = 1000 * 60 * 60 * 24;

// --- IndexedDB ------------------------------------------------------------
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_RATINGS)) db.createObjectStore(STORE_RATINGS);
      if (!db.objectStoreNames.contains(STORE_TITLES)) db.createObjectStore(STORE_TITLES);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(store, key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Bulk insert in one transaction per chunk. Committing 1.7M rows individually
// would take minutes; batching keeps the import to a single pass.
async function idbPutMany(store, entries) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for (const [key, value] of entries) os.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- importing the ratings dataset ---------------------------------------
let importInFlight = null;

async function datasetStatus() {
  const meta = (await idbGet(STORE_META, "ratings")) || null;
  return {
    ready: !!meta,
    count: meta?.count ?? 0,
    builtAt: meta?.builtAt ?? null,
    stale: meta ? Date.now() - meta.builtAt > DATASET_MAX_AGE_MS : true
  };
}

async function setProgress(state) {
  await chrome.storage.local.set({ importProgress: state });
}

async function importRatings() {
  // The stream below is what keeps the service worker alive; a single import
  // must therefore never be started twice concurrently.
  if (importInFlight) return importInFlight;

  importInFlight = (async () => {
    await setProgress({ phase: "downloading", rows: 0 });

    const response = await fetch(RATINGS_URL);
    if (!response.ok) throw new Error(`dataset HTTP ${response.status}`);

    // Chrome can gunzip a stream natively, so the 8 MB archive is never held
    // in memory in full — it is decoded and consumed line by line.
    const stream = response.body
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new TextDecoderStream());

    const reader = stream.getReader();
    let carry = "";
    let batch = [];
    let rows = 0;
    let headerSkipped = false;

    const flush = async () => {
      if (!batch.length) return;
      await idbPutMany(STORE_RATINGS, batch);
      batch = [];
      await setProgress({ phase: "importing", rows });
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      carry += value;
      const lines = carry.split("\n");
      carry = lines.pop(); // last piece may be a partial line

      for (const line of lines) {
        if (!headerSkipped) { headerSkipped = true; continue; }
        if (!line) continue;
        const tab1 = line.indexOf("\t");
        const tab2 = line.indexOf("\t", tab1 + 1);
        if (tab1 < 0 || tab2 < 0) continue;

        batch.push([
          line.slice(0, tab1),
          { r: line.slice(tab1 + 1, tab2), v: +line.slice(tab2 + 1) }
        ]);
        rows++;
      }

      if (batch.length >= 40000) await flush();
    }
    await flush();

    await idbSet(STORE_META, "ratings", { count: rows, builtAt: Date.now() });
    await setProgress({ phase: "done", rows });
    return rows;
  })().finally(() => { importInFlight = null; });

  return importInFlight;
}

// --- resolving a Netflix label to an IMDb id ------------------------------
function normaliseKey(title) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function suggest(title) {
  const url = SUGGEST_BASE + encodeURIComponent(title.toLowerCase()) + ".json";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`suggest HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.d) ? data.d : [];
}

// Choosing among suggestions is where accuracy is won or lost.
//
// IMDb ranks upcoming releases highly, so a search for "Youth" returns the
// unreleased 2026 entry above the rated 2015 one, and an unreleased title has
// no rating to show. Because the ratings index is local, we can check whether
// a candidate is actually rated while picking — cheap here, and something a
// scraper would have to spend a request on.
//
// Exactness still comes first: a rated film with the wrong name is a worse
// answer than an unrated one with the right name. Only within an exact-name
// group does a rating break the tie. Matches are still sometimes wrong, so the
// matched title and year travel back and are shown in the badge tooltip.
async function resolveTitle(title) {
  const key = normaliseKey(title);
  const cached = await idbGet(STORE_TITLES, key);
  if (cached) return cached;

  let hits = [];
  try {
    hits = await suggest(title);
  } catch (e) {
    return null; // transient: don't cache, let it retry later
  }

  // The endpoint also returns people (nm...) when it can't match a title.
  const candidates = hits.filter((h) => (h.id || "").startsWith("tt"));

  if (!candidates.length) {
    const miss = { tconst: null, label: null, year: null };
    await idbSet(STORE_TITLES, key, miss);
    return miss;
  }

  const exactMatches = candidates.filter((h) => normaliseKey(h.l || "") === key);
  const pool = exactMatches.length ? exactMatches : candidates;

  let pick = pool[0];
  for (const candidate of pool) {
    if (await idbGet(STORE_RATINGS, candidate.id)) { pick = candidate; break; }
  }

  const resolved = {
    tconst: pick.id,
    label: pick.l || null,
    year: pick.y || null,
    exact: exactMatches.length > 0
  };
  await idbSet(STORE_TITLES, key, resolved);
  return resolved;
}

// --- the public lookup ----------------------------------------------------
const inFlight = new Map();

async function lookup(title) {
  const status = await datasetStatus();
  if (!status.ready) {
    importRatings().catch(() => {});
    return { error: "importing" };
  }

  // A day old: refresh in the background but keep serving the copy we have.
  // Yesterday's rating is a far better answer than a blank badge while 1.7M
  // rows download.
  if (status.stale && !importInFlight) {
    importRatings().catch(() => {});
  }

  const resolved = await resolveTitle(title);
  if (!resolved) return { error: "network" };
  if (!resolved.tconst) return { found: false };

  const rating = await idbGet(STORE_RATINGS, resolved.tconst);
  if (!rating) {
    // On IMDb but unrated — a real state, distinct from "no such title".
    return { found: true, rating: null, label: resolved.label, year: resolved.year };
  }

  return {
    found: true,
    rating: rating.r,
    votes: rating.v,
    label: resolved.label,
    year: resolved.year,
    exact: resolved.exact,
    imdbID: resolved.tconst
  };
}

function dedupe(title) {
  if (inFlight.has(title)) return inFlight.get(title);
  const promise = lookup(title).finally(() => inFlight.delete(title));
  inFlight.set(title, promise);
  return promise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "lookup" && message.title) {
    dedupe(message.title).then(sendResponse);
    return true;
  }

  if (message?.type === "status") {
    datasetStatus().then(sendResponse);
    return true;
  }

  if (message?.type === "import") {
    importRatings().then(
      (rows) => sendResponse({ ok: true, rows }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (message?.type === "clearTitleCache") {
    openDb().then((db) => {
      const tx = db.transaction(STORE_TITLES, "readwrite");
      tx.objectStore(STORE_TITLES).clear();
      tx.oncomplete = () => sendResponse({ cleared: true });
    });
    return true;
  }
});

// Import on install. Day-to-day refreshes are driven by lookups (see above)
// rather than a scheduler, so nothing runs on days Netflix isn't opened.
chrome.runtime.onInstalled.addListener(() => { importRatings().catch(() => {}); });
chrome.runtime.onStartup.addListener(async () => {
  const status = await datasetStatus();
  if (!status.ready) importRatings().catch(() => {});
});
