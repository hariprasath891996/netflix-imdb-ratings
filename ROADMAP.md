# Roadmap

Features are split by one test: **does it change whether you pick a better
film?** That is core. Everything else is polish, however pleasant.

`Needs` names the IMDb dataset file a feature depends on. `ratings` (8 MB) is
already imported; `basics` (216 MB) and `episode` (52 MB) are not yet.

## Master list

| # | Feature | Tier | Status | Needs | Blocker / note |
| ---: | --- | --- | --- | --- | --- |
| 1 | IMDb rating badge on every card, colour-coded | Core | **Built** | ratings | — |
| 2 | Ratings from IMDb's published dataset — no server, no key, no account | Core | **Built** | ratings | — |
| 3 | Daily refresh, conditional — a 304 costs zero bytes and skips the import | Core | **Built** | ratings | — |
| 4 | Alias resolution — "Laapataa Ladies" → "Lost Ladies" | Core | **Built** | — | Uses IMDb's suggestion endpoint, which is public but undocumented and could change without notice |
| 5 | Title normalisation — curly quotes, trailing "(U.S.)" / "(2011)" | Core | **Built** | — | — |
| 6 | Adjustable colour bands, dragged on a 0–10 scale | Core | **Built** | — | — |
| 7 | Live recolour on threshold change, with no refetch | Core | **Built** | — | — |
| 8 | Dim what I'd skip — unrated titles never dim | Core | **Built** | — | — |
| 9 | Correct a wrong match — candidates listed with vote counts, pin one | Core | **Built** | — | A pin needs a Netflix reload to show, because the match lives in IndexedDB rather than storage |
| 10 | Thin-evidence marker — dashed outline under 1,000 votes | Core | **Built** | ratings | — |
| 11 | Rating restated inside the hover preview | Core | **Built** | — | Netflix only; Prime has no verified equivalent |
| 12 | Netflix browse rows | Core | **Built** | — | — |
| 13 | Netflix search results | Core | **Built** | — | Needed no work — Netflix reuses the row component |
| 14 | Netflix My List | Core | **Built** | — | — |
| 15 | Netflix genre grids | Core | **Built** | — | — |
| 16 | Prime Video | Core | **Built** | — | Only `primevideo.com` verified live; the `amazon.*/gp/video` patterns are unverified |
| 17 | Per-platform badge corner — right on Netflix, left on Prime | Core | **Built** | — | Both corners measured on the live sites |
| 18 | Modifier-click a badge to open IMDb | Good to have | **Built** | — | — |
| 19 | Shift+B hides all badges | Good to have | **Built** | — | Resets on a hard reload; deliberate, so a hidden state never reads as broken |
| 20 | Extension icons, generated from source | Good to have | **Built** | — | — |
| 21 | Landing website | Good to have | **Built** | — | Pricing section is a placeholder; there is no checkout |
| 22 | Preview harness for the badge | Good to have | **Built** | — | — |
| 23 | Settings page — cards, real control states, AA contrast | Good to have | **Built** | — | — |
| 24 | **Type & year disambiguation** | Core | Pending | basics | 184 of 426 homepage titles (43%) share a name with other IMDb entries. Type is available now via the preview modal's "5 Seasons"; year needs a year read from Netflix to compare against |
| 25 | **Episode ratings / season strip** | Core | Pending | episode | None. 880k rated episodes exist; no competitor does this |
| 26 | **Is it finished, or still running** | Core | Pending | basics | None. 76% of homepage series have ended |
| 27 | Sort a grid by rating | Core | Pending | — | None |
| 28 | Runtime filter — "I have 90 minutes" | Good to have | Pending | basics | Must be films-only: for a series `runtimeMinutes` is the episode length |
| 29 | Movies-only / series-only filter | Good to have | Pending | basics | Netflix's own nav partly covers this |
| 30 | Genre filter | Good to have | Pending | basics | None |
| 31 | Offline alias resolution | Good to have | Pending | basics | Partial only — some Netflix labels ("My Liberation Notes") appear in neither title field. Full coverage needs `akas`, 489 MB, too large to carry |
| 32a | AniList scores for thin-evidence anime | Good to have | **Dropped** | — | **Decided: IMDb only.** The evidence was favourable — "Hajime no Ippo" is 8.5 from 91 IMDb votes against 87/100 from 143,693 AniList users, and all seven homepage anime resolved with no key — but a second source means a second scale, a second provenance to explain in a one-number badge, and a second thing that can go down. MyAnimeList would have solved the scale problem (it scores 0–10) but its own API needs an OAuth registration and the free Jikan wrapper returned 504 on every search during evaluation, which is the dependency argument making itself. Kept here with the measurements so the case does not have to be rebuilt if the decision is ever revisited 
| 32b | Other rating sources | — | **Dropped** | — | Rotten Tomatoes and Metacritic: no API and no bulk dataset, and both are film-shaped (see rows 38–39). TMDB: obtainable, but duplicates IMDb rather than filling a gap. Letterboxd and Douban: no public API. **MyDramaList: the most valuable gap of all — Korean drama is roughly a third of a real homepage and it is the authority — but there is no API and no dataset, so there is no honest route to it** |
| 32 | Surface hidden gems — high rating, modest votes | Good to have | Pending | — | Under-seen and badly-matched look identical today; needs a rule that separates them |
| 33 | Netflix's hidden genres | Good to have | Pending | — | Largest scope expansion on the list |
| 34 | Best-in-row highlight | Good to have | Pending | — | None |
| 35 | Faster first import via a pre-filtered index | Good to have | Pending | — | Works against the larger imports above |
| 36 | Firefox port | Good to have | Pending | — | Manifest V3 with small changes; only worth it if Firefox is used |
| 37 | Disney+ | Good to have | **Blocked** | — | `disneyplus.com` redirects to JioHotstar from India, so it can be neither tested nor supported from here. Real selectors are known (`set-item`, `set-shelf-item`) but unverified |
| 38 | Rotten Tomatoes | — | **Dropped** | — | 19% coverage on a real Indian homepage, zero for Korean and Japanese. On a US catalogue, 100% of theatrical films but **0 of 12 Netflix Originals** — OMDb carries RT for films, not series. Would also reinstate the per-user API key and daily cap |
| 39 | Metacritic | — | **Dropped** | — | 18.3% coverage, same source, same series-shaped gap |
| 40 | JioHotstar | — | **Dropped** | — | Homepage is daily serials, cricket and news, which IMDb barely rates; card labels are episode identifiers ("S1 E691") not titles; and a low willingness-to-pay audience |
| 41 | HBO Max | — | **Dropped** | — | Not available in India, so unverifiable from here |
| 42 | Scraping IMDb pages | — | **Dropped** | — | Superseded. IMDb publishes the ratings as a dataset, which is faster than any scraper, sanctioned, and cannot break on a redesign |
| 43 | OMDb as the rating source | — | **Dropped** | — | Replaced by IMDb's dataset: 86% → 98.8% coverage, and the API key requirement disappeared |
| 44 | Native `title` tooltip | — | **Dropped** | — | `pointer-events: none` made it unhoverable, and Netflix's autoplay outran it. Replaced by a custom tooltip, then largely superseded by the preview chip |
| 45 | Playback speed shortcuts | — | **Dropped** | — | A competitor has it, but it has nothing to do with ratings |

### Standing caveat

Nothing since v0.2.0 has been run as a loaded extension. Everything built since
was verified by reading the code and by injecting the same logic into the live
sites through the browser, which is not the same thing as running it.

### On import cost

Adding `basics` does not mean a 216 MB daily download. A film's year, runtime
and genre are immutable — only new rows are ever appended — so `basics` and
`episode` refresh monthly while `ratings` stays daily. Ratings barely move
either: for the 84% of a homepage above 5,000 votes, shifting a badge by 0.1
would take 1,843 new votes all landing two points off the average. The cost of
these features is a larger one-time install, not a recurring burden.

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
