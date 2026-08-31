// Chrome extensions disallow inline <script>, so the page's behaviour lives
// here in its own file.

const keyInput = document.getElementById("key");
const status = document.getElementById("status");

function say(message, kind = "ok") {
  status.textContent = message;
  status.dataset.kind = kind;
  setTimeout(() => { status.textContent = ""; }, 2500);
}

// Prefill whatever is already saved.
chrome.storage.local.get("apiKey").then(({ apiKey }) => {
  if (apiKey) keyInput.value = apiKey;
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    say("Paste a key first.", "error");
    return;
  }
  await chrome.storage.local.set({ apiKey });
  say("Saved — reload your Netflix tab.");
});

// Ratings are cached for 30 days. This is the escape hatch for when a title
// got matched to the wrong film and you want it looked up fresh.
document.getElementById("clear").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "clearCache" });
  say(`Cleared ${result?.cleared ?? 0} cached ratings.`);
});
