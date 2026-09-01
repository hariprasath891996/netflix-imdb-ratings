# Roadmap

Features are split by one test: **does it change whether you pick a better
film?** That is core. Everything else is polish, however pleasant.

---

## Status at a glance

### Built — core

| Feature | Notes |
| --- | --- |
| IMDb rating on every card, colour-coded | The product. Green / amber / red, readable without reading numbers. |
| Ratings from IMDb's own dataset | 1.7M titles, ~8MB, local, refreshed daily. No server, no API key, no account. |
| Alias resolution | "Laapataa Ladies" → "Lost Ladies". Recovered 57 of 60 titles OMDb had missed. |
| Title normalisation | Curly apostrophes flattened; a trailing "(U.S.)" or "(2011)" retried without it. |
| Adjustable colour bands | Two draggable boundaries on a 0–10 scale. Netflix recolours as you drag. |
| Dim what I'd skip | Titles below your bar recede. Unrated titles never dim. |
| Correct a wrong match | Search, see candidates with vote counts, pin the right one. Pins survive "clear matches". |
| Thin-evidence marker | An 8.9 from 74 votes gets a dashed outline. Threshold measured, not guessed. |
| Rating inside the hover preview | Netflix replaces the card with a mini-player; the score is restated where you end up looking. |
| Netflix: rows, search, My List, genre grids | Search needed no work — Netflix reuses the row component there. |
| Prime Video | Verified live, 54/54 titles extracted. Badge corner flips to clear Prime's own ribbons. |

### Built — good to have

| Feature | Notes |
| --- | --- |
| Modifier-click a badge → IMDb | Plain clicks fall through to Netflix untouched. |
| Shift+B hides all badges | For seeing the artwork unobstructed. |
| Icons | Generated from source by `tools/make_icons.py`, no image library needed. |
| Landing site | `site/` — demonstrates the badge rather than describing it. |
| Preview harness | `preview.html` — eyeball the badge without loading the extension. |

### Pending — core

| Feature | Why it matters | Blocker |
| --- | --- | --- |
| Sort a grid by rating | Genre pages are grids. Sorting one ranks the catalogue for you rather than annotating it. | None — next up. |

### Pending — good to have

| Feature | Why it matters | Blocker |
| --- | --- | --- |
| Netflix's hidden genres | Hundreds of unlisted category IDs. Answers "what else is there" rather than "is this good". | Biggest scope expansion on the list. |
| Best-in-row highlight | Marks the strongest card in rows you'd otherwise skim past. | None. |
| Faster first import | Shipping a pre-filtered index would cut the ~30s first run. | None. |
| Series/film disambiguation | The preview modal knows "5 Seasons" — that could separate a series from a same-named film. | Only available on hover, so limited reach. |
| Firefox port | Manifest V3 with small changes. | Only worth it if Firefox is actually used. |
| Disney+ | Third target platform. | **Blocked**: `disneyplus.com` redirects to JioHotstar from India, so it cannot be built or verified from here. |

### Dropped — and why

| Feature | Reason |
| --- | --- |
| Rotten Tomatoes | Measured twice. 19% coverage overall on a real Indian homepage — **zero** for Korean and Japanese titles. On a US-style catalogue it reaches 100% for theatrical films but **0 of 12 Netflix Originals**, because OMDb carries RT for films and essentially not for series. A toggle that is blank on most of Netflix reads as broken. It would also reinstate the per-user API key and daily cap that the whole architecture exists to avoid. Viable only as a films-only opt-in; parked. |
| Metacritic | 18.3% coverage, same source and the same series-shaped gap. |
| JioHotstar | Homepage is daily serials, live cricket and news — IMDb rates almost none of it, and card labels are episode identifiers ("S1 E691") rather than titles. Low coverage and a low-willingness-to-pay audience. |
| HBO Max | Not available in India, so it cannot be verified from here. |
| Scraping IMDb pages | Superseded. IMDb *publishes* its ratings as a bulk dataset, which is faster than any scraper (a local read beats a network call), officially sanctioned, and cannot break when IMDb redesigns. |
| OMDb as the rating source | Replaced by IMDb's dataset: 86% → 98.8% coverage, and the API key requirement disappeared. |
| Native `title` tooltip | `pointer-events: none` made it unhoverable, and Netflix's autoplay preview outran it anyway. Replaced by an instant custom tooltip, then largely superseded by the preview-modal chip. |
| Playback speed shortcuts | A competitor has it and users like it, but it has nothing to do with ratings. Out of scope. |

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
