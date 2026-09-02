# Roadmap

Most of this list is sorted by one test: **does it change whether you pick a
better film?** That is core; the rest is polish.

Two groups answer a different question and are tiered separately. **Watching**
makes the viewing better rather than the choosing, and **Capture** is about
getting text and images off the page. Both are committed, and together they are
the candidate paid tier — see "Why this matters for pricing" below.

**Standing caveat: nothing since v0.2.0 has been run as a loaded extension.**
Everything shipped below was verified by reading code, by injecting the same
logic into the live sites through a browser, and by harnesses the agents wrote
(a VM check that the four content scripts do not collide at load, a headless
run of sort.js against a simulated grid, a stubbed-IndexedDB resolution test).
That is real evidence. It is not the same as running it.

## Shipped

### Core

| # | Feature | Note |
| ---: | --- | --- |
| 1 | IMDb rating on every card, colour-coded | The product |
| 2 | Ratings from IMDb's published dataset — no server, key or account | 1.7M titles, local |
| 3 | Daily conditional refresh | A 304 costs zero bytes and skips the import |
| 4 | `basics` + `episode` imported, on their own monthly cadence | Untested at full size |
| 5 | Local title index — most titles resolve with **zero network calls** | 13.4 MB, bucketed; measured through v8.serialize |
| 6 | Alias resolution — "Laapataa Ladies" → "Lost Ladies" | Local first, suggestion endpoint as fallback |
| 7 | Title normalisation — curly quotes, "(U.S.)", "(2011)" | — |
| 8 | Adjustable colour bands, dragged on a 0–10 scale | Netflix recolours as you drag |
| 9 | Dim what I'd skip, by rating | Unrated titles never dim |
| 10 | Dim by runtime, kind and genre | Runtime is films-only; nothing dims on missing data |
| 11 | Correct a wrong match | Pins survive "clear matches" |
| 12 | Thin-evidence marker — dashed under 1,000 votes | ~3% of a homepage |
| 13 | Under-seen gem halo | 1,000–10,000 votes and above your green line |
| 14 | Best-in-row marker | Floored at your green line, recomputed as rows fill |
| 15 | Rating restated inside the hover preview | Netflix only |
| 16 | Series-vs-film disambiguation | Reads Netflix's own "5 Seasons" / "1h 52m" |
| 18 | Is it finished, or still running | 76% of homepage series have ended |
| 19 | Sort a grid by IMDb rating | Works on Netflix's bucketed DOM. **The one feature that could break the page** — see risks |
| 20 | Netflix: rows, search, My List, genre grids | Search needed no work |
| 21 | Prime Video | `amazon.*` patterns unverified |
| 22 | Per-platform badge corner | Both corners measured live |

### Good to have

| # | Feature | Note |
| ---: | --- | --- |
| 23 | Hidden-genre picker | 184 community-documented IDs, searchable, Shift+G |
| 24 | Filter settings UI with an active-filter summary | 21 genres as a chip grid, not a wall of checkboxes |
| 25 | Faster imports | 11.5M row-splits reduced to ~700k |
| 26 | Modifier-click a badge to open IMDb | Plain clicks fall through untouched |
| 27 | Shift+B hides all badges | Resets on hard reload, deliberately |
| 28 | Extension icons, generated from source | No image library needed |
| 29 | Landing website | Pricing is a placeholder, no checkout |
| 30 | Preview harness | `preview.html` |
| 31 | Settings page — cards, real control states, AA contrast | — |

## Pending

### Core

| # | Feature | Blocker |
| ---: | --- | --- |
| 32 | Year disambiguation | The IMDb half is done — `startYear` is imported and returned. What is missing is a year from *Netflix* to compare against; the preview modal gives seasons and runtime but no year. 43% of titles share a name with another entry, and type alone cannot separate a 2011 series from a 2024 one |

### Good to have

| # | Feature | Blocker |
| ---: | --- | --- |
| 33 | Firefox port | Manifest V3 with small changes; only worth it if Firefox is used |
| 34 | Disney+ | **Blocked**: `disneyplus.com` redirects to JioHotstar from India, so it can be neither tested nor supported from here |

### Watching — makes the viewing better, not the choosing

| # | Feature | Why |
| ---: | --- | --- |
| 35 | Stop autoplay previews on hover | The most-complained-about Netflix behaviour; the setting exists but is buried per-profile. It is also what outran our own tooltip |
| 36 | Auto-skip intro, recap and next-episode | Netflix supplies the button; pressing it forty times a season is the annoyance |
| 37 | Randomiser — pick one for me | Pairs with the filters already built: narrow, then let it choose. Finishes the original problem, which was never "what is good" but "I cannot decide" |
| 38 | Playback speed, wider range and persistent across episodes | Netflix's own control is narrow and resets |
| 39 | Keyboard shortcuts | ±10s, next/previous episode, speed |
| 40 | Remove "Continue Watching" entries | Netflix makes this deliberately awkward |
| 41 | Subtitle styling beyond Netflix's presets | — |

### Capture — text and images, never video

| # | Feature | Why it is possible |
| ---: | --- | --- |
| 42 | Subtitle and transcript capture | Netflix renders subtitles as DOM text, outside the encrypted stream. **Load-bearing assumption, not yet verified** — checking it needs playback on a real account |
| 43 | Vocabulary and phrase lookup | Same text. Language Reactor built a large *paid* userbase on exactly this — the strongest evidence of willingness to pay anywhere near this product. Also the largest build on this list, against an established incumbent, so it deserves its own decision |
| 44 | Timestamp bookmarks with notes | Player position is readable; the note is local |
| 45 | Save the artwork | Box art and title treatments are ordinary CDN images, outside the DRM boundary |
| 46 | Export My List and viewing history | The user's own account data, already rendered in the page |

### Not possible, and not to be attempted

Screenshots and frame capture. Netflix video is Widevine-protected, so
`canvas.drawImage()` on the video element yields black. Working around that is
DRM circumvention: not a build we will ship, both because it invites the
extension being pulled and because anti-circumvention law is not a grey area
worth testing.

## Known risks

- **Grid sort can plausibly break the page.** While tiles sit in rows React did
  not place them in, a React deletion of an individual tile calls `removeChild`
  on the row its fiber records and throws inside Netflix's reconciler. Nothing
  in a content script can make that safe; the code shortens the window (resize
  snap-back, restore on unmount, concede after two fights). Netflix's observed
  deletions are whole-subtree and its growth is append-only, so this is expected
  to hold — but that is inference. The tell is a React error right after a
  resize or a My List deletion; the fix is one line.
- **The imports are untested at full size**, including a peak in-memory index of
  roughly 100 MB during the episode pass.
- **Prime Video is verified only on `primevideo.com`.**

## Why this matters for pricing

IMDb's dataset is licensed for non-commercial use, which is what makes charging
for *ratings* legally murky. The Watching and Capture groups use no third-party
data at all — they are our own code manipulating a page nobody licenses to us.

So the free/paid line can follow the licence boundary rather than being drawn
arbitrarily: **ratings stay free permanently**, honouring the licence and
serving as the acquisition route (store search for "imdb netflix" is the
channel), while the watching and capture bundle is what is sold. That is a
split with an argument behind it.

## Parked — built, then removed

| Feature | Why it was pulled |
| --- | --- |
| Season strip / per-season ratings | **Built and working, then removed on reflection.** The decision made while browsing is "should I start this", and the overall rating answers that. Per-season quality answers "should I keep going", which is asked three seasons in while clicking next-episode — not while hovering cards on a homepage. The information is real; it arrives at the wrong moment. Knowing that Game of Thrones collapses in season 8 does not stop anyone watching seasons 1–7. It also failed the test the rest of this list is sorted by, and was defended here on the grounds that no competitor had it — which is not the same as it being useful. Removing it took `title.episode` (52 MB) and its import with it. The measurements are worth keeping if it is ever revisited: across 230 homepage series, 107 have multiple seasons but only 22% vary by a full point, median spread 0.54 — so even at its best the feature had something to say about roughly one series in ten. Worth reconsidering only somewhere the "keep going" question is actually being asked, such as on a series' own page mid-watch |

## Dropped

| Feature | Reason |
| --- | --- |
| Rotten Tomatoes | 19% coverage on a real Indian homepage, zero for Korean and Japanese. On a US catalogue, 100% of theatrical films but **0 of 12 Netflix Originals** — OMDb carries RT for films, not series. Would reinstate the per-user API key |
| Metacritic | 18.3%, same source, same series-shaped gap |
| AniList / MyAnimeList | **Decided: IMDb only.** AniList passed every test — "Hajime no Ippo" is 8.5 from 91 IMDb votes against 87/100 from 143,693 AniList users, no key needed, 7 of 7 matched. Dropped anyway: a second source means a second scale and a second provenance inside a badge whose strength is being one number. MyAnimeList would have solved the scale (it scores 0–10) but its API needs OAuth and the free Jikan wrapper returned 504 on every search during evaluation |
| TMDB, Letterboxd, Douban, MyDramaList | TMDB duplicates IMDb rather than filling a gap. The others have no public API. **MyDramaList is the most valuable gap of all** — Korean drama is roughly a third of a real homepage and it is the authority — but there is no route to it |
| JioHotstar | Daily serials, cricket and news, which IMDb barely rates; card labels are episode identifiers not titles; low willingness-to-pay audience |
| HBO Max | Not available in India, so unverifiable from here |
| Scraping IMDb pages | Superseded. The published dataset is faster than any scraper, sanctioned, and cannot break on a redesign |
| OMDb as the rating source | Replaced: 86% → 98.8% coverage, and the API key requirement disappeared |
| Native `title` tooltip | `pointer-events: none` made it unhoverable, and Netflix's autoplay outran it |
| Playback speed shortcuts | A competitor has it, but it has nothing to do with ratings |

---

## Core

### 1. Dim what you'd skip
Turn the homepage into a shortlist rather than 400 equally bright cards. Set a
minimum and everything below it recedes.

This is the highest-value item on the list, and Trim's users independently
confirm it — their equivalent ("fade out") is the feature reviewers single out.
Everything built so far (thresholds, colours, coverage) is infrastructure this
sits on top of. It is what finishes the original problem: *it's hard to choose*.

One rule: **never dim an unrated title.** Absence of a rating is not a low
score. Dimming the greys would bury exactly the new and regional titles worth
discovering.

### 2. Correct a wrong match
24 of 425 measured titles resolved to a differently-named IMDb entry, and some
are wrong: *Welcome to Waikiki 2* matched season 1, *Coffee Prince* landed on
an entry with 132 votes. Today a wrong match is silent misinformation and the
only remedy is clearing every cached match.

A per-title "that's not it, pick the right one" makes the extension
*trustworthy* rather than mostly-right — and a filter (#1) built on questionable
matches will hide something good and never tell you.

### 3. Sort a grid by rating
Netflix's genre and category pages are grids, not rows. Sorting one by IMDb
rating is a fundamentally different act from reading badges: it ranks the
catalogue for you. Trim does this and it is one of their strongest features.

### 4. Work on every surface where you choose
Currently only browse rows are badged. Not search results, not My List, not
genre pages, not the full detail page. Search is where you go when you already
have a name in mind and most want the number.

Scope this down: **search results first**, then reassess. "Support every
surface" is how a weekend project becomes a chore.

---

## Good to have

### 5. Netflix's hidden genres
Netflix has hundreds of unlisted category IDs it doesn't surface. Exposing them
with a genre picker is Trim's most distinctive feature, and it addresses the
same underlying problem from the other end: not "is this good" but "what else
is there". Biggest scope expansion here, and the highest ceiling.

### 6. More rating sources
Rotten Tomatoes (critic + audience) and Metacritic alongside IMDb. Note the
obstacle: neither has a public API, and neither publishes a bulk dataset the way
IMDb does — so this reintroduces exactly the server dependency this extension
was designed to avoid. Worth wanting; hard to do honestly.

### 7. Other streaming services
Prime Video, Disney+/Hotstar, JioCinema. The rating pipeline is already
platform-agnostic — only card detection and title extraction are Netflix-shaped.

### 8. Smaller conveniences
- Click a badge to open the IMDb page (modifier-click, so it never fights
  Netflix's own click handler)
- Keyboard shortcut to toggle badges off when you want the artwork unobstructed
- Highlight the best-rated card in each row
- Playback speed keys (`[` / `]`) — Trim has this and users like it, though it
  has nothing to do with ratings
- Faster first import by shipping a pre-filtered index (drop titles under ~100
  votes)
- Use the preview modal's "5 Seasons" signal to disambiguate a series from a
  same-named film during matching
- Firefox port

---

## What Trim teaches us not to do

Trim is a good product with a fragile foundation, and the contrast is the whole
argument for this extension's architecture.

**Everything routes through one server.** Its manifest declares exactly one
host: `goodmovies.io`. Every rating, for all 50,000+ users across eight
streaming platforms, is fetched from a single Node/Express box. When it stops,
everyone stops at once, and no user can do anything about it. There is no CDN
and no failover.

Signs of that fragility are already visible: their marketing site `gettrim.cc`
currently returns 502, and their API leaks stack traces with server filesystem
paths in production responses.

**This extension has no server.** Ratings come from IMDb's own published
dataset, downloaded to the user's machine and refreshed daily. There is nothing
to go down, nothing to pay for, and no request that can be rate-limited. The
one network call left — resolving a title to an IMDb id — is cached permanently
per title.

That is not a small difference. It is the difference between a product that
needs revenue to survive and one that costs nothing to keep running forever.

Two smaller things worth not copying: Trim sends telemetry to Google Analytics,
and it has accounts (`/auth`). Neither is needed to show a number on a card.
