#!/usr/bin/env python3
"""Assemble the Firefox build into build/firefox/.

Firefox will only read a file called manifest.json, so a Firefox build cannot
be the source tree with a second manifest sitting next to it — something has to
do the rename. That alone would be a two-line shell step and not worth a file.

What is worth a file is the check that runs first. manifest.firefox.json
restates the version, the permissions, the host permissions and the whole
content_scripts block, and none of that is Firefox-specific: it is a verbatim
copy that no browser and no test will ever tell you has gone stale. Adding a
content script or a host permission to manifest.json and forgetting the other
file produces a Firefox build that loads cleanly and is quietly missing a
feature. So the shared keys are compared before anything is copied, and a
mismatch is a hard failure that names the key.

The keys that are *meant* to differ are listed in DIVERGENT below, and the
script asserts they still differ in the expected direction — a Firefox manifest
that has picked up a service_worker is as broken as one that has drifted.

    python3 tools/build-firefox.py          # assemble build/firefox/
    python3 tools/build-firefox.py --check  # compare the manifests, copy nothing
    python3 tools/build-firefox.py --zip    # also write build/firefox.zip
"""
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "firefox"

# Everything the extension actually loads at runtime. Listed rather than
# globbed because the source tree also holds a marketing site, a local badge
# harness and this script, and none of them belongs in a shipped archive.
SHARED = [
    "background.js",
    "content.js",
    "content.css",
    "defaults.js",
    "genres.js",
    "genres.css",
    "options.html",
    "options.js",
    "sort.js",
    "sort.css",
    "icons/icon16.png",
    "icons/icon32.png",
    "icons/icon48.png",
    "icons/icon128.png",
]

# Copied verbatim between the two manifests, so a difference is drift.
SHARED_KEYS = [
    "manifest_version",
    "name",
    "version",
    "description",
    "permissions",
    "host_permissions",
    "content_scripts",
    "action",
    "icons",
]

# Chrome-only key -> the Firefox key that replaces it. Both halves are checked:
# the Chrome manifest must still have the first, the Firefox one must not, and
# must have the second instead.
DIVERGENT = {
    "options_page": "options_ui",
}


def load(name):
    with open(ROOT / name, encoding="utf-8") as fh:
        return json.load(fh)


def compare(chrome, firefox):
    """Return a list of human-readable problems; empty means the two agree."""
    problems = []

    for key in SHARED_KEYS:
        if key not in chrome:
            problems.append(f"manifest.json is missing {key!r}")
        elif key not in firefox:
            problems.append(f"manifest.firefox.json is missing {key!r}")
        elif chrome[key] != firefox[key]:
            problems.append(
                f"{key!r} has drifted:\n"
                f"    manifest.json         {json.dumps(chrome[key], sort_keys=True)}\n"
                f"    manifest.firefox.json {json.dumps(firefox[key], sort_keys=True)}"
            )

    # A key added to manifest.json that neither side knows about is the case
    # this script exists to catch, so an unrecognised key is reported rather
    # than ignored - it is a decision someone has to make, not a diff.
    known = set(SHARED_KEYS) | set(DIVERGENT) | {"background"}
    for key in chrome:
        if key not in known:
            problems.append(
                f"{key!r} is in manifest.json and unclassified: decide whether it "
                f"is shared (add it to SHARED_KEYS) or Firefox-specific (add it "
                f"to DIVERGENT)"
            )

    for chrome_key, firefox_key in DIVERGENT.items():
        if chrome_key in firefox:
            problems.append(f"{chrome_key!r} is Chrome-only and must not be in manifest.firefox.json")
        if firefox_key not in firefox:
            problems.append(f"manifest.firefox.json is missing {firefox_key!r}")

    # The background key is the port's whole point, so it is checked by hand
    # rather than by equality.
    if "service_worker" not in chrome.get("background", {}):
        problems.append("manifest.json no longer declares background.service_worker")
    if "service_worker" in firefox.get("background", {}):
        problems.append("manifest.firefox.json declares background.service_worker; Firefox needs background.scripts")
    if "scripts" not in firefox.get("background", {}):
        problems.append("manifest.firefox.json is missing background.scripts")
    chrome_bg = chrome.get("background", {}).get("service_worker")
    firefox_bg = firefox.get("background", {}).get("scripts", [])
    if chrome_bg and [chrome_bg] != firefox_bg:
        problems.append(
            f"the two manifests run different background code: "
            f"{chrome_bg!r} vs {firefox_bg!r}"
        )

    gecko = firefox.get("browser_specific_settings", {}).get("gecko", {})
    if not gecko.get("id"):
        problems.append("manifest.firefox.json needs browser_specific_settings.gecko.id")

    return problems


def assemble():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for name in SHARED:
        source = ROOT / name
        if not source.exists():
            sys.exit(f"missing source file: {name}")
        target = OUT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    shutil.copy2(ROOT / "manifest.firefox.json", OUT / "manifest.json")
    return len(SHARED) + 1


def make_zip():
    archive = OUT.parent / "firefox.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(OUT.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(OUT))
    return archive


if __name__ == "__main__":
    problems = compare(load("manifest.json"), load("manifest.firefox.json"))
    if problems:
        print("The two manifests disagree:\n")
        for problem in problems:
            print(f"  - {problem}")
        print("\nNothing was built. Reconcile manifest.firefox.json and run again.")
        sys.exit(1)

    if "--check" in sys.argv:
        print("manifests agree")
        sys.exit(0)

    count = assemble()
    print(f"  {OUT.relative_to(ROOT)}  {count} files")
    if "--zip" in sys.argv:
        archive = make_zip()
        print(f"  {archive.relative_to(ROOT)}  {archive.stat().st_size:,} bytes")
