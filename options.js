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
const dataState = document.getElementById("dataState");
const dataText = document.getElementById("dataText");
const refreshButton = document.getElementById("refresh");

function ago(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

async function paintStatus() {
  const { importProgress } = await chrome.storage.local.get("importProgress");
  const info = await chrome.runtime.sendMessage({ type: "status" });

  if (importProgress && importProgress.phase !== "done" && !info.ready) {
    dataState.dataset.ok = "busy";
    dataText.textContent = importProgress.phase === "downloading"
      ? "Downloading IMDb dataset…"
      : `Importing… ${importProgress.rows.toLocaleString()} titles`;
    refreshButton.disabled = true;
    return;
  }

  refreshButton.disabled = false;
  if (!info.ready) {
    dataState.dataset.ok = "no";
    dataText.textContent = "Not imported yet";
    return;
  }
  dataState.dataset.ok = info.stale ? "busy" : "yes";
  dataText.textContent =
    `${info.count.toLocaleString()} rated titles · updated ${ago(info.builtAt)}` +
    (info.stale ? " · refresh due" : "");
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
