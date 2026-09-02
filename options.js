// Chrome extensions disallow inline <script>, so the page's behaviour lives
// here in its own file.

const status = document.getElementById("status");

function say(message, kind = "ok") {
  status.textContent = message;
  status.dataset.kind = kind;
  clearTimeout(say.timer);
  say.timer = setTimeout(() => { status.textContent = ""; }, 2600);
}

// Every call into the worker is a place the UI can be left staring at nothing:
// the service worker can be asleep, torn down mid-request, or missing the
// handler entirely. Failing to null here lets each caller show its own state
// instead of throwing into the void.
async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    return null;
  }
}

// --- ratings dataset ------------------------------------------------------
const refreshButton = document.getElementById("refresh");

// The worker imports three files, not one, and two of them are what make the
// the filters and finished/running work at all. Reporting only
// ratings meant a failed or unfinished basics import looked like nothing was
// wrong, while every feature that depends on it silently did nothing.
const DATASETS = [
  { key: "ratings", label: "Ratings",  unit: "titles", note: "powers the badges" },
  { key: "basics",  label: "Metadata", unit: "titles", note: "type, year, runtime, genres" },
];

function ago(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function describeDataset(info, progress) {
  if (progress && progress.phase === "failed") {
    return { state: "failed", note: "failed — try refresh" };
  }
  if (progress && progress.phase && progress.phase !== "done" && !info?.ready) {
    if (progress.phase === "downloading") return { state: "busy", note: "downloading…" };
    const rows = Number(progress.rows) || 0;
    return { state: "busy", note: rows ? `${rows.toLocaleString()} rows…` : "importing…" };
  }
  if (!info || !info.ready) return { state: "missing", note: "not imported" };
  const count = Number(info.count) || 0;
  return {
    state: info.stale ? "stale" : "ready",
    note: `${count.toLocaleString()} · ${ago(info.builtAt)}${info.stale ? " · refresh due" : ""}`
  };
}

async function paintStatus() {
  const stored = await chrome.storage.local.get("datasetProgress");
  const progress = stored.datasetProgress || {};
  let info;
  try {
    info = await chrome.runtime.sendMessage({ type: "status" });
  } catch {
    info = null;
  }

  const byName = info?.datasets || {};
  const host = document.getElementById("dsets");
  let busy = false;
  // Collected on the way past, so the card can say how the import went while
  // it is closed — see setDataState().
  const states = [];

  const rows = DATASETS.map(({ key, label, unit }) => {
    // Fall back to the flat legacy fields for ratings, so an older worker still
    // reports something rather than reading as "not imported".
    const meta = byName[key] || (key === "ratings" ? info : null);
    const state = describeDataset(meta, progress[key]);
    if (state.state === "busy") busy = true;
    states.push(state.state);
    const detail = state.state === "ready" || state.state === "stale"
      ? state.note.replace("·", `${unit} ·`)
      : state.note;
    return `<div class="dset" data-state="${state.state}">
      <span class="dot" aria-hidden="true"></span>
      <span class="dset-name">${label}</span>
      <span class="dset-note">${detail}</span>
    </div>`;
  });

  host.innerHTML = rows.join("");
  refreshButton.disabled = busy;
  setDataState(states);
}
paintStatus();
// The import runs in the worker, so poll while this page is open to keep the
// count moving rather than leaving it looking frozen.
setInterval(paintStatus, 1500);

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  say("Importing — this takes a minute.");
  const result = await chrome.runtime.sendMessage({ type: "import" });
  if (result?.ok) say(`Imported ${result.rows.toLocaleString()} ratings.`);
  else say("Import failed — check your connection.", "error");
  paintStatus();
});

// Matches are cached permanently, so this is the escape hatch for when a title
// resolved to the wrong film.
document.getElementById("clearTitles").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearTitleCache" });
  say("Cleared cached title matches.");
});

// --- the band control -----------------------------------------------------
// The previous version asked for two numbers and showed three sample scores
// beside them, which meant reading "5.0" next to "below 6.0" and reconciling
// them. The setting is really "where do you cut a 0-10 line into three", so
// the control is now that line, and dragging a boundary is the interaction.

const SCALE_MIN = 0;
const SCALE_MAX = 10;
const STEP = 0.1;
const MIN_BAND = 0.1; // keeps a band from collapsing to nothing

const scale = document.getElementById("scale");
const handleMid = document.getElementById("handleMid");
const handleHigh = document.getElementById("handleHigh");
const bandLow = document.getElementById("bandLow");
const bandMid = document.getElementById("bandMid");
const bandHigh = document.getElementById("bandHigh");

let tierMid = RAG_DEFAULTS.tierMid;
let tierHigh = RAG_DEFAULTS.tierHigh;

// The raw stored tierHigh, kept apart from the two above because "never set"
// and "set to the shipped default" are the same number but not the same fact:
// the random-pick floor inherits this boundary when it has none of its own, and
// inherits it by exactly the rule pick.js uses — see inheritedPickMin().
// undefined until storage has been read, and again undefined only if the user
// has never moved a handle.
let storedTierHigh;

const pct = (value) => ((value - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;
const round = (value) => Math.round(value / STEP) * STEP;
const fmt = (value) => value.toFixed(1);

function paintScale() {
  bandLow.style.left = "0%";
  bandLow.style.width = `${pct(tierMid)}%`;
  bandMid.style.left = `${pct(tierMid)}%`;
  bandMid.style.width = `${pct(tierHigh) - pct(tierMid)}%`;
  bandHigh.style.left = `${pct(tierHigh)}%`;
  bandHigh.style.right = "0";

  handleMid.style.left = `${pct(tierMid)}%`;
  handleHigh.style.left = `${pct(tierHigh)}%`;
  handleMid.dataset.value = fmt(tierMid);
  handleHigh.dataset.value = fmt(tierHigh);
  handleMid.setAttribute("aria-valuenow", fmt(tierMid));
  handleHigh.setAttribute("aria-valuenow", fmt(tierHigh));

  document.getElementById("lblLow").textContent = `under ${fmt(tierMid)}`;
  // At the minimum band width the range collapses to a single score, and
  // "8.5–8.5" reads like a mistake.
  const midTop = tierHigh - STEP;
  document.getElementById("lblMid").textContent =
    midTop - tierMid < STEP / 2 ? fmt(tierMid) : `${fmt(tierMid)}–${fmt(midTop)}`;
  document.getElementById("lblHigh").textContent = `${fmt(tierHigh)}+`;

  // Candidate scores are coloured with these same bands, so they follow the
  // handles rather than keeping whatever colour they were rendered with.
  retierCandidates();
  // The closed card carries these two numbers as its value.
  paintCardValues();
  // A random-pick floor that has never been set is this boundary, not a copy of
  // it taken at load, so moving the handle moves that card's number too.
  syncPickMinFromTier();
}

// Persisting on every pointermove would write to storage dozens of times a
// second. Coalescing into one write per frame keeps the live Netflix update
// feeling immediate without hammering storage.
let savePending = false;
function save() {
  // Recorded before the write rather than after it: the value is decided now,
  // and anything reading it back — the pick card's inherited floor — must not
  // wait a frame to agree with the handle the user is still dragging.
  storedTierHigh = tierHigh;
  if (savePending) return;
  savePending = true;
  requestAnimationFrame(async () => {
    savePending = false;
    await chrome.storage.local.set({ tierHigh, tierMid });
  });
}

function valueFromClientX(clientX) {
  const rect = scale.getBoundingClientRect();
  const ratio = (clientX - rect.left) / rect.width;
  return round(SCALE_MIN + ratio * (SCALE_MAX - SCALE_MIN));
}

// save() before paintScale() in both: the paint reads storedTierHigh through
// the pick card, and save() is where that becomes the new boundary.
function setMid(value) {
  tierMid = Math.min(Math.max(value, SCALE_MIN), tierHigh - MIN_BAND);
  save();
  paintScale();
}

function setHigh(value) {
  tierHigh = Math.max(Math.min(value, SCALE_MAX), tierMid + MIN_BAND);
  save();
  paintScale();
}

function makeDraggable(handle, setter) {
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);

    const move = (e) => setter(valueFromClientX(e.clientX));
    const up = (e) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });

  // Dragging is fine with a mouse but useless with a keyboard, and a slider
  // that can't be nudged precisely is annoying even with one.
  handle.addEventListener("keydown", (event) => {
    const current = handle === handleMid ? tierMid : tierHigh;
    const big = event.shiftKey ? 1 : STEP;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      setter(round(current - big));
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      setter(round(current + big));
    } else if (event.key === "Home") {
      setter(SCALE_MIN);
    } else if (event.key === "End") {
      setter(SCALE_MAX);
    } else {
      return;
    }
    event.preventDefault();
  });
}

makeDraggable(handleMid, setMid);
makeDraggable(handleHigh, setHigh);

// Clicking the track moves whichever boundary is nearer — the obvious meaning
// of clicking a spot on a band control.
scale.addEventListener("pointerdown", (event) => {
  if (event.target !== scale && !event.target.classList.contains("track")
      && !event.target.classList.contains("band")) return;
  const value = valueFromClientX(event.clientX);
  if (Math.abs(value - tierMid) <= Math.abs(value - tierHigh)) setMid(value);
  else setHigh(value);
});

async function loadThresholds() {
  const saved = await chrome.storage.local.get(["tierHigh", "tierMid"]);
  storedTierHigh = saved.tierHigh;
  tierHigh = typeof saved.tierHigh === "number" ? saved.tierHigh : RAG_DEFAULTS.tierHigh;
  tierMid = typeof saved.tierMid === "number" ? saved.tierMid : RAG_DEFAULTS.tierMid;
  paintScale();
}
loadThresholds();

document.getElementById("resetTiers").addEventListener("click", async () => {
  tierHigh = RAG_DEFAULTS.tierHigh;
  tierMid = RAG_DEFAULTS.tierMid;
  // Written below, so the stored boundary is the default rather than absent.
  storedTierHigh = tierHigh;
  paintScale();
  await chrome.storage.local.set({ tierHigh, tierMid });
  say("Back to defaults.");
});

// --- the dim filter -------------------------------------------------------
// Badges inform; this decides. Off by default, because an extension that
// starts by hiding half of someone's homepage has overstepped.

const filterEnabled = document.getElementById("filterEnabled");
const filterMin = document.getElementById("filterMin");
const filterMinWrap = document.getElementById("filterMinWrap");
const filterMinLabel = document.getElementById("filterMinLabel");

function paintFilter() {
  filterMinLabel.textContent = parseFloat(filterMin.value).toFixed(1);
  // The threshold is meaningless while the filter is off, so it reads as
  // inactive rather than sitting there looking adjustable. Disabled rather
  // than merely dimmed: the old pointer-events:none stopped the mouse but
  // still let a keyboard tab into a control that looked switched off.
  filterMinWrap.dataset.off = filterEnabled.checked ? "no" : "yes";
  filterMin.disabled = !filterEnabled.checked;
  // This filter is one of the five the summary at the top speaks for, so every
  // repaint of it is a repaint of that. Declared below; hoisted, and nothing
  // here runs before the script has finished parsing.
  paintSummary();
}

filterEnabled.addEventListener("change", async () => {
  paintFilter();
  await chrome.storage.local.set({ filterEnabled: filterEnabled.checked });
  say(filterEnabled.checked ? "Dimming on." : "Dimming off.");
});

// Same one-write-per-frame coalescing as the band control: dragging a range
// input fires continuously, and every write is a live repaint on Netflix.
let filterSavePending = false;
filterMin.addEventListener("input", () => {
  paintFilter();
  if (filterSavePending) return;
  filterSavePending = true;
  requestAnimationFrame(async () => {
    filterSavePending = false;
    await chrome.storage.local.set({ filterMin: parseFloat(filterMin.value) });
  });
});

async function loadFilter() {
  const saved = await chrome.storage.local.get(["filterEnabled", "filterMin"]);
  filterEnabled.checked = typeof saved.filterEnabled === "boolean"
    ? saved.filterEnabled : FILTER_DEFAULTS.filterEnabled;
  filterMin.value = typeof saved.filterMin === "number"
    ? saved.filterMin : FILTER_DEFAULTS.filterMin;
  paintFilter();
}
loadFilter();

// --- narrowing filters ----------------------------------------------------
// Runtime, kind and genre all answer the same question the dim filter does —
// what recedes — so they share a card. They also share its restraint: every
// one of them is off out of the box, and a title the dataset knows nothing
// about is never judged by them.
//
// Their defaults live here rather than in defaults.js because that file is
// shared with the content script and isn't this page's to extend; the "off"
// value of each is the value the content script sees when the key is absent.
const NARROW_DEFAULTS = {
  filterRuntimeMax: null,
  filterKinds: "all",
  filterGenres: []
};

// 60 is below any feature worth calling long, and 240 is past all but a
// handful of films — so the top of the scale is worth more as the off switch
// than as a threshold nothing would ever cross. That saves a second toggle in
// a card that already has three controls.
const RUNTIME_MIN = 60;
const RUNTIME_OFF = 240;
const RUNTIME_STEP = 5;

const KINDS = ["all", "movies", "series"];

// IMDb's vocabulary is longer than this, but the rest of it (Film-Noir,
// Talk-Show, Adult…) never appears on a Netflix homepage, and every unusable
// row costs a real one its place in a 340px list.
const GENRES = [
  "Action", "Adventure", "Animation", "Biography", "Comedy", "Crime",
  "Documentary", "Drama", "Family", "Fantasy", "History", "Horror",
  "Music", "Musical", "Mystery", "Romance", "Sci-Fi", "Sport",
  "Thriller", "War", "Western"
];

const filterRuntime = document.getElementById("filterRuntime");
const runtimeLabel = document.getElementById("runtimeLabel");
const kindRadios = [...document.querySelectorAll('input[name="filterKinds"]')];
const genreToggle = document.getElementById("genreToggle");
const genreValue = document.getElementById("genreValue");
const genreClear = document.getElementById("genreClear");
const genrePanel = document.getElementById("genrePanel");

const chosenGenres = new Set();

// Always read back in the vocabulary's own order, so the stored array, the
// chips and the summary can never disagree about how a selection reads.
const genreList = () => GENRES.filter((genre) => chosenGenres.has(genre));

// null rather than 240 is what the content script is promised for "off", and
// it is also the only honest answer: nothing is capped.
function runtimeValue() {
  const minutes = parseInt(filterRuntime.value, 10);
  return minutes >= RUNTIME_OFF ? null : minutes;
}

function currentKind() {
  const chosen = kindRadios.find((radio) => radio.checked);
  return chosen ? chosen.value : NARROW_DEFAULTS.filterKinds;
}

// Minutes are what the data stores; hours are what people think in.
function formatRuntime(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function genreSummaryText(list) {
  if (!list.length) return "Any";
  if (list.length <= 2) return list.join(", ");
  return `${list[0]}, ${list[1]} +${list.length - 2}`;
}

function paintRuntime() {
  const minutes = runtimeValue();
  runtimeLabel.textContent = minutes === null ? "Any" : formatRuntime(minutes);
  runtimeLabel.dataset.on = minutes === null ? "no" : "yes";
  // "240" is a number the scale doesn't mean at its top end, and a raw minute
  // count is the wrong unit to hear read out either way.
  filterRuntime.setAttribute("aria-valuetext",
    minutes === null ? "Any length" : `${formatRuntime(minutes)} or shorter`);
  paintSummary();
}

function paintGenres() {
  const chosen = genreList();
  for (const chip of genrePanel.querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(chosenGenres.has(chip.dataset.genre)));
  }
  genreValue.textContent = genreSummaryText(chosen);
  genreValue.dataset.on = chosen.length ? "yes" : "no";
  // The visible text abbreviates past two; the accessible name shouldn't, and
  // neither should a hover on the collapsed row. It keeps the visible word
  // "Genres" in front, so voice control can still say what it can see.
  genreToggle.setAttribute("aria-label",
    `Genres: ${chosen.length ? chosen.join(", ") : "any"}`);
  genreToggle.title = chosen.length > 2 ? chosen.join(", ") : "";
  // Clearing has to be reachable from the closed row, or it costs two actions.
  genreClear.hidden = chosen.length === 0;
  paintSummary();
}

// Same one-write-per-frame coalescing as the two controls above: dragging fires
// continuously and every write repaints the open Netflix tab.
let runtimeSavePending = false;
filterRuntime.addEventListener("input", () => {
  paintRuntime();
  if (runtimeSavePending) return;
  runtimeSavePending = true;
  requestAnimationFrame(async () => {
    runtimeSavePending = false;
    await chrome.storage.local.set({ filterRuntimeMax: runtimeValue() });
  });
});

for (const radio of kindRadios) {
  radio.addEventListener("change", async () => {
    // Only the radio that gained the selection should write. Stated rather
    // than assumed, because loadNarrow() and Clear all both set .checked
    // directly and a listener that trusted the event alone would be fragile.
    if (!radio.checked) return;
    paintSummary();
    await chrome.storage.local.set({ filterKinds: radio.value });
    say(radio.value === "all" ? "Showing everything."
      : radio.value === "movies" ? "Films only." : "Series only.");
  });
}

function buildGenreChips() {
  genrePanel.replaceChildren(...GENRES.map((genre) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.genre = genre;
    chip.textContent = genre;
    chip.setAttribute("aria-pressed", "false");
    return chip;
  }));
}
buildGenreChips();

genreToggle.addEventListener("click", () => {
  const open = genreToggle.getAttribute("aria-expanded") === "true";
  genreToggle.setAttribute("aria-expanded", String(!open));
  genrePanel.hidden = open;
});

genrePanel.addEventListener("click", async (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  if (chosenGenres.has(chip.dataset.genre)) chosenGenres.delete(chip.dataset.genre);
  else chosenGenres.add(chip.dataset.genre);
  paintGenres();
  // A chip is one discrete decision, so it writes immediately — there is no
  // stream of them to coalesce the way a dragged slider produces.
  await chrome.storage.local.set({ filterGenres: genreList() });
});

genreClear.addEventListener("click", async () => {
  chosenGenres.clear();
  paintGenres();
  await chrome.storage.local.set({ filterGenres: [] });
  say("Genres cleared.");
  // The button it was just on has vanished, so park focus on the row it came
  // from rather than dropping it back to the top of the page.
  genreToggle.focus();
});

async function loadNarrow() {
  const saved = await chrome.storage.local.get([
    "filterRuntimeMax", "filterKinds", "filterGenres"
  ]);

  // Anything unreadable is treated as off. A stored value at or above the top
  // of the scale can only mean off too, since the UI writes null there.
  const minutes = Number(saved.filterRuntimeMax);
  filterRuntime.value = String(
    Number.isFinite(minutes) && saved.filterRuntimeMax !== null
      ? Math.min(Math.max(Math.round(minutes / RUNTIME_STEP) * RUNTIME_STEP, RUNTIME_MIN), RUNTIME_OFF)
      : RUNTIME_OFF
  );

  const kind = KINDS.includes(saved.filterKinds) ? saved.filterKinds : NARROW_DEFAULTS.filterKinds;
  const radio = kindRadios.find((one) => one.value === kind);
  if (radio) radio.checked = true;

  chosenGenres.clear();
  // Filtered against the vocabulary, so a genre dropped from the list later
  // can't sit in storage filtering titles with no chip to switch it off.
  if (Array.isArray(saved.filterGenres)) {
    for (const genre of saved.filterGenres) {
      if (GENRES.includes(genre)) chosenGenres.add(genre);
    }
  }

  paintRuntime();
  paintGenres();

  // Everything above quietly repaired a value this page can't display — a
  // runtime off the scale, an unknown kind, a genre no longer offered. Left
  // there, storage would keep filtering by something the page has no control
  // for and the summary would describe a state nobody is in, so the repaired
  // version is written back. In the ordinary case nothing here differs and
  // nothing is written.
  const repairs = {};
  if (saved.filterRuntimeMax !== undefined && runtimeValue() !== saved.filterRuntimeMax) {
    repairs.filterRuntimeMax = runtimeValue();
  }
  if (saved.filterKinds !== undefined && saved.filterKinds !== kind) {
    repairs.filterKinds = kind;
  }
  const kept = genreList();
  const storedGenres = Array.isArray(saved.filterGenres) ? saved.filterGenres : null;
  const genresDiffer = !storedGenres
    || storedGenres.length !== kept.length
    || kept.some((genre, index) => storedGenres[index] !== genre);
  if (saved.filterGenres !== undefined && genresDiffer) repairs.filterGenres = kept;
  if (Object.keys(repairs).length) await chrome.storage.local.set(repairs);
}
loadNarrow();

// --- what is hiding things right now --------------------------------------
// Five filters spread over two cards is more state than anyone will reconstruct
// by reading five controls, so the top of the page says it in one line. Empty
// is the resting state and is drawn as one — dashed, unfilled, nothing to act
// on — so "no filters" is recognisable without being read.

const summary = document.getElementById("summary");
const summaryNone = document.getElementById("summaryNone");
const summaryPills = document.getElementById("summaryPills");
const clearFilters = document.getElementById("clearFilters");

// Each pill says what is being kept or dimmed, not which control did it —
// "Films only" is the fact; which card it came from is the reader's problem
// only once they want to change it.
function activeFilters() {
  const active = [];
  if (filterEnabled.checked) {
    active.push({ text: `Under ${parseFloat(filterMin.value).toFixed(1)} dimmed` });
  }

  const minutes = runtimeValue();
  if (minutes !== null) active.push({ text: `Films over ${formatRuntime(minutes)}` });

  const kind = currentKind();
  if (kind === "movies") active.push({ text: "Films only" });
  if (kind === "series") active.push({ text: "Series only" });

  const genres = genreList();
  if (genres.length) {
    // Past two names the pill would outgrow the bar, so it counts instead and
    // keeps the names on hover. The genre row itself always spells them out.
    active.push({
      text: genres.length > 2 ? `${genres.length} genres only` : `${genres.join(", ")} only`,
      title: genres.length > 2 ? genres.join(", ") : ""
    });
  }

  return active;
}

function paintSummary() {
  const active = activeFilters();
  summary.dataset.active = active.length ? "yes" : "no";
  summaryNone.hidden = active.length > 0;
  summaryPills.hidden = active.length === 0;
  clearFilters.hidden = active.length === 0;

  summaryPills.replaceChildren(...active.map((entry) => {
    const pill = document.createElement("li");
    pill.className = "pill";
    pill.textContent = entry.text;
    if (entry.title) pill.title = entry.title;
    return pill;
  }));

  // Every filter that moves here also moves the value on its own closed card.
  paintCardValues();
}

clearFilters.addEventListener("click", async () => {
  filterEnabled.checked = false;
  filterRuntime.value = String(RUNTIME_OFF);
  const all = kindRadios.find((radio) => radio.value === "all");
  if (all) all.checked = true;
  chosenGenres.clear();

  paintFilter();
  paintRuntime();
  paintGenres();

  // One write, so the open Netflix tab repaints once rather than four times.
  // filterMin is deliberately left alone: it is the number this person chose,
  // and it does nothing while the dimming is off — resetting it would only
  // punish them for switching the filter back on later.
  await chrome.storage.local.set({
    filterEnabled: false,
    filterRuntimeMax: null,
    filterKinds: "all",
    filterGenres: []
  });
  say("Filters cleared.");
  // The button that was just pressed is gone with the filters it cleared, so
  // focus moves to the line that now explains why rather than to the page top.
  summary.focus();
});

// --- fixing a wrong match -------------------------------------------------
// The worker resolves a Netflix label to an IMDb id from the name alone, and
// on a small share of titles it lands somewhere plausible but wrong: a sequel
// on season one, or a namesake nobody has heard of. Until now the only remedy
// was clearing every cached match and hoping for a different guess. This is
// the aimed version: search the name, look at the votes, pin the right entry.
//
// Depends on the band control above for tier colours, so it comes after it.

const matchForm = document.getElementById("matchForm");
const matchTitle = document.getElementById("matchTitle");
const matchSearch = document.getElementById("matchSearch");
const matchRetry = document.getElementById("matchRetry");
const matchReset = document.getElementById("matchReset");
const matchStatus = document.getElementById("matchStatus");
const matchList = document.getElementById("matchList");

// The same threshold content.js uses to dash a badge's border. On an obscure
// film a low count is honest; on a title someone went looking for, it is the
// tell that this row is the wrong entry.
const THIN_VOTES = 1000;

// A slow search must never paint over a newer one, or over a list the user has
// already abandoned by editing the box.
let searchToken = 0;
// The title the visible list belongs to. Pinning writes against this rather
// than against whatever the box happens to say when a row is clicked.
let searchedTitle = "";
const shownCandidates = new Map();

function setMatchStatus(text, kind = "info") {
  matchStatus.dataset.kind = kind;
  // Revealed before it is filled: a live region that gains its text while
  // still display:none is unreliably announced.
  matchStatus.hidden = !text;
  matchStatus.textContent = text;
}

function clearCandidates() {
  shownCandidates.clear();
  matchList.replaceChildren();
  matchList.hidden = true;
}

function tierFor(rating) {
  if (rating == null || Number.isNaN(rating)) return "none";
  if (rating >= tierHigh) return "high";
  if (rating >= tierMid) return "mid";
  return "low";
}

// Looked up rather than closed over, because paintScale() calls this and lives
// above the section that owns the list.
function retierCandidates() {
  const list = document.getElementById("matchList");
  for (const el of list.querySelectorAll(".cand-rating[data-rating]")) {
    el.dataset.tier = tierFor(parseFloat(el.dataset.rating));
  }
}

// Exact counts below a million, because "132" versus "4,231" is the whole
// point of showing votes at all; above that the precision stops meaning
// anything and the width starts to cost.
function formatVotes(votes) {
  if (votes >= 1000000) return `${(votes / 1000000).toFixed(1)}M votes`;
  if (votes === 1) return "1 vote";
  return `${votes.toLocaleString()} votes`;
}

function candidateRow(candidate) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "cand";
  row.dataset.tconst = candidate.tconst;
  row.setAttribute("aria-pressed", "false");

  const main = document.createElement("span");
  main.className = "cand-main";

  const name = document.createElement("span");
  name.className = "cand-title";
  name.textContent = candidate.label || candidate.tconst;

  const sub = document.createElement("span");
  sub.className = "cand-sub";
  sub.textContent = candidate.year ? String(candidate.year) : "year unknown";

  main.append(name, sub);

  const score = document.createElement("span");
  score.className = "cand-score";

  const rating = document.createElement("b");
  rating.className = "cand-rating";
  const votes = document.createElement("span");
  votes.className = "cand-votes";

  const value = candidate.rating == null ? NaN : parseFloat(candidate.rating);
  if (Number.isNaN(value)) {
    // On IMDb but not in the local ratings index — a real answer, and a
    // legitimate thing to pin: the badge will simply say it has no rating.
    rating.textContent = "—";
    votes.textContent = "no rating";
  } else {
    rating.textContent = value.toFixed(1);
    rating.dataset.rating = String(value);
    rating.dataset.tier = tierFor(value);
    votes.textContent = candidate.votes ? formatVotes(candidate.votes) : "no votes";
    if (candidate.votes && candidate.votes < THIN_VOTES) votes.dataset.thin = "yes";
  }

  score.append(rating, votes);
  row.append(main, score);
  return row;
}

function renderCandidates(candidates) {
  const rows = [];
  for (const candidate of candidates) {
    shownCandidates.set(candidate.tconst, candidate);
    rows.push(candidateRow(candidate));
  }
  matchList.replaceChildren(...rows);
  matchList.hidden = false;
}

function markPinned(tconst) {
  for (const row of matchList.querySelectorAll(".cand")) {
    const pinned = row.dataset.tconst === tconst;
    row.setAttribute("aria-pressed", String(pinned));

    const sub = row.querySelector(".cand-sub");
    const existing = sub.querySelector(".pin");
    if (pinned && !existing) {
      const flag = document.createElement("span");
      flag.className = "pin";
      flag.textContent = " · pinned";
      sub.append(flag);
    } else if (!pinned && existing) {
      existing.remove();
    }
  }
}

function describe(candidate) {
  if (!candidate.label) return candidate.tconst;
  return candidate.year ? `“${candidate.label}” (${candidate.year})` : `“${candidate.label}”`;
}

// Abandons whatever the section was showing, including a search still in
// flight — bumping the token is what makes its response a no-op.
function cancelSearch() {
  searchToken++;
  searchedTitle = "";
  matchSearch.disabled = false;
  matchRetry.hidden = true;
  matchList.setAttribute("aria-busy", "false");
  clearCandidates();
  setMatchStatus("");
}

async function searchCandidates() {
  const title = matchTitle.value.trim();
  if (!title) {
    setMatchStatus("Type a title first — exactly as Netflix spells it.", "error");
    matchTitle.focus();
    return;
  }

  cancelSearch();
  const token = searchToken;
  searchedTitle = title;
  matchSearch.disabled = true;
  matchList.setAttribute("aria-busy", "true");
  setMatchStatus("Searching IMDb…", "busy");

  const result = await ask({ type: "candidates", title });
  if (token !== searchToken) return; // something newer owns this section now

  matchSearch.disabled = false;
  matchList.setAttribute("aria-busy", "false");

  // A missing list is treated as the network case rather than as "no results":
  // an empty answer is a fact about the title, and this isn't one.
  if (!result || result.error || !Array.isArray(result.candidates)) {
    setMatchStatus("Couldn't reach IMDb. Check your connection.", "error");
    matchRetry.hidden = false;
    return;
  }

  if (!result.candidates.length) {
    setMatchStatus(`Nothing on IMDb matched “${title}”. Check the spelling against the card.`, "info");
    return;
  }

  renderCandidates(result.candidates);
  setMatchStatus(result.candidates.length === 1
    ? "One match. Check the votes look right before pinning."
    : `${result.candidates.length} matches — the vote count is usually the tell.`, "info");
}

matchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchCandidates();
});

matchRetry.addEventListener("click", searchCandidates);

matchTitle.addEventListener("input", () => {
  matchReset.disabled = !matchTitle.value.trim();
  // Once the box says something else, the list below it belongs to a different
  // title, and leaving it there invites pinning a candidate to the wrong one.
  if (matchTitle.value.trim() !== searchedTitle) cancelSearch();
});

matchList.addEventListener("click", async (event) => {
  const row = event.target.closest(".cand");
  if (!row || row.disabled) return;

  const candidate = shownCandidates.get(row.dataset.tconst);
  if (!candidate || !searchedTitle) return;

  const rows = [...matchList.querySelectorAll(".cand")];
  for (const other of rows) other.disabled = true;
  setMatchStatus("Pinning…", "busy");

  const result = await ask({
    type: "setMatch",
    title: searchedTitle,
    tconst: candidate.tconst,
    label: candidate.label,
    year: candidate.year
  });

  for (const other of rows) other.disabled = false;

  if (!result?.ok) {
    setMatchStatus("Couldn't save that match. Try again.", "error");
    return;
  }

  markPinned(candidate.tconst);
  matchReset.disabled = false;
  setMatchStatus(`Pinned to ${describe(candidate)}. Reload Netflix to see it.`, "ok");
});

matchReset.addEventListener("click", async () => {
  const title = matchTitle.value.trim();
  if (!title) return;

  matchReset.disabled = true;
  const result = await ask({ type: "unsetMatch", title });
  matchReset.disabled = !matchTitle.value.trim();

  if (!result?.ok) {
    setMatchStatus("Couldn't clear that match. Try again.", "error");
    return;
  }

  // Whatever was pinned is gone, so no row should still claim to be it.
  if (title === searchedTitle) markPinned(null);
  setMatchStatus(`Cleared. “${title}” will resolve again on its own.`, "ok");
});

// --- why isn't this showing? ----------------------------------------------
// Every feature here declines silently when it lacks the data to be right: a
// missing badge and an undimmed card both look like
// nothing happening. That is the correct behaviour and a terrible way to
// debug, so this asks the worker the same questions the content script asks
// and reports what came back, including the decisions it would have made.

const diagTitle = document.getElementById("diagTitle");
const diagOut = document.getElementById("diagOut");

const SEASON_SPREAD_MIN = 1.0; // mirrors content.js; see its comment for why

function diagLine(kind, label, detail) {
  const mark = kind === "ok" ? "✓" : kind === "no" ? "✕" : "·";
  const div = document.createElement("div");
  div.className = "diag-line";
  div.dataset.k = kind;
  div.innerHTML = `<span class="diag-mark">${mark}</span>
    <span><b>${label}</b>${detail ? ` — ${detail}` : ""}</span>`;
  return div;
}

async function runDiagnosis() {
  const title = diagTitle.value.trim();
  if (!title) { say("Type a title first.", "error"); diagTitle.focus(); return; }

  diagOut.hidden = false;
  diagOut.replaceChildren(diagLine("info", "Asking…", title));

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "lookup", title });
  } catch {
    diagOut.replaceChildren(diagLine("no", "The extension's worker didn't answer",
      "Reload the extension and try again."));
    return;
  }

  const lines = [];

  if (!result || result.error) {
    const why = result?.error === "importing"
      ? "the ratings dataset is still importing"
      : result?.error === "network"
        ? "IMDb's title lookup could not be reached"
        : "no answer";
    lines.push(diagLine("no", "Lookup failed", why));
    diagOut.replaceChildren(...lines);
    return;
  }

  if (!result.found) {
    lines.push(diagLine("no", "No IMDb match", "nothing on IMDb matched that name — check the spelling against the card"));
    diagOut.replaceChildren(...lines);
    return;
  }

  lines.push(diagLine("ok", "Matched", `${result.label || title}${result.year ? ` (${result.year})` : ""}${result.exact === false ? " — closest match, not exact" : ""}`));
  lines.push(result.rating
    ? diagLine("ok", "Rating", `${result.rating} from ${(result.votes || 0).toLocaleString()} votes → the badge should show ${result.rating}`)
    : diagLine("no", "No rating", "on IMDb but unrated, so the badge shows a dash"));

  // The metadata that gates run status and the filters.
  lines.push(result.titleType
    ? diagLine("ok", "Type", result.titleType)
    : diagLine("no", "No type", "the metadata file has no row for this — the kind filter and finished/running are skipped"));

  const isSeries = typeof result.titleType === "string"
    && result.titleType.toLowerCase().includes("series");

  if (isSeries) {
    lines.push(result.isEnded
      ? diagLine("ok", "Finished", `ended ${result.endYear}`)
      : diagLine("info", "Still running", "no end year recorded"));
  }

  diagOut.replaceChildren(...lines);
}

document.getElementById("diagRun").addEventListener("click", runDiagnosis);
diagTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); runDiagnosis(); }
});

// --- one long page, eleven cards ------------------------------------------
// Six cards was a page you could scroll; eleven is a page you get lost in, and
// a setting nobody can find is a setting nobody changes. Three things fix it,
// none of which move an existing control:
//
//   1. The cards are sorted into three groups — Ratings, Watching, and when
//      something looks wrong — so the answer to "which half of this is about
//      the video?" is a heading rather than a scroll.
//   2. Every card collapses, and every closed card still reads out what it is
//      set to. Shut, the page is a one-screen list of current answers; open,
//      it is exactly the card it always was.
//   3. What is open is remembered, so the popup reopens where it was left.
//
// The open set lives in localStorage rather than chrome.storage, deliberately:
// it is a fact about this browser's window, not a setting, and writing it to
// chrome.storage would wake every content script's onChanged listener each
// time somebody opened a card.
const OPEN_KEY = "nrx.openCards";

// A first run opens the one card that can be wrong before anything is set:
// with no dataset imported, nothing else on the page does anything yet.
const OPEN_DEFAULT = ["data"];

const cards = [...document.querySelectorAll(".card[data-card]")];

function readOpenCards() {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (raw === null) return new Set(OPEN_DEFAULT);
    const list = JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);
  } catch {
    // Storage can be unavailable or hold junk; neither is worth a broken page.
    return new Set(OPEN_DEFAULT);
  }
}

const openCards = readOpenCards();

function rememberOpenCards() {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...openCards]));
  } catch {
    // Not remembering is a smaller failure than not opening.
  }
}

function setCardOpen(card, open) {
  const head = card.querySelector(".card-head");
  const body = card.querySelector(".card-body");
  if (!head || !body) return;
  head.setAttribute("aria-expanded", String(open));
  // hidden, not height or opacity: a closed card's controls leave the tab
  // order entirely, which is the whole point of closing it.
  body.hidden = !open;
}

// The closed card's right-hand value. "yes" is the colour the rest of the page
// uses for a setting that is actively changing Netflix; a mode that only acts
// when a key is pressed stays neutral, because nothing is happening yet.
function setCardValue(name, text, tone = "no") {
  const node = document.getElementById(`v-${name}`);
  if (!node) return;
  node.textContent = text;
  node.dataset.on = tone;
}

for (const card of cards) {
  setCardOpen(card, openCards.has(card.dataset.card));
  const head = card.querySelector(".card-head");
  if (!head) continue;
  head.addEventListener("click", () => {
    const open = head.getAttribute("aria-expanded") !== "true";
    setCardOpen(card, open);
    if (open) openCards.add(card.dataset.card);
    else openCards.delete(card.dataset.card);
    rememberOpenCards();
  });
}

// Called from paintScale() and paintSummary(), which between them run whenever
// any of the three existing settings cards changes.
function paintCardValues() {
  const moved = tierMid !== RAG_DEFAULTS.tierMid || tierHigh !== RAG_DEFAULTS.tierHigh;
  setCardValue("colours", `${fmt(tierMid)} · ${fmt(tierHigh)}`, moved ? "yes" : "no");

  const dimming = filterEnabled.checked;
  setCardValue("dim", dimming ? `below ${parseFloat(filterMin.value).toFixed(1)}` : "Off",
    dimming ? "yes" : "no");

  // The summary bar counts the dim filter too; this card doesn't own it.
  const narrowing = activeFilters().length - (dimming ? 1 : 0);
  setCardValue("narrow", narrowing ? `${narrowing} on` : "Any", narrowing ? "yes" : "no");
}

// Whether the three files are in place is the one thing worth reopening a card
// the user closed — but only once per page load, or it could never be closed.
let dataNudged = false;

function setDataState(states) {
  const bad = states.includes("failed") || states.includes("missing");
  const busy = states.includes("busy");
  const stale = states.includes("stale");

  if (busy) setCardValue("data", "importing…", "busy");
  else if (bad) setCardValue("data", states.includes("failed") ? "failed" : "not imported", "bad");
  else if (stale) setCardValue("data", "refresh due", "busy");
  else setCardValue("data", "ready", "yes");

  if (bad && !dataNudged) {
    dataNudged = true;
    const card = document.querySelector('.card[data-card="data"]');
    if (card && !openCards.has("data")) {
      openCards.add("data");
      setCardOpen(card, true);
      rememberOpenCards();
    }
  }
}

// --- the watching group ----------------------------------------------------
// Everything below controls what the extension does around the video rather
// than around the choice. The keys and their defaults are WATCH_DEFAULTS in
// defaults.js — shared with the content scripts that read them, so nothing
// here invents a default of its own.

const SUBS_BACKDROPS = ["none", "shadow", "outline", "box"];
const EXPORT_FORMATS = ["csv", "json"];
// The randomiser's kinds are the same three words the dim filter's are, so
// they share KINDS rather than keeping a second copy that could drift.

// Bounds for every number in the group, in one place, because the same three
// facts are needed twice each: once to clamp what was loaded, and once to
// build the control that writes it.
const WATCH_RANGES = {
  pickMinRating: { min: 0,  max: 10,  step: 0.1 },
  subsFontSize:  { min: 50, max: 250, step: 5 },
  subsOpacity:   { min: 20, max: 100, step: 5 },
  subsLift:      { min: 0,  max: 40,  step: 1 }
};

// A font stack from storage is written into a style attribute, so it is capped
// rather than trusted at any length.
const FONT_MAX = 120;

const watch = Object.fromEntries(
  Object.keys(WATCH_DEFAULTS)
    .map((key) => [key, document.getElementById(key)])
    .filter(([, node]) => node)
);

// --- the random pick's floor, and where it comes from ----------------------
// Every other key in this group means one thing: whatever storage holds, or the
// shipped default. `pickMinRating` means two, and pick.js is the file that
// decides which — an unset floor there resolves to the user's *stored*
// tierHigh, not to a constant, because "worth watching" is a line drawn once in
// the colours card and asking for it twice is a small rudeness. This page
// resolves it identically or it shows a number the feature will not use.
//
// pick.js's chain, in its own order:
//   1. stored pickMinRating, if it is a finite number
//   2. stored tierHigh, if it is a finite number
//   3. FALLBACK_MIN — WATCH_DEFAULTS.pickMinRating, else RAG_DEFAULTS.tierHigh
// Step 3 is written the same way here rather than as a literal, so the two
// files still agree if defaults.js ever stops anchoring one to the other.
const PICK_FALLBACK_MIN =
  Number.isFinite(WATCH_DEFAULTS.pickMinRating)
    ? WATCH_DEFAULTS.pickMinRating
    : RAG_DEFAULTS.tierHigh;

// True while storage holds no usable floor of its own: the number in the card
// is then the green boundary's, and follows it.
let pickMinInherited = false;

// pick.js's normalise() for this key, verbatim in effect: only a finite number
// counts as set. A stored "7.5" string is malformed, and malformed inherits
// rather than being coerced — otherwise this page would show 7.5 as a choice
// the user made while pick.js quietly used their boundary instead.
function pickMinIsSet(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Step 2 then step 3.
function inheritedPickMin() {
  return pickMinIsSet(storedTierHigh) ? storedTierHigh : PICK_FALLBACK_MIN;
}

const pickMinSourceText = document.getElementById("pickMinSourceText");
const pickMinFollow = document.getElementById("pickMinFollow");

const pickKindRadios = [...document.querySelectorAll('input[name="pickKinds"]')];
const backdropRadios = [...document.querySelectorAll('input[name="subsBackdrop"]')];
const formatRadios = [...document.querySelectorAll('input[name="exportFormat"]')];

const subsFields = document.getElementById("subsFields");
const subsStage = document.getElementById("subsStage");
const subsLines = document.getElementById("subsLines");
const hiddenWrap = document.getElementById("hiddenWrap");
const hiddenCount = document.getElementById("hiddenCount");
const hiddenClear = document.getElementById("hiddenClear");

// Not a control on this page: browse.js writes it from Netflix, and this page
// only ever reads the count and empties it.
let hiddenTitles = [];

// --- coercion --------------------------------------------------------------
// Storage is shared with five content scripts and survives every version of
// this extension anybody has ever run, so nothing read out of it is trusted:
// a number can be a string, a range can be out of date, a colour can be junk.

function boolOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function numberIn(value, { min, max, step }, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const snapped = Math.round(n / step) * step;
  const clamped = Math.min(Math.max(snapped, min), max);
  // 0.1 steps don't land on clean tenths in binary, and 7.500000000000001
  // would fail every equality check the repair pass below makes.
  return Math.round(clamped * 1000) / 1000;
}

function hexColour(value, fallback) {
  if (typeof value !== "string") return fallback;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  // <input type="color"> only ever emits the long form, so a short one came
  // from somewhere else and is worth expanding rather than discarding.
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join("")}`;
  return fallback;
}

function fontStack(value, fallback) {
  if (typeof value !== "string") return fallback;
  const text = value.trim().slice(0, FONT_MAX);
  // Neither character can appear in a legitimate font stack, and both are how
  // a style attribute gets escaped out of.
  return /[<>]/.test(text) ? fallback : text;
}

function titleList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const title = entry.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
  }
  return out;
}

function sameList(a, b) {
  return Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
}

// --- writing ---------------------------------------------------------------
// Two paths on purpose. A switch is one decision and writes at once, because
// the popup can be dismissed in the same breath as the click. A slider fires
// continuously, so its writes are coalesced into one per frame exactly as the
// band control and the dim threshold already do.

function saveNow(patch) {
  return chrome.storage.local.set(patch);
}

let watchQueue = {};
let watchPending = false;

function saveSoon(patch) {
  Object.assign(watchQueue, patch);
  if (watchPending) return;
  watchPending = true;
  requestAnimationFrame(async () => {
    watchPending = false;
    const batch = watchQueue;
    watchQueue = {};
    await chrome.storage.local.set(batch);
  });
}

function radioValue(radios, allowed, fallback) {
  const chosen = radios.find((radio) => radio.checked);
  return chosen ? oneOf(chosen.value, allowed, fallback) : fallback;
}

// --- the subtitle preview --------------------------------------------------
// Six of these seven controls are visual judgements, and none of them can be
// judged from a number: 140% means nothing, and the difference between a
// shadow and an outline is not a word. So the card carries a small screen with
// a line of dialogue on it, styled exactly as the controls describe, and it
// sticks to the top of the viewport while the controls below it are moved.

// 100% is drawn at 12px here. The stage is roughly a sixth of a laptop screen
// across, so a sixth of a real subtitle is about right.
const PREVIEW_BASE_PX = 12;

// Netflix's own subtitle face isn't installed on this page, so the "Netflix's
// own" option previews as the plain sans it most resembles.
const PREVIEW_FALLBACK = "Arial, Helvetica, sans-serif";

// Offsets are in em so every one of these scales with the size slider rather
// than turning into a hairline at 250%. Outline is four offset shadows rather
// than -webkit-text-stroke, which eats into the glyph from the inside and
// makes small text worse instead of clearer.
function backdropStyle(backdrop) {
  if (backdrop === "shadow") {
    return { shadow: "0 0.07em 0.11em rgba(0,0,0,.95), 0 0 0.06em rgba(0,0,0,.9)", box: false };
  }
  if (backdrop === "outline") {
    const o = "0.055em";
    return {
      shadow: `${o} ${o} 0 #000, -${o} ${o} 0 #000, ${o} -${o} 0 #000, -${o} -${o} 0 #000, 0 0 0.09em #000`,
      box: false
    };
  }
  if (backdrop === "box") return { shadow: "none", box: true };
  return { shadow: "none", box: false };
}

function paintSubsPreview() {
  if (!subsLines || !subsStage) return;

  const size = numberIn(watch.subsFontSize.value, WATCH_RANGES.subsFontSize, WATCH_DEFAULTS.subsFontSize);
  const lift = numberIn(watch.subsLift.value, WATCH_RANGES.subsLift, WATCH_DEFAULTS.subsLift);
  const opacity = numberIn(watch.subsOpacity.value, WATCH_RANGES.subsOpacity, WATCH_DEFAULTS.subsOpacity);

  subsLines.style.fontSize = `${(PREVIEW_BASE_PX * size / 100).toFixed(2)}px`;
  subsLines.style.fontFamily = fontStack(watch.subsFontFamily.value, "") || PREVIEW_FALLBACK;
  subsLines.style.color = hexColour(watch.subsColour.value, WATCH_DEFAULTS.subsColour);
  subsLines.style.opacity = String(opacity / 100);
  // The lift is a percentage of the picture's height and the stage is a small
  // picture, so the same percentage is the honest preview of it. At the top of
  // the range a 250% line can run off the top of the stage; the stage clips it,
  // which is also what a television would do.
  subsLines.style.bottom = `${lift}%`;

  const style = backdropStyle(radioValue(backdropRadios, SUBS_BACKDROPS, WATCH_DEFAULTS.subsBackdrop));
  for (const line of subsStage.querySelectorAll(".subs-line")) {
    line.style.textShadow = style.shadow;
    line.style.background = style.box ? "rgba(0, 0, 0, .75)" : "transparent";
    line.style.padding = style.box ? "0.06em 0.32em" : "0";
  }
}

// --- painting --------------------------------------------------------------

function paintWatch() {
  // Hidden titles: absent rather than empty. A control reading "0 hidden" is a
  // control that has to be understood before it can be ignored.
  hiddenWrap.hidden = hiddenTitles.length === 0;
  hiddenCount.textContent = hiddenTitles.length === 1 ? "1 title" : `${hiddenTitles.length} titles`;

  const pickMin = numberIn(watch.pickMinRating.value, WATCH_RANGES.pickMinRating, PICK_FALLBACK_MIN);
  document.getElementById("pickMinLabel").textContent = pickMin.toFixed(1);
  document.getElementById("pickMinLabel").dataset.on = pickMinInherited ? "no" : "yes";
  watch.pickMinRating.setAttribute("aria-valuetext",
    pickMin === 0 ? "Anything" : `${pickMin.toFixed(1)} or better`);

  // Where that number came from. An inherited 8.2 and a chosen 8.2 look
  // identical and behave differently the next time the green boundary moves, so
  // the card says which it is; the muted number is the same "nobody set this"
  // the narrowing card already uses.
  pickMinSourceText.textContent = pickMinInherited
    ? "Following the green boundary from Rating colours — move the slider to give the pick a floor of its own."
    : "The pick's own floor, set here. It no longer follows the green boundary.";
  pickMinFollow.hidden = pickMinInherited;

  // Everything below the master switch is disabled by the fieldset itself, so
  // the controls are genuinely unusable rather than dimmed and still tabbable.
  subsFields.disabled = !watch.subsEnabled.checked;

  // Carrying a speed into the next episode is meaningless when there is no way
  // to set a speed in the first place.
  watch.playerSpeedPersist.disabled = !watch.playerSpeedEnabled.checked;

  const size = numberIn(watch.subsFontSize.value, WATCH_RANGES.subsFontSize, WATCH_DEFAULTS.subsFontSize);
  const opacity = numberIn(watch.subsOpacity.value, WATCH_RANGES.subsOpacity, WATCH_DEFAULTS.subsOpacity);
  const lift = numberIn(watch.subsLift.value, WATCH_RANGES.subsLift, WATCH_DEFAULTS.subsLift);

  document.getElementById("subsFontSizeLabel").textContent = `${size}%`;
  document.getElementById("subsOpacityLabel").textContent = `${opacity}%`;
  const liftLabel = document.getElementById("subsLiftLabel");
  liftLabel.textContent = lift ? `${lift}%` : "None";
  liftLabel.dataset.on = lift ? "yes" : "no";
  document.getElementById("subsColourHex").textContent =
    hexColour(watch.subsColour.value, WATCH_DEFAULTS.subsColour);

  paintSubsPreview();

  // --- the closed cards' values
  const browseOn = [watch.stopAutoplayPreviews, watch.stopAutoplayBillboard, watch.hideContinueWatching]
    .filter((box) => box.checked).length;
  setCardValue("browse", `${browseOn} of 3 on`, browseOn ? "yes" : "no");

  const kind = radioValue(pickKindRadios, KINDS, WATCH_DEFAULTS.pickKinds);
  const kindWord = kind === "movies" ? " · films" : kind === "series" ? " · series" : "";
  // Neutral, not green: the randomiser changes nothing until Shift+P is pressed.
  setCardValue("pick", `${pickMin.toFixed(1)}+${kindWord}`);

  const playerBoxes = [
    watch.playerSkipIntro, watch.playerSkipRecap, watch.playerSkipCredits,
    watch.playerSpeedEnabled, watch.playerSpeedPersist, watch.playerShortcuts
  ].filter(Boolean);
  const playerOn = playerBoxes.filter((box) => box.checked).length;
  setCardValue("player", `${playerOn} of ${playerBoxes.length} on`, playerOn ? "yes" : "no");

  setCardValue("subs", watch.subsEnabled.checked ? "On" : "Off",
    watch.subsEnabled.checked ? "yes" : "no");

  // Also neutral: nothing is exported until Shift+E.
  setCardValue("export", radioValue(formatRadios, EXPORT_FORMATS, WATCH_DEFAULTS.exportFormat).toUpperCase());
}

// Called by paintScale() every time a boundary moves. An inherited floor *is*
// the green boundary rather than a copy of it, so the slider follows the handle
// while the two cards are open together; a floor of its own ignores it.
//
// Nothing is written here: storage still holds no pickMinRating, which is
// precisely what keeps the inheritance alive on both sides of the seam.
function syncPickMinFromTier() {
  if (!pickMinInherited || !watch.pickMinRating) return;
  watch.pickMinRating.value =
    String(numberIn(inheritedPickMin(), WATCH_RANGES.pickMinRating, PICK_FALLBACK_MIN));
  paintWatch();
}

// --- wiring ----------------------------------------------------------------
// Eleven switches, three radio groups and four sliders, all doing the same
// thing: coerce, paint, write one key. Written once as three helpers rather
// than eighteen near-identical listeners.

// No toast per switch. The existing cards announce a change the page can't
// show; here the switch itself moves, and the card's own value updates behind
// it, so eleven toasts would only be eleven interruptions.
const WATCH_SWITCHES = [
  "stopAutoplayPreviews", "stopAutoplayBillboard", "hideContinueWatching",
  "pickIncludeUnrated",
  "playerSkipIntro", "playerSkipRecap", "playerSkipCredits",
  "playerSpeedEnabled", "playerSpeedPersist", "playerShortcuts",
  "subsEnabled"
];

for (const key of WATCH_SWITCHES) {
  const box = watch[key];
  if (!box) continue;
  box.addEventListener("change", () => {
    paintWatch();
    saveNow({ [key]: box.checked });
  });
}

function wireRadios(radios, key, allowed) {
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      // Only the radio that gained the selection writes: loadWatch() sets
      // .checked directly, and a listener trusting the event alone is fragile.
      if (!radio.checked) return;
      paintWatch();
      saveNow({ [key]: oneOf(radio.value, allowed, WATCH_DEFAULTS[key]) });
    });
  }
}

wireRadios(pickKindRadios, "pickKinds", KINDS);
wireRadios(backdropRadios, "subsBackdrop", SUBS_BACKDROPS);
wireRadios(formatRadios, "exportFormat", EXPORT_FORMATS);

for (const key of Object.keys(WATCH_RANGES)) {
  const input = watch[key];
  if (!input) continue;
  input.addEventListener("input", () => {
    // Moving this slider is the deliberate act that ends the inheritance: from
    // here the pick has a floor of its own, and the green boundary can move
    // without taking it along. Set before the paint so the card says so in the
    // same frame the number changes.
    if (key === "pickMinRating") pickMinInherited = false;
    paintWatch();
    saveSoon({ [key]: numberIn(input.value, WATCH_RANGES[key], WATCH_DEFAULTS[key]) });
  });
}

// The way back. Without it the first nudge of the slider is a one-way door out
// of a default the page has just finished explaining, and the only way back
// would be guessing the boundary's number and hitting it exactly — which would
// not restore the inheritance anyway, only imitate it.
pickMinFollow.addEventListener("click", async () => {
  pickMinInherited = true;
  // Removed, not overwritten with the boundary's value: absent is the state
  // pick.js reads as "follow tierHigh". Writing the number would freeze it.
  await chrome.storage.local.remove("pickMinRating");
  syncPickMinFromTier();
  say("Following the green boundary again.");
  // The button has just hidden itself, so focus moves to the slider it governs
  // rather than being dropped at the top of the page.
  watch.pickMinRating.focus();
});

// The OS colour picker streams values while it is open, so this coalesces like
// a slider rather than writing on every shade passed over.
watch.subsColour.addEventListener("input", () => {
  paintWatch();
  saveSoon({ subsColour: hexColour(watch.subsColour.value, WATCH_DEFAULTS.subsColour) });
});

watch.subsFontFamily.addEventListener("change", () => {
  paintWatch();
  saveNow({ subsFontFamily: fontStack(watch.subsFontFamily.value, WATCH_DEFAULTS.subsFontFamily) });
});

hiddenClear.addEventListener("click", async () => {
  hiddenTitles = [];
  paintWatch();
  await saveNow({ hiddenTitles: [] });
  say("Everything's back.");
  // The button just pressed has gone with the list it emptied, so focus moves
  // to the card's own header rather than dropping to the top of the page.
  const head = document.querySelector('.card[data-card="browse"] .card-head');
  if (head) head.focus();
});

// browse.js writes hiddenTitles from the Netflix tab while this page may be
// sitting open beside it. It is the only key watched: everything else here is
// written by this page, and repainting a slider mid-drag would fight the hand
// holding it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.hiddenTitles) return;
  hiddenTitles = titleList(changes.hiddenTitles.newValue);
  paintWatch();
});

// --- loading ---------------------------------------------------------------

// A stored stack that isn't one of the offered typefaces is somebody's own
// choice — from an older build or another machine — and is kept as an extra
// option rather than silently replaced the first time this page opens.
function ensureFontOption(stack) {
  if (!stack) return;
  const options = [...watch.subsFontFamily.options];
  if (options.some((option) => option.value === stack)) return;
  const option = document.createElement("option");
  option.value = stack;
  option.textContent = "Custom";
  watch.subsFontFamily.append(option);
}

async function loadWatch() {
  const keys = Object.keys(WATCH_DEFAULTS);
  // tierHigh is not one of this group's keys and is not coerced with them: it
  // is read only because an unset pick floor resolves to it. Fetched here as
  // well as in loadThresholds() so the two loads cannot race — whichever lands
  // first, this page has the boundary before it resolves the floor.
  const saved = await chrome.storage.local.get([...keys, "tierHigh"]);
  storedTierHigh = saved.tierHigh;

  // One coerced value per key, whatever was in storage.
  const value = {};
  for (const key of keys) {
    const fallback = WATCH_DEFAULTS[key];
    if (key === "hiddenTitles") value[key] = titleList(saved[key]);
    else if (key === "pickMinRating") {
      // The seam this whole block exists for — pick.js applySettings():
      //   settings.pickMinRating = min === null ? tierHigh : min;
      // where min is null for anything that is not a finite number. Resolving
      // it to WATCH_DEFAULTS.pickMinRating instead would show a frozen 7.5 to
      // a user whose green boundary is at 8.2, and the feature would draw from
      // 8.2 while this page swore it drew from 7.5.
      pickMinInherited = !pickMinIsSet(saved[key]);
      value[key] = pickMinInherited
        ? numberIn(inheritedPickMin(), WATCH_RANGES[key], PICK_FALLBACK_MIN)
        : numberIn(saved[key], WATCH_RANGES[key], fallback);
    }
    else if (key === "subsColour") value[key] = hexColour(saved[key], fallback);
    else if (key === "subsFontFamily") value[key] = fontStack(saved[key], fallback);
    else if (key === "subsBackdrop") value[key] = oneOf(saved[key], SUBS_BACKDROPS, fallback);
    else if (key === "exportFormat") value[key] = oneOf(saved[key], EXPORT_FORMATS, fallback);
    else if (key === "pickKinds") value[key] = oneOf(saved[key], KINDS, fallback);
    else if (WATCH_RANGES[key]) value[key] = numberIn(saved[key], WATCH_RANGES[key], fallback);
    else value[key] = boolOr(saved[key], fallback);
  }

  hiddenTitles = value.hiddenTitles;

  for (const key of WATCH_SWITCHES) {
    if (watch[key]) watch[key].checked = value[key];
  }
  for (const key of Object.keys(WATCH_RANGES)) {
    if (watch[key]) watch[key].value = String(value[key]);
  }

  ensureFontOption(value.subsFontFamily);
  watch.subsFontFamily.value = value.subsFontFamily;
  watch.subsColour.value = value.subsColour;

  for (const [radios, key] of [
    [pickKindRadios, "pickKinds"],
    [backdropRadios, "subsBackdrop"],
    [formatRadios, "exportFormat"]
  ]) {
    const radio = radios.find((one) => one.value === value[key]);
    if (radio) radio.checked = true;
  }

  paintWatch();

  // The same repair pass loadNarrow() runs, for the same reason: everything
  // above quietly fixed a value this page cannot display — a size off the end
  // of the scale, a backdrop that was never an option, a colour that isn't
  // one. Left in storage, five content scripts would go on acting on it while
  // the page showed something else. Only keys that are actually present and
  // actually differ are written, so the ordinary case writes nothing.
  const repairs = {};
  for (const key of keys) {
    if (saved[key] === undefined) continue;
    // The one key the repair pass must leave alone. An inherited floor differs
    // from what is in storage by definition — storage holds nothing usable —
    // and writing the resolved number back would turn a value that follows the
    // green boundary into one that was chosen, without anyone choosing it.
    // Junk left under this key stays junk, which is exactly what pick.js also
    // ignores, so both files go on inheriting.
    if (key === "pickMinRating" && pickMinInherited) continue;
    if (key === "hiddenTitles") {
      if (!sameList(value[key], saved[key])) repairs[key] = value[key];
    } else if (value[key] !== saved[key]) {
      repairs[key] = value[key];
    }
  }
  if (Object.keys(repairs).length) await chrome.storage.local.set(repairs);
}
loadWatch();
