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
//              title. IMDb's own suggestion endpoint resolves it in ~1 KB of
//              JSON. Cached permanently per title, so each one costs a single
//              small call once, ever.
//
//              Except that basics half-can: that film is filed under
//              primaryTitle "Lost Ladies" *and* originalTitle "Laapataa
//              Ladies", and we already hold both for every rated title. So the
//              two title columns are turned into a local name index at the end
//              of the basics import and consulted first — see buildTitleIndex.
//              It is an optimisation, not a replacement: "My Liberation Notes"
//              is filed as "My Liberation Diary" under both columns and only
//              the endpoint knows that.
//
// The content script never talks to any of them; it just asks us for a title.

const SUGGEST_BASE = "https://v2.sg.media-imdb.com/suggestion/x/";

const DB_NAME = "nrx";
// v2 added the basics and episodes stores, v3 the local title index. The
// upgrade only creates what is missing, so an install that already spent a
// minute importing 1.7M ratings keeps them — and because the title index is
// derived from the basics store rather than from the network, a v2 install
// gains it without re-downloading anything (see refreshStaleDatasets).
const DB_VERSION = 3;
const STORE_RATINGS = "ratings";   // tconst -> { r, v }
const STORE_TITLES = "titles";     // normalised title -> { tconst, label, year, qid?, via?, pinned?, hintYear?, yearMatch?, yearDecided? }
const STORE_BASICS = "basics";     // tconst -> compact metadata, see importBasics()
const STORE_TITLE_INDEX = "titleIndex"; // bucket number -> Map(name -> packed id), see buildTitleIndex()
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
      if (!db.objectStoreNames.contains(STORE_TITLE_INDEX)) db.createObjectStore(STORE_TITLE_INDEX);
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
// 216 MB gzipped and 11.5M rows, of which we want about 740k. Four filters do
// the cutting, all applied while streaming so the discarded 94% is never
// stored:
//
//   1. no episodes. 880k of the 1.7M rated titles are individual episodes and
//      none of them needs a year, a runtime or a genre list — an episode's
//      score comes from the ratings store, joined through the episodes store.
//   2. no video games. They are the one titleType that a streaming catalogue
//      provably cannot contain, and kindOf() already refuses to match them to
//      a hint. Keeping them would only give the title index below a way to
//      answer "The Last of Us" with a PlayStation game.
//   3. no rating, no point. An unrated title can never produce a badge, and
//      the ratings index answers that in memory.
//   4. no adult titles. Neither site this extension runs on carries them, so
//      the metadata is unreachable, and their names are short and generic
//      enough that they would crowd real answers out of the title index.
//
// The order is the cheap-and-selective one, not the readable one: the type
// test alone rejects three rows in four, so it runs before the id is even
// sliced out, and the row is only split into fields once it has survived
// everything a prefix can decide. 11.5M nine-way splits was the single most
// expensive thing this worker did.
//
// Fields are stored under one-letter keys because IndexedDB writes the key
// names into every one of the 740k records.
const BASICS_SKIP_TYPES = new Set(["tvEpisode", "videoGame"]);

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
    // Nothing changed, so the index is normally already correct; this is here
    // for the install that upgraded from v2 and has a basics store but no index.
    ensureTitleIndex().catch(() => {});
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
        const tab1 = line.indexOf("\t");
        if (tab1 < 0) return;
        const tab2 = line.indexOf("\t", tab1 + 1);
        if (tab2 < 0) return;

        if (BASICS_SKIP_TYPES.has(line.slice(tab1 + 1, tab2))) return;

        const n = idNumber(line.slice(0, tab1));
        if (n === null || !rated.has(n)) return;

        const f = line.split("\t");
        if (f.length < 9) return;
        // isAdult. Checked here rather than by prefix because it is the fifth
        // column and a fifth indexOf on every row would cost more than the
        // split it saves on the few percent that reach this line.
        if (f[4] === "1") return;

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
  // Queued rather than awaited: basics is committed and usable at this point,
  // and an index that fails to build must not mark the import that fed it
  // failed. It reads the store we just wrote, so it costs no network.
  ensureTitleIndex().catch(() => {});
  return kept;
}

// --- the local title index -------------------------------------------------
// Every unseen title used to cost a call to the suggestion endpoint. But the
// basics store already holds primaryTitle for all 740k rated non-episode
// titles, plus originalTitle wherever it differs, and a Netflix label is very
// often exactly one of those two strings under normaliseKey(). Turning those
// two columns into a name -> id map answers a large share of first-time
// lookups with no network at all.
//
// Shape is where the whole cost of this lives. One IndexedDB record per name
// would be ~570k records, and IndexedDB's per-record overhead — key, value
// header, index entry — is tens of bytes each, several times the payload for
// an entry whose payload is one number. So names are hashed into a fixed
// 4096 buckets and each bucket is stored as a single Map. That is 4096 records
// instead of 570k, the per-record overhead disappears into rounding, and a
// lookup still costs exactly one get.
//
// Serialised (structured clone, same encoder IndexedDB stores through), the
// whole index measures 13 MB: 3.2 KB per bucket on average and 4.5 KB at the
// worst, against 46 MB for the basics store it is projected from.
//
// The value is a number, not a tconst string: the digits identify the title
// (see idNumber) and the kind is multiplexed into the low two bits, so that
// resolving a hinted lookup against a collision needs no reads at all beyond
// the bucket. Names are not unique — 43% of titles share one — so a name maps
// to either one number or a short array of them.
const TITLE_INDEX_BUCKETS = 4096;

// How many same-named titles are worth keeping. Beyond a handful the extra
// candidates are obscure entries that will never out-vote the ones already
// held, and the tail of the collision distribution is long enough that an
// uncapped list would cost more than the store it lives in.
const TITLE_INDEX_MAX_CANDIDATES = 8;

const KIND_CODES = { movie: 1, series: 2 };
const KIND_BY_CODE = [null, "movie", "series", null];

function packCandidate(n, type) {
  return n * 4 + (KIND_CODES[kindOf(type)] || 0);
}

function candidateId(packed) {
  return (packed - (packed % 4)) / 4;
}

function candidateKind(packed) {
  return KIND_BY_CODE[packed % 4];
}

// FNV-1a. Nothing depends on its quality beyond an even spread across 4096
// buckets, and it has to be identical between the build and the lookup, so a
// short arithmetic one written out here beats anything cleverer.
function bucketFor(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % TITLE_INDEX_BUCKETS;
}

// A homepage fires hundreds of lookups and they cluster in no particular
// bucket, so the reads do not repeat much — but a bucket is ~10 KB and holding
// a few dozen of them is nothing next to the imports this worker already runs.
const bucketCache = new Map();
const BUCKET_CACHE_MAX = 64;

async function titleIndexBucket(key) {
  const id = bucketFor(key);
  if (bucketCache.has(id)) return bucketCache.get(id);
  // Safe read: a missing or broken index must cost a suggestion call, never a
  // failed lookup.
  const bucket = await idbGetSafe(STORE_TITLE_INDEX, id);
  const value = bucket instanceof Map ? bucket : null;
  bucketCache.set(id, value);
  if (bucketCache.size > BUCKET_CACHE_MAX) bucketCache.delete(bucketCache.keys().next().value);
  return value;
}

async function titleIndexMeta() {
  return (await idbGetSafe(STORE_META, "titleIndex")) || null;
}

// The index is a projection of the basics store, so what it has to track is
// which basics it was built from — not its own age. lastModified is the right
// stamp for that: builtAt moves on every 304 even though nothing changed.
function basicsStamp(meta) {
  return meta ? (meta.lastModified || String(meta.builtAt)) : null;
}

async function ensureTitleIndex() {
  const basics = await idbGetSafe(STORE_META, "basics");
  if (!basics) return; // nothing to project yet
  const meta = await titleIndexMeta();
  if (meta && meta.source === basicsStamp(basics)) return;
  startImport("titleIndex").catch(() => {});
}

// Built from the basics store rather than from the stream that fills it, for
// two reasons: it can then be built on an install that already imported basics
// under v2, and the peak memory of the import stays at one large structure
// rather than two — the rated index is already ~100 MB and is dropped before
// this starts.
//
// Buckets are accumulated in place and written out as they are finished, so
// the names are only ever held once. All 4096 are written even when empty,
// because a rebuild has to overwrite what the previous one left behind.
async function buildTitleIndex() {
  const basicsMeta = await idbGet(STORE_META, "basics");
  if (!basicsMeta) throw new Error("the title index needs basics first");

  await setProgress("titleIndex", { phase: "indexing", rows: 0, kept: 0 });

  // A lookup landing mid-rebuild would otherwise pin a half-written bucket in
  // the cache for the life of the worker; the clear at the end covers the
  // rebuild itself, this one covers whatever the previous one left.
  bucketCache.clear();

  const buckets = new Array(TITLE_INDEX_BUCKETS);
  let rows = 0;
  let names = 0;

  const add = (name, packed) => {
    if (!name) return;
    const id = bucketFor(name);
    let bucket = buckets[id];
    if (!bucket) buckets[id] = bucket = new Map();
    const existing = bucket.get(name);
    if (existing === undefined) { bucket.set(name, packed); names++; return; }
    if (existing === packed) return;
    if (!Array.isArray(existing)) { bucket.set(name, [existing, packed]); return; }
    if (existing.length < TITLE_INDEX_MAX_CANDIDATES && !existing.includes(packed)) existing.push(packed);
  };

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BASICS, "readonly");
    const req = tx.objectStore(STORE_BASICS).openCursor();
    // No awaits in here, for the same reason buildRatedIndex has none: the
    // transaction must not go idle and auto-commit part-way through the store.
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const n = idNumber(cursor.key);
      const value = cursor.value;
      if (n !== null && value) {
        rows++;
        const packed = packCandidate(n, value.t);
        const primary = normaliseKey(value.p || "");
        add(primary, packed);
        // originalTitle is only stored when it differs as a string, but it can
        // still normalise to the same key ("WALL·E" / "WALL-E"), and a second
        // entry for the same name and id would just cost an array.
        if (value.o) {
          const original = normaliseKey(value.o);
          if (original !== primary) add(original, packed);
        }
      }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  await setProgress("titleIndex", { phase: "writing", rows, kept: names });

  let batch = [];
  for (let id = 0; id < TITLE_INDEX_BUCKETS; id++) {
    batch.push([id, buckets[id] || new Map()]);
    buckets[id] = null; // written; let it go
    if (batch.length >= 256) {
      await idbPutMany(STORE_TITLE_INDEX, batch);
      batch = [];
    }
  }
  if (batch.length) await idbPutMany(STORE_TITLE_INDEX, batch);

  bucketCache.clear();

  await idbSet(STORE_META, "titleIndex", {
    count: names,
    rows,
    source: basicsStamp(basicsMeta),
    builtAt: Date.now()
  });
  await setProgress("titleIndex", { phase: "done", rows, kept: names });
  return names;
}

// --- running the imports ---------------------------------------------------
// titleIndex is in here so it shares the queue and the failure handling, but
// deliberately not in DATASETS: it has no url and no maxAge, it is derived
// rather than downloaded, and the "import" message gates on DATASETS so that
// the set of things a caller can ask to download is unchanged.
const IMPORTERS = {
  ratings: importRatings,
  basics: importBasics,
  titleIndex: buildTitleIndex
};

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
  // Derived from DATASETS rather than listed by hand: a removed dataset once
  // survived in five separate literal lists, and startImport threw on it at
  // every startup behind a swallowed catch.
  const names = Object.keys(DATASETS);
  const metas = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await metaFor(name)]))
  );
  const ratings = metas.ratings;
  const stored = await chrome.storage.local.get("datasetProgress");
  const progress = stored.datasetProgress || {};
  const index = await titleIndexMeta();

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
      ...Object.fromEntries(names.map((name) => [name, describe(name, metas[name])]))
    },
    // Additive, and outside `datasets` because it is not one: it has no
    // download, no freshness window and nothing to trigger by hand.
    titleIndex: {
      ready: !!index,
      names: index?.count ?? 0,
      titles: index?.rows ?? 0,
      builtAt: index?.builtAt ?? null,
      building: running.has("titleIndex"),
      progress: progress.titleIndex || null
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
  for (const name of Object.keys(DATASETS)) {
    const meta = await metaFor(name);
    if (!meta.ready || meta.stale) startImport(name).catch(() => {});
  }
  // Not staleness-driven like the others: the index is stale exactly when it
  // no longer matches the basics it was projected from. This is also the path
  // that gives a v2 install its index, off its first lookup and for no bytes.
  await ensureTitleIndex();
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

// --- the year hint ---------------------------------------------------------
// 43% of the titles on a real Netflix homepage share their name with something
// else on IMDb, and the tie-breaks we had — the caller's kind, then whichever
// candidate is rated, then votes — cannot tell three rated "Person of
// Interest"s apart. A year can.
//
// It is optional and it always will be: Netflix prints one on a title's own
// detail page ("2019 9 Seasons HD") and prints none on the browse homepage
// ("U/A 13+ 5 Seasons HD"), so most lookups arrive without one. Everything
// below is therefore built to be inert when the year is missing or junk — the
// no-year path has to stay exactly as good as it was, because it is still the
// common path.
const YEAR_MIN = 1870; // older than anything IMDb lists

function yearOf(value) {
  const year = Number(value);
  if (!Number.isInteger(year)) return null;
  // Netflix lists titles a year or two before release, so the ceiling is not
  // "now". Anything outside the window is a parse artefact, not a year.
  return year >= YEAR_MIN && year <= new Date().getFullYear() + 5 ? year : null;
}

// How far a candidate may sit behind or ahead of the year the page showed and
// still count as near, then as loose — [behind, ahead], in years.
//
// The two profiles exist because the year means different things for the two
// kinds. A film has one release year and IMDb and Netflix mostly agree on it,
// so a film three years out is probably a different film: narrow bands and a
// penalty that sinks it below a candidate whose year we don't know at all.
// A series has no single year — Netflix shows the season it is promoting while
// IMDb records the premiere, which is what "2019 9 Seasons" is: nine seasons
// means a start well before 2019. So a series is allowed to sit a decade and a
// half behind the page's year and still read as agreement, and a series that
// misses is only weakly penalised.
//
// The asymmetry within a profile is the same argument in miniature: a title
// cannot be listed years before it exists, so a candidate ahead of the page's
// year is the more suspicious direction. It is not impossible — festival runs
// and regional releases put IMDb a year ahead — hence one or two years of slack
// rather than none.
const YEAR_TOLERANCE = {
  movie: { near: [1, 1], loose: [3, 2], far: -2 },
  series: { near: [4, 1], loose: [15, 3], far: -1 }
};

// Higher is better. 0 means "no evidence either way" and is deliberately what
// an unknown year on either side scores, so a candidate we know nothing about
// still beats one that is provably twenty years off.
function yearScore(candidateYear, hintYear, kind) {
  const candidate = yearOf(candidateYear);
  if (candidate === null || hintYear === null) return 0;

  const drift = hintYear - candidate; // positive: the candidate is the older one
  if (drift === 0) return 3;

  // An unclassifiable candidate gets the lenient profile: the point of these
  // numbers is to break ties, never to talk us out of the only answer.
  const tolerance = YEAR_TOLERANCE[kind] || YEAR_TOLERANCE.series;
  const direction = drift > 0 ? 0 : 1;
  const distance = Math.abs(drift);
  if (distance <= tolerance.near[direction]) return 2;
  if (distance <= tolerance.loose[direction]) return 1;
  return tolerance.far;
}

// Written into the resolved record rather than the raw number, because what a
// later diagnostic wants to ask is "did the year agree", not "what did the
// arithmetic say".
function yearMatchOf(score) {
  if (score >= 3) return "exact";
  if (score === 2) return "near";
  if (score === 1) return "loose";
  return score < 0 ? "far" : "unknown";
}

// The ranking both resolution paths share, compared left to right: the year
// band first, then whether the candidate is rated at all, then whatever each
// path already used to break a tie (votes locally, the endpoint's own order
// over the network).
//
// The year sits above "is it rated" on purpose, and it is the same order of
// argument the exactness filter below already makes: evidence about *which
// title this is* outranks evidence about how good an answer it would make.
// Picking the rated wrong film over the unrated right one is how you get a
// confidently wrong badge, which is worse than an honest "no rating". With no
// year in play every score is 0 and this collapses to exactly the two-field
// comparison each path did before.
function betterCandidate(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  if (a.rated !== b.rated) return a.rated > b.rated;
  return a.tie > b.tie;
}

function bestCandidate(scored) {
  return scored.reduce((a, b) => (betterCandidate(b, a) ? b : a));
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
//
// A year contradicts a record the same way, with one extra guard: only a far
// miss counts. A near miss is the normal state of affairs (see YEAR_TOLERANCE)
// and re-resolving on one would throw away good records for nothing.
//
// Returns which of the two disagreed, because the two are answered differently
// further down.
async function hintConflict(record, hint) {
  if (!record?.tconst || record.pinned) return null;

  let basics; // read at most once even when both tests want it
  const readBasics = async () => {
    if (basics === undefined) basics = await idbGetSafe(STORE_BASICS, record.tconst);
    return basics;
  };

  if (hint?.kind) {
    let kind = kindOf(record.qid);
    if (!kind) kind = kindOf((await readBasics())?.t);
    if (kind && kind !== hint.kind) return "kind";
  }

  const year = yearOf(hint?.year);
  // A record already resolved under this exact year has had its second opinion
  // and this is the best answer there was; asking again would spend the same
  // suggestion call on every lookup of a title whose year simply disagrees.
  if (year === null || record.hintYear === year) return null;

  const recordYear = yearOf(record.year) ?? yearOf((await readBasics())?.s);
  if (recordYear === null) return null;

  const kind = kindOf(record.qid) || kindOf((await readBasics())?.t);
  return yearScore(recordYear, year, kind) < 0 ? "year" : null;
}

// The free half of resolution: the name index built from basics (see
// buildTitleIndex). A hit here is a title whose primaryTitle or originalTitle
// normalises to exactly what the page said, which is a stronger match than the
// endpoint's own ranking gives — so it is worth trying first, not as a
// fallback.
//
// The preference order is deliberately the same one the suggestion path uses
// below, so a title resolved locally and the same title resolved over the
// network land on the same id: the caller's hint first, then the year band,
// then a candidate that is actually rated, then votes. Exactness needs no step
// here — every candidate matched the name exactly or it would not be under this
// key.
//
// conflict is for the one caller that already has an answer and is only here
// because a hint contradicted it: settling for a candidate that disagrees the
// same way would rewrite the record with the same disagreement.
async function resolveLocally(key, hint, conflict) {
  const bucket = await titleIndexBucket(key);
  const entry = bucket ? bucket.get(key) : undefined;
  if (entry === undefined) return null;

  let pool = Array.isArray(entry) ? entry : [entry];

  if (hint?.kind) {
    const sameKind = pool.filter((packed) => candidateKind(packed) === hint.kind);
    if (sameKind.length) pool = sameKind;
    else if (conflict) return null;
  } else if (conflict === "kind") {
    return null;
  }

  const year = yearOf(hint?.year);

  // One candidate is not ranked at all. The name matched exactly and nothing
  // else claims it, so there is nothing for a year to choose between — and a
  // year that disagrees is not grounds for refusing the only answer there is.
  let pick = pool[0];
  let moved = false;
  if (pool.length > 1) {
    const scored = [];
    for (const packed of pool) {
      const tconst = idString(candidateId(packed));
      const rating = await idbGetSafe(STORE_RATINGS, tconst);
      const votes = Number(rating?.v);
      // The second read is only spent on a name that actually collides while a
      // year is in hand — the same shape of cost the votes read already is, and
      // the collision is exactly the case the year exists to settle.
      const basics = year === null ? null : await idbGetSafe(STORE_BASICS, tconst);
      scored.push({
        packed,
        score: yearScore(basics?.s, year, candidateKind(packed)),
        // Every row in basics was filtered against the ratings index on the way
        // in, so a candidate without a rating means the two stores have drifted
        // apart - rare, and handled by leaving it at the back rather than by
        // trusting it.
        rated: Number.isFinite(votes) ? 1 : 0,
        tie: Number.isFinite(votes) ? votes : -1
      });
    }
    pick = bestCandidate(scored).packed;
    // The same list with the year taken back out, so the record can say whether
    // the year moved the answer or merely agreed with the one already there.
    if (year !== null) moved = bestCandidate(scored.map((c) => ({ ...c, score: 0 }))).packed !== pick;
  }

  const tconst = idString(candidateId(pick));
  const basics = await idbGetSafe(STORE_BASICS, tconst);
  // No metadata row means the index is out of step with the store it was
  // projected from, and a record with no label is worse than a call.
  if (!basics) return null;

  const score = yearScore(basics.s, year, candidateKind(pick));
  // Sent back here by a year the cached record contradicted: a candidate whose
  // year is contradicted the same way is no answer, so let the endpoint try.
  if (conflict === "year" && score < 0) return null;

  const resolved = {
    tconst,
    label: basics.p ?? null,
    year: basics.s ?? null,
    exact: true,
    qid: basics.t ?? null,
    via: "local"
  };
  // Additive, and only when there was a year: what it was, how well the chosen
  // title matched it, and whether it changed the answer.
  if (year !== null) {
    resolved.hintYear = year;
    resolved.yearMatch = yearMatchOf(score);
    if (moved) resolved.yearDecided = true;
  }
  return resolved;
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
// of whether the same-named film is the right answer. Then its year, which is
// the only thing that can separate three same-named entries that are all rated
// and all of the right kind. Only inside the surviving group does a rating
// break the tie. Matches are still sometimes wrong, so the matched title and
// year travel back and are shown in the badge tooltip.
async function resolveTitle(title, hint) {
  const key = normaliseKey(title);
  // A pinned record is a cache hit like any other, so a manual correction
  // always wins here without needing a separate check - the auto-resolve path
  // below never runs for a title someone has already fixed.
  const cached = await idbGet(STORE_TITLES, key);
  const conflict = cached ? await hintConflict(cached, hint) : null;
  if (cached?.tconst && !conflict) return cached;

  // Reached with no record, with one a hint contradicts, or with a cached miss
  // - and a miss cached before the index existed is worth re-asking locally,
  // because the answer is now free.
  const local = await resolveLocally(key, hint, conflict);
  if (local) {
    await idbSet(STORE_TITLES, key, local);
    return local;
  }

  // A miss the endpoint already refused to answer stays refused: the local
  // index having nothing to add is no reason to spend the call again.
  if (cached && !conflict) return cached;

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
    if (cached) {
      // It is a reason to note that the year has now been asked about, though.
      // Without this the disagreement is permanent and every future lookup of
      // the title spends the same call to be told nothing again.
      if (conflict === "year") {
        const asked = { ...cached, hintYear: yearOf(hint?.year), yearMatch: "far" };
        await idbSet(STORE_TITLES, key, asked);
        return asked;
      }
      return cached;
    }
    const miss = { tconst: null, label: null, year: null, via: "suggest" };
    await idbSet(STORE_TITLES, key, miss);
    return miss;
  }

  const exactMatches = candidates.filter((h) => normaliseKey(h.l || "") === key);
  let pool = exactMatches.length ? exactMatches : candidates;

  if (hint?.kind) {
    const sameKind = pool.filter((h) => kindOf(h.qid) === hint.kind);
    if (sameKind.length) pool = sameKind;
  }

  const year = yearOf(hint?.year);

  // One survivor is taken as it stands, for the reason the local path gives:
  // there is nothing to choose between, so the year has no work to do.
  let pick = pool[0];
  let moved = false;
  if (pool.length > 1) {
    const scored = [];
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      scored.push({
        candidate,
        score: yearScore(candidate.y, year, kindOf(candidate.qid)),
        rated: (await idbGet(STORE_RATINGS, candidate.id)) ? 1 : 0,
        // The endpoint's own order has the last word here, as it always has:
        // it ranks by popularity, which is the right way to settle a name
        // several titles answer to equally well.
        tie: -i
      });
    }
    pick = bestCandidate(scored).candidate;
    if (year !== null) moved = bestCandidate(scored.map((c) => ({ ...c, score: 0 }))).candidate !== pick;
  }

  const resolved = {
    tconst: pick.id,
    label: pick.l || null,
    year: pick.y || null,
    exact: exactMatches.length > 0,
    // Kept so a later hinted lookup can tell whether this record contradicts
    // the hint without spending a call to find out.
    qid: pick.qid || null,
    // What this cost. Counting these two across the titles store is how the
    // settings page can say what share of lookups never touched the network;
    // a pinned record carries neither, because a person is not a resolver.
    via: "suggest"
  };
  if (year !== null) {
    // hintYear is also what stops the next lookup of this title asking again:
    // a record that already knows which year it was resolved under has had its
    // second opinion (see hintConflict).
    resolved.hintYear = year;
    resolved.yearMatch = yearMatchOf(yearScore(pick.y, year, kindOf(pick.qid)));
    if (moved) resolved.yearDecided = true;
  }
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
// them the other's answer. The year is part of that: a homepage card carries no
// year and a detail page carries one, and those are not the same question.
function dedupe(title, hint) {
  const key = `${title}\u0000${hint?.kind || ""}\u0000${yearOf(hint?.year) ?? ""}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = lookup(title, hint).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "lookup" && message.title) {
    dedupe(message.title, message.hint).then(sendResponse);
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
  for (const name of Object.keys(DATASETS)) startImport(name).catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  for (const name of Object.keys(DATASETS)) {
    const meta = await metaFor(name);
    if (!meta.ready) startImport(name).catch(() => {});
  }
});
