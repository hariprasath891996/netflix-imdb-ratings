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

function ago(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// The worker imports three files, not one, and two of them are what make the
// season strip, the filters and finished/running work at all. Reporting only
// ratings meant a failed or unfinished basics import looked like nothing was
// wrong, while every feature that depends on it silently did nothing.
const DATASETS = [
  { key: "ratings", label: "Ratings",  unit: "titles", note: "powers the badges" },
  { key: "basics",  label: "Metadata", unit: "titles", note: "type, year, runtime, genres" },
  { key: "episode", label: "Episodes", unit: "series", note: "season strips" }
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

  const rows = DATASETS.map(({ key, label, unit }) => {
    // Fall back to the flat legacy fields for ratings, so an older worker still
    // reports something rather than reading as "not imported".
    const meta = byName[key] || (key === "ratings" ? info : null);
    const state = describeDataset(meta, progress[key]);
    if (state.state === "busy") busy = true;
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
}

// Persisting on every pointermove would write to storage dozens of times a
// second. Coalescing into one write per frame keeps the live Netflix update
// feeling immediate without hammering storage.
let savePending = false;
function save() {
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

function setMid(value) {
  tierMid = Math.min(Math.max(value, SCALE_MIN), tierHigh - MIN_BAND);
  paintScale();
  save();
}

function setHigh(value) {
  tierHigh = Math.max(Math.min(value, SCALE_MAX), tierMid + MIN_BAND);
  paintScale();
  save();
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
  tierHigh = typeof saved.tierHigh === "number" ? saved.tierHigh : RAG_DEFAULTS.tierHigh;
  tierMid = typeof saved.tierMid === "number" ? saved.tierMid : RAG_DEFAULTS.tierMid;
  paintScale();
}
loadThresholds();

document.getElementById("resetTiers").addEventListener("click", async () => {
  tierHigh = RAG_DEFAULTS.tierHigh;
  tierMid = RAG_DEFAULTS.tierMid;
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
