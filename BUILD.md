# Building

Two browsers, one source tree, two manifests.

Every `.js`, `.css`, `.html` and icon in this repo is shared verbatim between
the Chrome and Firefox builds. The only file that differs is the manifest, and
the only reason it differs is a handful of keys Firefox spells differently —
none of the extension's actual code is branched.

**Read [Firefox status](#firefox-status) before shipping the Firefox build.**
The manifest is finished; the port is not.

## Chrome

There is no build step. Chrome reads the source tree as it stands:

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → this folder.
2. Open Netflix.

## Firefox

Firefox will only read a file named `manifest.json`, so the Firefox build has
to be assembled somewhere else rather than loaded in place:

```
python3 tools/build-firefox.py
```

That writes `build/firefox/` — the shared files plus `manifest.firefox.json`
renamed to `manifest.json`. Add `--zip` for `build/firefox.zip`, which is what
AMO wants. `build/` is generated and shouldn't be committed.

To load it:

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**.
2. Pick `build/firefox/manifest.json` (the file, not the folder — this is the
   one place Firefox's dialog differs from Chrome's).
3. **Grant the host permissions by hand.** `about:addons` → the extension →
   **Permissions** → allow `datasets.imdbws.com` and `v2.sg.media-imdb.com`.
   Firefox MV3 does not grant manifest host permissions at install the way
   Chrome does, and a temporary install never prompts for them at all. Skip
   this and the extension looks broken in a way that gives you no error: the
   dataset fetch is blocked as cross-origin, the import fails, and every card
   stays blank while the content script quietly retries every five seconds.
4. Open Netflix.

A temporary add-on is unloaded when Firefox closes. Anything permanent needs
signing through AMO — the `browser_specific_settings.gecko.id` in the manifest
is what an AMO listing is keyed to, so it must not change once one exists.

To watch the import, use **Inspect** next to the extension in
`about:debugging`. That console is the background page's, and it is where the
findings below will show themselves.

## What differs, and why

| Key | Chrome | Firefox | Why |
| --- | --- | --- | --- |
| `background` | `service_worker: "background.js"` | `scripts: ["background.js"]` | Firefox's MV3 background is an event page, not a service worker, and it does not implement the `service_worker` key. `background.js` needs no change for this — it touches no service-worker-only API (no `clients`, no `skipWaiting`, no `importScripts`) and no DOM, so it runs unmodified in either host. |
| options | `options_page` | `options_ui` + `open_in_tab: true` | Firefox never implemented the legacy `options_page` key. `open_in_tab` is a judgement call rather than a requirement: `options.html` pins its `#status` toast with `position: fixed`, and Firefox renders embedded options in a content-sized iframe, which would strand that toast at the bottom of a very long page instead of at the bottom of the viewport. In a tab — and in the action popup, which uses the same file — it lands where it was designed to. |
| `browser_specific_settings.gecko.id` | — | required | Firefox needs an explicit id to give the extension a stable identity. Without one a temporary install gets a fresh id per session, and because extension IndexedDB lives on a `moz-extension://<uuid>` origin, each reload can present as an empty database and re-run the multi-minute import. |
| `browser_specific_settings.gecko.strict_min_version` | — | `115.0` | The ESR floor, and comfortably past the two real requirements: MV3 (109) and `DecompressionStream` (113). |

Everything else — `permissions`, `host_permissions`, `content_scripts`,
`action`, `icons`, `name`, `version`, `description` — is byte-identical
between the two files by design. `host_permissions` is spelled the same but
does not *behave* the same; see step 3 above and
[Firefox status](#firefox-status).

## Keeping the two manifests from drifting

This is the part worth automating, and the reason `tools/build-firefox.py`
exists rather than a `cp` and a `mv`.

The duplicated half of `manifest.firefox.json` — the content scripts, the
permissions, the version — is copied text that nothing verifies. Add a match
pattern or a host permission to `manifest.json` and forget the other file, and
the Firefox build still loads cleanly, still runs, and is quietly missing a
feature. Nothing errors. Nobody finds out until a user does.

So the script compares the shared keys before it copies anything, and refuses
to build on a mismatch, naming the key. It also fails on a key added to
`manifest.json` that it has never been told about, because a new manifest key
is a decision — shared or Firefox-specific — and silently dropping it from one
build is the same bug in a new shape.

```
python3 tools/build-firefox.py --check
```

is that comparison on its own, copying nothing. Worth running in the same
breath as any edit to `manifest.json`.

This is not hypothetical: the check caught a drift within a minute of being
written, when `disneyplus.com` was added to `manifest.json` while
`manifest.firefox.json` was being drafted.

## Firefox status

**Do not ship this yet, and do not add Firefox to the README's install
instructions.** The manifest is correct and complete. The runtime is not
verified, and one unresolved question decides whether the build works
perfectly or does nothing at all.

### 1. `chrome.*` promises — blocking, and it is the whole port

Every call into an extension API in this codebase is awaited on the `chrome.*`
namespace:

- `content.js` — `await chrome.runtime.sendMessage(...)` in `processModal()`
  and `process()`, `await chrome.storage.local.get(...)` in `start()`
- `options.js` — 19 call sites, including the `ask()` helper every other one
  goes through
- `background.js` — `chrome.storage.local.get/set` in `setProgress()`,
  `progressFor()` and `fullStatus()`

(Referenced by name rather than line number on purpose — this file is being
edited by more than one person and the numbers were stale within the hour.)

Firefox's documented split is that `browser.*` returns promises and the
`chrome.*` alias is callback-style. If that still holds in the Firefox being
targeted, every one of those awaits resolves to `undefined` — and throws
nothing, which is what makes it dangerous. Traced through this code:

- `importRatings()` calls `setProgress()` as its first statement. `setProgress`
  does `const stored = await chrome.storage.local.get(...)` then reads
  `stored.datasetProgress`, which is a `TypeError` on `undefined`. The ratings
  import dies before it fetches a byte. `startImport`'s error handler then
  calls `setProgress` again, which throws for the same reason, so not even the
  failure record gets written — the dataset stays permanently "not ready" and
  every lookup retries into the same wall.
- `content.js` gets `undefined` back from `sendMessage`, hits `if (!result)
  return;`, and paints no badge. No error, no console output, no clue.
- `options.js` gets `null` from every `ask()`, so the settings page reports
  "not imported" forever regardless of the truth.

The extension would be completely dead and would *look* like it had simply
found nothing to do. That is the exact failure mode worth refusing to ship.

**Verify before anything else.** Load the build, open the background console
from `about:debugging` → **Inspect**, and run:

```js
chrome.storage.local.get("datasetProgress")
```

A `Promise` means this whole finding evaporates and the port is close to done.
`undefined` means it must be fixed first.

**The fix, if needed**, is Mozilla's `webextension-polyfill` — one vendored
`browser-polyfill.js` loaded ahead of everything else, in three places: the
`background.scripts` array, the `content_scripts.js` array, and a `<script>`
tag in `options.html`. The first two are manifest-only. The third is an edit to
a shared source file, so it lands in the Chrome build too, which is why it is a
decision for whoever owns this repo rather than something to slip in. A
one-line `globalThis.chrome = globalThis.browser ?? globalThis.chrome;` shim
works equally well and needs the same three insertion points.

### 2. Host permissions are opt-in — high

Chrome grants manifest `host_permissions` at install. Firefox MV3 does not; the
user grants them, and a temporary install never asks. Until they are granted,
`fetchDataset()` is a cross-origin request without permission, so it is blocked,
`importRatings` throws, and `lookup()` returns `{error: "importing"}` forever
while `content.js` retries on a five-second timer. The suggestion endpoint fails
the same way, and content-script injection on the streaming sites is subject to
the same grant.

The manual step is in the load instructions above, which is enough for a
developer. It is not enough for a user: the extension's own first-run message
says badges appear "as soon as it finishes", which on Firefox would be a lie
told indefinitely. Shipping this needs the permission state surfaced in the
settings page, and that is a code change.

### 3. Event-page termination against a multi-minute import — high

Firefox's MV3 background is an event page, terminated when idle. This
extension's imports are the least idle-looking and most terminable work an
extension can do: ratings is ~8 MB and about a minute; **basics is 216 MB
gzipped and 11.5M rows**, running for many minutes on one streamed fetch.

There is no resumption anywhere in `background.js`. `importRatings` writes its
meta record only after the final flush, so a termination at 90% loses the whole
pass, and `buildRatedIndex`'s ~100 MB in-memory index dies with the page.
`background.js` already reasons carefully about Chrome's kill rules — the
comment at `buildRatedIndex` explains that the index is deliberately not cached
between imports because "a service worker holding that while idle is how an
extension gets killed". Firefox's rules are not the same rules, and nothing
here has been tested against them.

There is also nothing to recover with. The extension declares no `alarms`
permission and uses no alarm anywhere; the only thing that restarts a failed
import is the user opening Netflix again and `refreshStaleDatasets` firing off
a lookup. If Firefox counts an in-flight fetch and open IndexedDB transactions
as activity, this is fine. If it counts only extension events, the basics
import may simply never finish on a slow connection.

**Test it directly**: load the build, trigger the basics import, and leave it
alone with the console open. This takes one sitting and settles the question.

### 4. Things that are genuinely fine

- **`DecompressionStream("gzip")` and `TextDecoderStream`** — Firefox 113 and
  105 respectively, and fetch response-body streams are supported. The comment
  in `forEachLine` says "Chrome can gunzip a stream natively"; so can Firefox.
  No change needed.
- **IndexedDB** — cursors, one transaction per chunk, and structured-clone of
  `Map` for the title-index buckets are all standard and all implemented. One
  caveat rather than a blocker: the stores total 60 MB+, and a user with
  "Delete cookies and site data when Firefox is closed" can lose the lot and
  pay the full import again. That is a worse trade here than for a normal
  extension, purely because of the size.
- **`navigator.userAgentData`** (`content.js`, the `MODIFIER_LABEL` constant) —
  absent in Firefox, but the code already optional-chains it and falls back to
  `navigator.platform`, which Firefox provides.
- **`chrome.runtime.onMessage` returning `true` for an async `sendResponse`** —
  supported. The pattern in `background.js` needs no change.

### Verdict

The manifest work is done and the code is far more portable than a
Chrome-targeted MV3 extension usually is — nothing in it is service-worker
specific, and the streaming stack it depends on is fully supported.

What stands between this and a shippable Firefox build is one shim and one
afternoon of testing. Until finding 1 is checked and findings 2 and 3 are
observed in a real browser, a Firefox build could plausibly install, look
healthy, and never show a single badge. A port that half-works is worse than no
port, so this should stay a developer build until someone has actually watched
it import.
