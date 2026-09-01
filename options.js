// Chrome extensions disallow inline <script>, so the page's behaviour lives
// here in its own file.

const status = document.getElementById("status");

function say(message, kind = "ok") {
  status.textContent = message;
  status.dataset.kind = kind;
  clearTimeout(say.timer);
  say.timer = setTimeout(() => { status.textContent = ""; }, 2600);
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
