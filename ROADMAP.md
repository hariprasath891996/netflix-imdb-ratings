# Roadmap

Features are split by one test: **does it change whether you pick a better
film?** That is core. Everything else is polish, however pleasant.

`Needs` names the IMDb dataset file a feature depends on. All three —
`ratings` (8 MB, daily), `basics` (216 MB, monthly) and `episode` (52 MB,
monthly) — are now imported.

**Standing caveat: nothing since v0.2.0 has been run as a loaded extension.**
Everything below marked shipped was verified by reading the code and by
injecting the same logic into the live sites through a browser. That is real
evidence, but it is not the same as running it. v0.3.0 in particular carries a
schema upgrade, three imports and a 216 MB install download that have never
executed on a real machine.

## Shipped

### Core

| # | Feature | Note |
| ---: | --- | --- |
| 1 | IMDb rating on every card, colour-coded | The product |
| 2 | Ratings from IMDb's published dataset — no server, key or account | 1.7M titles, local |
| 3 | Daily conditional refresh | A 304 costs zero bytes and skips the import |
| 4 | `basics` + `episode` imported, on their own monthly cadence | v0.3.0. Untested at full size; the import holds ~100 MB in memory |
| 5 | Alias resolution — "Laapataa Ladies" → "Lost Ladies" | Recovered 57 of 60 titles OMDb had missed |
| 6 | Title normalisation — curly quotes, "(U.S.)", "(2011)" | Recovered 5 more |
| 7 | Adjustable colour bands, dragged on a 0–10 scale | Netflix recolours as you drag |
| 8 | Dim what I'd skip | Unrated titles never dim |
| 9 | Correct a wrong match — candidates with vote counts, pin one | Pins survive "clear matches" |
| 10 | Thin-evidence marker — dashed under 1,000 votes | Threshold measured: only ~3% of a homepage falls under it |
| 11 | Rating restated inside the hover preview | Netflix only |
| 12 | **Series-vs-film disambiguation** | v0.3.0. Reads Netflix's own "5 Seasons" / "1h 52m" before our chip is inserted |
| 13 | **Season strip, gated on spread** | v0.3.0. Renders only when seasons differ by ≥1.0 — 78% of multi-season series say nothing, so silence is the default |
| 14 | **Is it finished, or still running** | v0.3.0. 76% of homepage series have ended |
| 15 | Netflix: rows, search, My List, genre grids | Search needed no work |
| 16 | Prime Video | Only `primevideo.com` verified; `amazon.*` patterns unverified |
| 17 | Per-platform badge corner | Both corners measured live |

### Good to have

| # | Feature | Note |
| ---: | --- | --- |
| 18 | Modifier-click a badge to open IMDb | Plain clicks fall through untouched |
| 19 | Shift+B hides all badges | Resets on hard reload, deliberately |
| 20 | Extension icons, generated from source | `tools/make_icons.py`, no image library |
| 21 | Landing website | `site/`. Pricing is a placeholder, no checkout |
| 22 | Preview harness | `preview.html` |
| 23 | Settings page — cards, real control states, AA contrast | — |
| 24 | Grid sort by rating | **Shipped but dormant** — see pending #26 |

## Pending

### Core

| # | Feature | Needs | Blocker |
| ---: | --- | --- | --- |
| 25 | Year disambiguation | basics | The IMDb side is done — `startYear` is imported and returned. What is missing is a year from *Netflix* to compare it against; the preview modal gives seasons and runtime but not a year. 184 of 426 titles (43%) share a name with other IMDb entries, and type alone does not separate a 2011 series from a 2024 one |
| 26 | Make grid sort actually activate | — | Measured live: My List nests its tiles under 3 children, and a genre page nests 58 tiles inside 11 row containers. Neither presents tiles as flat children, so the (correct) guard bails on both. Working sorting needs tiles reordered *across* row containers, which is real work and fragile against Netflix's re-renders |

### Good to have

| # | Feature | Needs | Blocker |
| ---: | --- | --- | --- |
| 27 | Runtime filter — "I have 90 minutes" | basics ✓ | Data is now imported. Must be films-only: for a series `runtimeMinutes` is the episode length |
| 28 | Movies-only / series-only filter | basics ✓ | Data is now imported. Netflix's own nav partly covers it |
| 29 | Genre filter | basics ✓ | Data is now imported. Genres present on ~99% |
| 30 | Offline alias resolution | basics ✓ | Partial by nature — 38% of titles carry two spellings, but some Netflix labels ("My Liberation Notes") appear in neither. Full coverage needs `akas`, 489 MB |
| 31 | Surface hidden gems | — | Under-seen and badly-matched look identical today |
| 32 | Netflix's hidden genres | — | Largest scope expansion on the list |
| 33 | Best-in-row highlight | — | None |
| 34 | Faster first import | — | Works against the three imports now in place |
| 35 | Firefox port | — | Only worth it if Firefox is used |
| 36 | Disney+ | — | **Blocked**: `disneyplus.com` redirects to JioHotstar from India, so it can be neither tested nor supported from here |

## Candidates for a paid tier — not committed

These are complementary features: they make watching better rather than
choosing better, so they sit outside the test the rest of this list is sorted
by. Recorded because they answer a separate question — what someone would pay
for — and because the line between free and paid can be drawn somewhere
principled rather than arbitrarily.

**The test to apply is whether a feature needs data we do not have.** Pure UI
manipulation costs nothing architecturally: no server, no backend, nothing to
go down. Anything needing a data source reintroduces everything this extension
was built to avoid, and with it the need for revenue rather than the choice of
it.

### Costs nothing architecturally

| Feature | Why |
| --- | --- |
| Stop autoplay previews on hover | The most-complained-about Netflix behaviour; the setting exists but is buried per-profile. It is also what outran our own tooltip |
| Playback speed, wider range and persistent | Netflix's own control is narrow and resets between episodes |
| Auto-skip intro, recap and next-episode | Netflix supplies the button; pressing it forty times a season is the annoyance |
| Keyboard shortcuts | ±10s, next/previous episode, speed |
| Remove "Continue Watching" entries | Netflix makes this deliberately awkward |
| Randomiser — pick one for me | Pairs with the filters already built: narrow by rating, then let it choose. It finishes the original problem, which was never "what is good" but "I cannot decide" |
| Subtitle styling beyond Netflix's presets | — |

### Needs data — would undo the architecture

Leaving-soon dates, cross-service availability, content and parental warnings,
awards. All genuinely useful, all requiring a backend. Declining them is the
same decision as declining Rotten Tomatoes, for the same reason.

### Technically impossible

Screenshots and frame capture. Netflix video is DRM-protected and canvas
capture yields black frames.

### Why this matters for pricing

IMDb's dataset is licensed for non-commercial use, which is what makes charging
for *ratings* legally murky. The features above use no third-party data at all —
they are our own code manipulating a page nobody licenses to us.

So the free/paid line can follow the licence boundary rather than being drawn
arbitrarily: **ratings stay free permanently**, honouring the licence and
serving as the acquisition route (store search for "imdb netflix" is the
channel), while the playback and quality-of-life bundle is what is sold. That
is a split with an argument behind it.

---

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
