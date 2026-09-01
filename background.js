// Background service worker.
//
// Four data sources, deliberately split by what each is good at:
//
//   Ratings  - IMDb publishes every rated title as a bulk dataset (~8 MB
//              gzipped, 1.7M rows, refreshed daily). We import it once into
//              IndexedDB, after which a rating costs zero network calls. No
//              scraper can beat a local lookup.
//
//   Basics   - the same publisher's title metadata (216 MB gzipped): type,
//              year, runtime, genres. It is 25x the size of ratings and most
//              of it is worthless to us, so it is filtered on the way in
//              against the ratings index rather than stored whole.
//
//   Episode  - the episode-to-series map (52 MB gzipped). Stored aggregated
//              per series, never per episode, because a season strip is the
//              only thing anyone asks it for.
//
//   Title ID - the one thing the datasets can't do is turn "Laapataa Ladies"
//              into tt21626284, because Netflix's label is often not IMDb's
//              title (that film is filed as "Lost Ladies"). IMDb's own
//              suggestion endpoint resolves it in ~1 KB of JSON. Cached
//              permanently per title, so each one costs a single small call
//              once, ever.
//
// The content script never talks to any of them; it just asks us for a title.

const SUGGEST_BASE = "https://v2.sg.media-imdb.com/suggestion/x/";

const DB_NAME = "nrx";
// v2 added the basics and episodes stores. The upgrade only creates what is
// missing, so an install that already spent a minute importing 1.7M ratings
// keeps them.
const DB_VERSION = 2;
const STORE_RATINGS = "ratings";   // tconst -> { r, v }
const STORE_TITLES = "titles";     // normalised title -> { tconst, label, year, qid?, pinned? }
const STORE_BASICS = "basics";     // tconst -> compact metadata, see importBasics()
const STORE_EPISODES = "episodes"; // parent tconst -> { s: [season aggregate] }
const STORE_META = "meta";         // bookkeeping, one record per dataset

const DAY_MS = 1000 * 60 * 60 * 24;

// IMDb regenerates every dataset daily, but only ratings actually move daily.
// A film's type, year, runtime and genres are immutable and the episode map
// only ever gains rows, so re-downloading 268 MB for them more than monthly
// buys nothing. Nothing is hosted and nothing is scheduled: the check rides
// along with a lookup, so a file is only ever fetched on a day the extension
// is actually used, straight from IMDb to this machine.
const DATASETS = {
  ratings: { url: "https://datasets.imdbws.com/title.ratings.tsv.gz", maxAge: DAY_MS },
  basics: { url: "https://datasets.imdbws.com/title.basics.tsv.gz", maxAge: 30 * DAY_MS },
  episode: { url: "https://datasets.imdbws.com/title.episode.tsv.gz", maxAge: 30 * DAY_MS }
};

const NULL = "\\N"; // how IMDb's TSVs spell "no value"

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
      if (!db.objectStoreNames.contains(STORE_BASICS)) db.createObjectStore(STORE_BASICS);
      if (!db.objectStoreNames.contains(STORE_EPISODES)) db.createObjectStore(STORE_EPISODES);
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

// Reads from the two optional stores go through here. A rating must never be
// withheld because the metadata half of the extension is missing, half-built
// or broken, so a failure degrades to "unknown" rather than to an error.
async function idbGetSafe(store, key) {
  try {
    return await idbGet(store, key);
  } catch (e) {
    return undefined;
  }
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

async function idbDelete(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
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

// --- the rated-titles index ------------------------------------------------
// Both large imports have to answer "is this tconst rated?" for every row they
// read - 11.5M times for basics, 8.9M for episode. One IndexedDB read each is
// not an option, so the ratings store is pulled into memory once per import.
//
// It is held as numbers, not strings: an IMDb id is "tt" plus digits, so the
// digits alone identify it and cost a fraction of the memory across 1.7M
// entries. Ids are zero-padded to seven digits and never beyond, so the
// round-trip through a number is exact.
function idNumber(tconst) {
  if (typeof tconst !== "string" || tconst.charCodeAt(0) !== 116 /* t */) return null;
  const n = Number(tconst.slice(2));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function idString(n) {
  return "tt" + String(n).padStart(7, "0");
}

// Rating and votes packed into one number rather than an object per entry, for
// the same memory reason. The rating scaled by ten is 0-100 so it fits below
// 128; the most-voted title on IMDb has ~3M votes, leaving headroom to 16.7M
// before the votes field would need widening.
const PACK_SCALE = 128;

function packRating(value) {
  const r = Math.round(parseFloat(value?.r) * 10);
  const v = Number(value?.v);
  if (!Number.isFinite(r) || r < 0 || r > 100 || !Number.isFinite(v)) return null;
  return v * PACK_SCALE + r;
}

function unpackRating(packed) {
  const r = packed % PACK_SCALE;
  return { rating: r / 10, votes: (packed - r) / PACK_SCALE };
}

// A cursor rather than getAllKeys(): the array form would materialise 1.7M
// strings at once for no benefit, whereas the cursor lets each key be reduced
// to a number and dropped. There are no awaits inside the callbacks, so the
// transaction never goes idle and cannot auto-commit mid-pass.
//
// Not cached between imports on purpose. It is ~100 MB, the two imports that
// need it are minutes apart, and a service worker holding that while idle is
// how an extension gets killed.
async function buildRatedIndex(withValues) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const index = withValues ? new Map() : new Set();
    const tx = db.transaction(STORE_RATINGS, "readonly");
    const req = tx.objectStore(STORE_RATINGS).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const n = idNumber(cursor.key);
      if (n !== null) {
        if (withValues) {
          const packed = packRating(cursor.value);
          if (packed !== null) index.set(n, packed);
        } else {
          index.add(n);
        }
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(index);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// --- streaming a dataset ---------------------------------------------------
async function fetchDataset(name) {
  // IMDb serves every dataset with Last-Modified and honours a conditional
  // request, so ask before downloading. Most of what a refresh costs is
  // re-importing unchanged rows; a 304 skips both the bytes and the import.
  const previous = (await idbGet(STORE_META, name)) || null;
  const headers = previous?.lastModified
    ? { "If-Modified-Since": previous.lastModified }
    : undefined;
  const response = await fetch(DATASETS[name].url, headers ? { headers } : undefined);
  return { response, previous };
}

// Chrome can gunzip a stream natively, so an archive is never held in memory
// in full — it is decoded and consumed line by line. onLine is deliberately
// synchronous: awaiting per row would add a microtask to each of 11.5M lines.
// onChunk is the flush point, once per decoded block.
async function forEachLine(response, onLine, onChunk) {
  const stream = response.body
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream());

  const reader = stream.getReader();
  let carry = "";
  let headerSkipped = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    carry += value;
    const lines = carry.split("\n");
    carry = lines.pop(); // last piece may be a partial line

    for (const line of lines) {
      if (!headerSkipped) { headerSkipped = true; continue; }
      if (!line) continue;
      onLine(line);
    }

    if (onChunk) await onChunk();
  }

  // A file that doesn't end in a newline would otherwise lose its last row.
  if (carry && headerSkipped) onLine(carry);
  if (onChunk) await onChunk();
}

// --- progress -------------------------------------------------------------
async function setProgress(name, state) {
  const stored = await chrome.storage.local.get("datasetProgress");
  const all = stored.datasetProgress || {};
  all[name] = state;
  const write = { datasetProgress: all };
  // The settings page has read `importProgress` since the first version and is
  // owned elsewhere, so ratings keeps writing there too.
  if (name === "ratings") write.importProgress = state;
  await chrome.storage.local.set(write);
}

async function progressFor(name) {
  const stored = await chrome.storage.local.get("datasetProgress");
  return stored.datasetProgress?.[name] || null;
}

// --- importing the ratings dataset ---------------------------------------
async function importRatings() {
  await setProgress("ratings", { phase: "downloading", rows: 0 });

  const { response, previous } = await fetchDataset("ratings");

  if (response.status === 304) {
    // Unchanged. Touch the timestamp so we don't ask again until tomorrow.
    await idbSet(STORE_META, "ratings", { ...previous, builtAt: Date.now() });
    await setProgress("ratings", { phase: "done", rows: previous.count });
    return previous.count;
  }

  if (!response.ok) throw new Error(`dataset HTTP ${response.status}`);
  const lastModified = response.headers.get("last-modified");

  let batch = [];
  let rows = 0;

  const flush = async () => {
    if (!batch.length) return;
    await idbPutMany(STORE_RATINGS, batch);
    batch = [];
    await setProgress("ratings", { phase: "importing", rows });
  };

  await forEachLine(
    response,
    (line) => {
      const tab1 = line.indexOf("\t");
      const tab2 = line.indexOf("\t", tab1 + 1);
      if (tab1 < 0 || tab2 < 0) return;

      batch.push([
        line.slice(0, tab1),
        { r: line.slice(tab1 + 1, tab2), v: +line.slice(tab2 + 1) }
      ]);
      rows++;
    },
    async () => { if (batch.length >= 40000) await flush(); }
  );
  await flush();

  await idbSet(STORE_META, "ratings", { count: rows, builtAt: Date.now(), lastModified });
  await setProgress("ratings", { phase: "done", rows });
  return rows;
}

// --- importing title.basics ------------------------------------------------
// 216 MB gzipped and 11.5M rows, of which we want 832k. Two filters do the
// cutting, both applied while streaming so the discarded 92% is never stored:
//
//   1. no rating, no point. An unrated title can never produce a badge, and
//      the ratings index answers that in memory.
//   2. no episodes. 880k of the 1.7M rated titles are individual episodes and
//      none of them needs a year, a runtime or a genre list — an episode's
//      score comes from the ratings store, joined through the episodes store.
//
// Together they are the difference between a 54 MB and a 46 MB index.
//
// Fields are stored under one-letter keys because IndexedDB writes the key
// names into every one of the 832k records.
async function importBasics() {
  const ratingsMeta = await idbGet(STORE_META, "ratings");
  // The filter is the whole design here; without the ratings index this would
  // import 11.5M rows. Better to wait for the next attempt.
  if (!ratingsMeta) throw new Error("basics needs the ratings index first");

  await setProgress("basics", { phase: "downloading", rows: 0, kept: 0 });

  const { response, previous } = await fetchDataset("basics");

  if (response.status === 304) {
    await idbSet(STORE_META, "basics", { ...previous, builtAt: Date.now() });
    await setProgress("basics", { phase: "done", rows: previous.rows ?? previous.count, kept: previous.count });
    return previous.count;
  }

  if (!response.ok) throw new Error(`basics HTTP ${response.status}`);
  const lastModified = response.headers.get("last-modified");

  await setProgress("basics", { phase: "indexing", rows: 0, kept: 0 });
  const rated = await buildRatedIndex(false);

  let batch = [];
  let rows = 0;
  let kept = 0;

  const flush = async () => {
    if (!batch.length) return;
    await idbPutMany(STORE_BASICS, batch);
    batch = [];
    await setProgress("basics", { phase: "importing", rows, kept });
  };

  try {
    await forEachLine(
      response,
      (line) => {
        rows++;
        const f = line.split("\t");
        if (f.length < 9) return;
        if (f[1] === "tvEpisode") return;

        const n = idNumber(f[0]);
        if (n === null || !rated.has(n)) return;

        const record = { t: f[1], p: f[2] };
        // originalTitle repeats primaryTitle on 93% of rows; storing it only
        // when it differs is most of what makes this store small.
        if (f[3] !== NULL && f[3] !== f[2]) record.o = f[3];
        if (f[5] !== NULL) record.s = +f[5];
        if (f[6] !== NULL) record.e = +f[6];
        if (f[7] !== NULL) record.m = +f[7];
        if (f[8] && f[8] !== NULL) record.g = f[8]; // raw comma list; split at the message boundary

        batch.push([f[0], record]);
        kept++;
      },
      async () => { if (batch.length >= 20000) await flush(); }
    );
    await flush();
  } finally {
    rated.clear();
  }

  await idbSet(STORE_META, "basics", { count: kept, rows, builtAt: Date.now(), lastModified });
  await setProgress("basics", { phase: "done", rows, kept });
  return kept;
}

// --- importing title.episode -----------------------------------------------
// The file is one row per episode, 8.9M of them, and storing it that way would
// be both huge and useless: nothing ever asks "what is episode tt123?". The
// only question is "how did each season of this series score?", so the file is
// aggregated as it streams and only the answer is kept — one record per parent
// series, a few hundred thousand of them.
//
// Aggregation has to happen in memory because the file is sorted by episode
// id, not by parent, so a series' episodes arrive scattered across the whole
// stream. The accumulator is keyed by number for the memory reasons above.
async function importEpisodes() {
  const ratingsMeta = await idbGet(STORE_META, "ratings");
  if (!ratingsMeta) throw new Error("episode needs the ratings index first");

  await setProgress("episode", { phase: "downloading", rows: 0, kept: 0 });

  const { response, previous } = await fetchDataset("episode");

  if (response.status === 304) {
    await idbSet(STORE_META, "episode", { ...previous, builtAt: Date.now() });
    await setProgress("episode", { phase: "done", rows: previous.rows ?? 0, kept: previous.count });
    return previous.count;
  }

  if (!response.ok) throw new Error(`episode HTTP ${response.status}`);
  const lastModified = response.headers.get("last-modified");

  await setProgress("episode", { phase: "indexing", rows: 0, kept: 0 });
  const rated = await buildRatedIndex(true);

  const parents = new Map(); // parent id (number) -> Map(season -> accumulator)
  let rows = 0;
  let reported = 0;
  let stored = 0;

  try {
    await forEachLine(
      response,
      (line) => {
        rows++;
        const f = line.split("\t");
        if (f.length < 4) return;

        const parent = idNumber(f[1]);
        if (parent === null) return;
        // An episode with no season number can't be placed on a season strip,
        // and a strip is the only thing this store exists to draw.
        if (f[2] === NULL) return;
        const season = +f[2];
        if (!Number.isFinite(season)) return;

        let seasons = parents.get(parent);
        if (!seasons) parents.set(parent, (seasons = new Map()));
        let acc = seasons.get(season);
        if (!acc) seasons.set(season, (acc = { c: 0, n: 0, sum: 0, lo: 0, hi: 0, v: 0 }));

        acc.c++;

        const episode = idNumber(f[0]);
        const packed = episode === null ? undefined : rated.get(episode);
        if (packed === undefined) return; // counted, but it has no score to average

        const { rating, votes } = unpackRating(packed);
        if (acc.n === 0 || rating < acc.lo) acc.lo = rating;
        if (acc.n === 0 || rating > acc.hi) acc.hi = rating;
        acc.n++;
        acc.sum += rating;
        acc.v += votes;
      },
      // Nothing is written to disk during the pass, so there is no flush to
      // hang the progress report off; every half-million rows is often enough
      // for a number that only has to look like it is moving.
      async () => {
        if (rows - reported >= 500000) {
          reported = rows;
          await setProgress("episode", { phase: "importing", rows, kept: 0 });
        }
      }
    );
  } finally {
    // The ratings index is the larger of the two structures held here and is
    // finished with; drop it before building the records.
    rated.clear();
  }

  await setProgress("episode", { phase: "writing", rows, kept: 0 });

  let batch = [];
  for (const [parent, seasons] of parents) {
    const list = [];
    for (const [season, acc] of seasons) {
      // A season nobody has rated has no average, min or max, so it would only
      // put a hole in the strip. Dropping it keeps every number in the
      // contract a real number rather than a null the caller has to handle.
      if (acc.n === 0) continue;
      list.push({
        n: season,
        c: acc.c,
        r: acc.n,
        a: Math.round((acc.sum / acc.n) * 100) / 100,
        lo: acc.lo,
        hi: acc.hi,
        v: acc.v
      });
    }
    if (!list.length) continue; // no rated episode anywhere in the series

    list.sort((a, b) => a.n - b.n);
    batch.push([idString(parent), { s: list }]);
    stored++;

    if (batch.length >= 5000) {
      await idbPutMany(STORE_EPISODES, batch);
      batch = [];
      await setProgress("episode", { phase: "writing", rows, kept: stored });
    }
  }
  if (batch.length) await idbPutMany(STORE_EPISODES, batch);
  parents.clear();

  await idbSet(STORE_META, "episode", { count: stored, rows, builtAt: Date.now(), lastModified });
  await setProgress("episode", { phase: "done", rows, kept: stored });
  return stored;
}

// --- running the imports ---------------------------------------------------
const IMPORTERS = { ratings: importRatings, basics: importBasics, episode: importEpisodes };

const running = new Map(); // dataset -> promise
// Two imports at once would only make both slower, and basics and episode read
// the ratings store while it may be being rewritten, so they run one at a time
// in the order they were asked for. onInstalled leans on this: it can queue all
// three and know the two that depend on ratings will find it there.
let queueTail = Promise.resolve();

function startImport(name) {
  const existing = running.get(name);
  if (existing) return existing;

  const promise = queueTail
    .then(() => IMPORTERS[name]())
    .catch(async (err) => {
      // A failure here must cost nothing but the metadata: no meta record is
      // written, so the dataset stays "not ready", lookups keep serving
      // ratings alone, and the next freshness check tries again.
      const previous = await progressFor(name);
      await setProgress(name, { ...(previous || {}), phase: "failed", error: String(err) });
      throw err;
    })
    .finally(() => { running.delete(name); });

  running.set(name, promise);
  // A rejected import must not break the queue for the ones behind it.
  queueTail = promise.catch(() => {});
  return promise;
}

async function metaFor(name) {
  const meta = (await idbGetSafe(STORE_META, name)) || null;
  return {
    ready: !!meta,
    count: meta?.count ?? 0,
    builtAt: meta?.builtAt ?? null,
    lastModified: meta?.lastModified ?? null,
    stale: meta ? Date.now() - meta.builtAt > DATASETS[name].maxAge : true
  };
}

// The ratings-only shape the settings page has always read.
async function datasetStatus() {
  return metaFor("ratings");
}

async function fullStatus() {
  const [ratings, basics, episode] = await Promise.all([
    metaFor("ratings"), metaFor("basics"), metaFor("episode")
  ]);
  const stored = await chrome.storage.local.get("datasetProgress");
  const progress = stored.datasetProgress || {};

  const describe = (name, meta) => ({
    ...meta,
    name,
    importing: running.has(name),
    progress: progress[name] || null
  });

  return {
    // Unchanged, and still about ratings: the settings page reads these flat.
    ...ratings,
    datasets: {
      ratings: describe("ratings", ratings),
      basics: describe("basics", basics),
      episode: describe("episode", episode)
    },
    importing: [...running.keys()]
  };
}

// Freshness is checked off the back of a lookup rather than on a schedule, so
// nothing runs on days Netflix isn't opened. A homepage fires hundreds of
// lookups, though, and this reads three meta records, so it is worth doing at
// most once every few minutes.
const FRESHNESS_CHECK_MS = 5 * 60 * 1000;
let lastFreshnessCheck = 0;

async function refreshStaleDatasets() {
  if (Date.now() - lastFreshnessCheck < FRESHNESS_CHECK_MS) return;
  lastFreshnessCheck = Date.now();
  for (const name of ["ratings", "basics", "episode"]) {
    const meta = await metaFor(name);
    if (!meta.ready || meta.stale) startImport(name).catch(() => {});
  }
}

// --- resolving a Netflix label to an IMDb id ------------------------------
function normaliseKey(title) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// IMDb's suggestion endpoint and title.basics use the same type vocabulary, so
// one table classifies both. Anything not listed (an episode, a video game) is
// deliberately null: it matches no hint rather than the wrong one.
const KIND_BY_TYPE = {
  movie: "movie",
  tvMovie: "movie",
  tvSpecial: "movie",
  video: "movie",
  short: "movie",
  tvShort: "movie",
  tvSeries: "series",
  tvMiniSeries: "series"
};

function kindOf(type) {
  return (type && KIND_BY_TYPE[type]) || null;
}

async function suggest(title) {
  const url = SUGGEST_BASE + encodeURIComponent(title.toLowerCase()) + ".json";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`suggest HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.d) ? data.d : [];
}

// A cached record is normally the end of it. The exception is a caller that
// knows something we didn't when the record was written — a page showing "5
// Seasons" is telling us this is a series, and a cached film of the same name
// is then known to be wrong. Checking that costs a local read, never a call,
// and a pin is never second-guessed.
async function conflictsWithHint(record, hint) {
  if (!hint?.kind || !record?.tconst || record.pinned) return false;
  let kind = kindOf(record.qid);
  if (!kind) {
    const basics = await idbGetSafe(STORE_BASICS, record.tconst);
    kind = kindOf(basics?.t);
  }
  return !!kind && kind !== hint.kind;
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
// answer than an unrated one with the right name. Then the caller's hint, if
// it gave one, because a page that says "5 Seasons" has settled the question
// of whether the same-named film is the right answer. Only inside the
// surviving group does a rating break the tie. Matches are still sometimes
// wrong, so the matched title and year travel back and are shown in the badge
// tooltip.
async function resolveTitle(title, hint) {
  const key = normaliseKey(title);
  // A pinned record is a cache hit like any other, so a manual correction
  // always wins here without needing a separate check - the auto-resolve path
  // below never runs for a title someone has already fixed.
  const cached = await idbGet(STORE_TITLES, key);
  if (cached && !(await conflictsWithHint(cached, hint))) return cached;

  let hits = [];
  try {
    hits = await suggest(title);
  } catch (e) {
    return cached || null; // transient: don't cache, let it retry later
  }

  // The endpoint also returns people (nm...) when it can't match a title.
  const candidates = hits.filter((h) => (h.id || "").startsWith("tt"));

  if (!candidates.length) {
    // Only reachable with a cached record when a hint sent us back for a second
    // opinion; an empty answer is no reason to throw away the first one.
    if (cached) return cached;
    const miss = { tconst: null, label: null, year: null };
    await idbSet(STORE_TITLES, key, miss);
    return miss;
  }

  const exactMatches = candidates.filter((h) => normaliseKey(h.l || "") === key);
  let pool = exactMatches.length ? exactMatches : candidates;

  if (hint?.kind) {
    const sameKind = pool.filter((h) => kindOf(h.qid) === hint.kind);
    if (sameKind.length) pool = sameKind;
  }

  let pick = pool[0];
  for (const candidate of pool) {
    if (await idbGet(STORE_RATINGS, candidate.id)) { pick = candidate; break; }
  }

  const resolved = {
    tconst: pick.id,
    label: pick.l || null,
    year: pick.y || null,
    exact: exactMatches.length > 0,
    // Kept so a later hinted lookup can tell whether this record contradicts
    // the hint without spending a call to find out.
    qid: pick.qid || null
  };
  await idbSet(STORE_TITLES, key, resolved);
  return resolved;
}

// --- manual correction -----------------------------------------------------
// resolveTitle() picks the best guess it can from a bare name; these two let a
// person override that guess for one title without touching the other 1.7M
// rows or the auto-resolved cache of every other title.

// Same candidate list resolveTitle() would have picked from, but returned
// wholesale (with local rating/votes attached) so a person can see which one
// actually has the votes a well-known title should have.
async function candidatesFor(title) {
  let hits;
  try {
    hits = await suggest(title);
  } catch (e) {
    return { error: "network" };
  }

  const candidates = hits.filter((h) => (h.id || "").startsWith("tt"));
  if (!candidates.length) return { candidates: [] };

  const withRatings = await Promise.all(
    candidates.map(async (h) => {
      const rating = await idbGet(STORE_RATINGS, h.id);
      return {
        tconst: h.id,
        label: h.l || null,
        year: h.y || null,
        rating: rating?.r ?? null,
        votes: rating?.v ?? null
      };
    })
  );
  return { candidates: withRatings };
}

async function setMatch(title, tconst, label, year) {
  const key = normaliseKey(title);
  let resolvedLabel = label ?? null;
  let resolvedYear = year ?? null;
  let qid = null;

  // The UI normally already has label/year from a prior "candidates" call and
  // passes them along; only spend a network call re-deriving them here so a
  // pin still succeeds (just without a label) if that call fails.
  if (resolvedLabel == null) {
    try {
      const hits = await suggest(title);
      const hit = hits.find((h) => h.id === tconst);
      if (hit) {
        resolvedLabel = hit.l || null;
        resolvedYear = hit.y || null;
        qid = hit.qid || null;
      }
    } catch (e) {
      // best effort only
    }
  }

  // exact: true suppresses the "(closest match)" tooltip caveat in
  // content.js - a person just confirmed this is the right title, so it is
  // no longer a guess.
  const record = { tconst, label: resolvedLabel, year: resolvedYear, exact: true, pinned: true, qid };
  await idbSet(STORE_TITLES, key, record);
  return record;
}

// --- the public lookup ----------------------------------------------------
const inFlight = new Map();

async function lookup(title, hint) {
  const status = await datasetStatus();
  if (!status.ready) {
    startImport("ratings").catch(() => {});
    return { error: "importing" };
  }

  // A day old: refresh in the background but keep serving the copy we have.
  // Yesterday's rating is a far better answer than a blank badge while 1.7M
  // rows download. The same goes for the metadata files, which are only ever
  // an enrichment on top of a rating that already works.
  refreshStaleDatasets().catch(() => {});

  const resolved = await resolveTitle(title, hint);
  if (!resolved) return { error: "network" };
  if (!resolved.tconst) return { found: false };

  const rating = await idbGet(STORE_RATINGS, resolved.tconst);

  // Metadata is read whether or not its import has formally finished: a record
  // that is present is a real row, and one that is missing just leaves these
  // fields null, which is exactly how the extension behaved before basics
  // existed. Episodes are never in this store (see importBasics), so a title
  // that resolves to one falls back to the type the suggestion reported.
  const basics = await idbGetSafe(STORE_BASICS, resolved.tconst);
  const titleType = basics?.t ?? resolved.qid ?? null;
  const kind = kindOf(titleType);
  const startYear = basics?.s ?? (typeof resolved.year === "number" ? resolved.year : null);
  const endYear = basics?.e ?? null;
  const metadata = {
    titleType,
    startYear,
    endYear,
    // A running series and one whose end year we simply don't have look
    // identical from here, so this claims "ended" only where IMDb says so.
    isEnded: kind === "series" && typeof endYear === "number",
    runtimeMinutes: basics?.m ?? null,
    genres: basics?.g ? basics.g.split(",") : []
  };

  if (!rating) {
    // On IMDb but unrated — a real state, distinct from "no such title".
    return { found: true, rating: null, label: resolved.label, year: resolved.year, ...metadata };
  }

  return {
    found: true,
    rating: rating.r,
    votes: rating.v,
    label: resolved.label,
    year: resolved.year,
    exact: resolved.exact,
    imdbID: resolved.tconst,
    ...metadata
  };
}

// One request per title *and hint*: a card and the hover modal for the same
// title can disagree about what they know, and merging them would hand one of
// them the other's answer.
function dedupe(title, hint) {
  const key = `${title}\u0000${hint?.kind || ""}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = lookup(title, hint).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// Pure read, always. The aggregate was computed at import time precisely so
// that drawing a season strip costs one IndexedDB get and no network at all.
async function seasonsFor(imdbID) {
  const record = await idbGetSafe(STORE_EPISODES, imdbID);
  if (!record?.s) {
    // Distinguishable, for a caller that wants to say "not imported yet"
    // rather than "this isn't a series": the list itself is empty either way.
    const meta = await metaFor("episode");
    return { seasons: [], ready: meta.ready };
  }

  return {
    ready: true,
    seasons: record.s.map((x) => ({
      season: x.n,
      episodes: x.c,
      rated: x.r,
      average: x.a,
      min: x.lo,
      max: x.hi,
      totalVotes: x.v
    }))
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "lookup" && message.title) {
    dedupe(message.title, message.hint).then(sendResponse);
    return true;
  }

  if (message?.type === "seasons" && message.imdbID) {
    seasonsFor(message.imdbID).then(sendResponse, () => sendResponse({ seasons: [], ready: false }));
    return true;
  }

  if (message?.type === "status") {
    fullStatus().then(sendResponse);
    return true;
  }

  if (message?.type === "import") {
    // No dataset named means ratings, because that is what the settings page
    // has always meant by it.
    const name = DATASETS[message.dataset] ? message.dataset : "ratings";
    startImport(name).then(
      (rows) => sendResponse({ ok: true, rows, dataset: name }),
      (err) => sendResponse({ ok: false, error: String(err), dataset: name })
    );
    return true;
  }

  if (message?.type === "clearTitleCache") {
    // A pin is a person's deliberate correction, not a guess, so a blanket
    // "clear the cache" must not undo it - only the auto-resolved entries are
    // guesses worth re-rolling.
    openDb().then((db) => {
      const tx = db.transaction(STORE_TITLES, "readwrite");
      const os = tx.objectStore(STORE_TITLES);
      const cursorReq = os.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        if (!cursor.value?.pinned) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => sendResponse({ cleared: true });
      tx.onerror = () => sendResponse({ cleared: false, error: String(tx.error) });
    });
    return true;
  }

  if (message?.type === "candidates" && message.title) {
    candidatesFor(message.title).then(sendResponse);
    return true;
  }

  if (message?.type === "setMatch" && message.title && message.tconst) {
    setMatch(message.title, message.tconst, message.label, message.year).then(
      (match) => sendResponse({ ok: true, match }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (message?.type === "unsetMatch" && message.title) {
    const key = normaliseKey(message.title);
    idbDelete(STORE_TITLES, key).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }
});

// Import on install. Ratings first and alone in mattering: the other two are
// queued behind it, both because they read its index and because a badge
// should appear a minute in rather than after 268 MB. Day-to-day refreshes are
// driven by lookups (see refreshStaleDatasets) rather than a scheduler, so
// nothing runs on days Netflix isn't opened.
chrome.runtime.onInstalled.addListener(() => {
  for (const name of ["ratings", "basics", "episode"]) startImport(name).catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  for (const name of ["ratings", "basics", "episode"]) {
    const meta = await metaFor(name);
    if (!meta.ready) startImport(name).catch(() => {});
  }
});
