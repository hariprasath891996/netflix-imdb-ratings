// Chrome extensions disallow inline <script>, so the page's behaviour lives
// here in its own file.

const status = document.getElementById("status");

function say(message, kind = "ok") {
  status.textContent = message;
  status.dataset.kind = kind;
  setTimeout(() => { status.textContent = ""; }, 3000);
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

// --- RAG thresholds -------------------------------------------------------
// Where green becomes amber and amber becomes red is a taste call, not a fact,
// so it belongs in settings rather than baked into the code.

const highInput = document.getElementById("high");
const midInput = document.getElementById("mid");

function describe(high, mid) {
  document.getElementById("txtHigh").textContent = `${high.toFixed(1)} and above`;
  document.getElementById("txtMid").textContent =
    mid >= high ? "—" : `${mid.toFixed(1)} to ${(high - 0.1).toFixed(1)}`;
  document.getElementById("txtLow").textContent = `below ${mid.toFixed(1)}`;

  document.getElementById("egHigh").textContent = high.toFixed(1);
  document.getElementById("egMid").textContent = mid.toFixed(1);
  document.getElementById("egLow").textContent = Math.max(0, mid - 1).toFixed(1);
}

function currentInputs() {
  return { high: parseFloat(highInput.value), mid: parseFloat(midInput.value) };
}

// Live feedback while typing, so you can see what a threshold means before
// committing to it.
for (const input of [highInput, midInput]) {
  input.addEventListener("input", () => {
    const { high, mid } = currentInputs();
    if (!Number.isNaN(high) && !Number.isNaN(mid)) describe(high, mid);
  });
}

async function loadThresholds() {
  const saved = await chrome.storage.local.get(["tierHigh", "tierMid"]);
  const high = typeof saved.tierHigh === "number" ? saved.tierHigh : RAG_DEFAULTS.tierHigh;
  const mid = typeof saved.tierMid === "number" ? saved.tierMid : RAG_DEFAULTS.tierMid;
  highInput.value = high;
  midInput.value = mid;
  describe(high, mid);
}
loadThresholds();

document.getElementById("saveTiers").addEventListener("click", async () => {
  const { high, mid } = currentInputs();

  if (Number.isNaN(high) || Number.isNaN(mid)) {
    say("Both thresholds need a number.", "error");
    return;
  }
  if (high < 0 || high > 10 || mid < 0 || mid > 10) {
    say("IMDb ratings run 0–10.", "error");
    return;
  }
  // Without this, the amber band is empty and nothing is ever amber — a
  // confusing state to leave someone in silently.
  if (mid >= high) {
    say("Amber must be lower than green.", "error");
    return;
  }

  await chrome.storage.local.set({ tierHigh: high, tierMid: mid });
  say("Colours saved — your open Netflix tab updates instantly.");
});

document.getElementById("resetTiers").addEventListener("click", async () => {
  await chrome.storage.local.set({
    tierHigh: RAG_DEFAULTS.tierHigh,
    tierMid: RAG_DEFAULTS.tierMid
  });
  await loadThresholds();
  say("Back to defaults.");
});
