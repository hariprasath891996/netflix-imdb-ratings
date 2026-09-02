# Roadmap

Most of this list is sorted by one test: **does it change whether you pick a
better film?** That is core; the rest is polish. Two groups answer a different
question and are tiered separately — **Watching** improves the viewing rather
than the choosing, and **Capture** is about getting text and images off the
page. Together those two are the candidate paid tier.

**Verified** means someone watched it work in a browser: ✓ seen working,
~ partly, — never observed. It is tracked separately from shipped because most
of this was written by agents and checked by reading, which is evidence but not
the same thing.

## Shipped — core

| # | Feature | Verified | Note |
| ---: | --- | :---: | --- |
| 1 | IMDb rating on every card, colour-coded | ✓ | Watched 28 render, correct tiers and corner |
| 2 | Ratings from IMDb's dataset — no server, key or account | ✓ | 1,712,379 titles imported on a real machine |
| 3 | `basics` imported, monthly cadence | ✓ | 787,184 titles imported |
| 4 | Local title index — most titles resolve with no network call | ~ | Resolution works; the local-vs-network split is unobserved |
| 5 | Daily conditional refresh (a 304 skips the import) | — | |
| 6 | Alias resolution — "Laapataa Ladies" → "Lost Ladies" | ✓ | Seen on a live badge tooltip |
| 7 | Title normalisation — curly quotes, "(U.S.)", "(2011)" | — | |
| 8 | Adjustable colour bands, dragged on a 0–10 scale | — | Rendered in a harness only |
| 9 | Dim what I'd skip, by rating | ✓ | 10 of 14 cards dimmed on a live homepage |
| 10 | Dim by runtime, kind and genre | ~ | Type, runtime and genres confirmed stamped on every badge; the rules themselves unobserved |
| 11 | Correct a wrong match | — | |
| 12 | Thin-evidence marker — dashed under 1,000 votes | ✓ | Two found on a live page |
| 13 | Under-seen gem halo | — | None qualified on the page tested; band is narrow by design |
| 14 | Best-in-row marker | ~ | **Was broken** — the dim filter silently disabled it. Fixed; the fix is unobserved |
| 15 | Series-vs-film disambiguation | ~ | Diagnostic reports the type; the hint path is unobserved |
| 16 | Sort a grid by IMDb rating | — | **The one feature that can break the page** — see risks |
| 17 | Netflix: rows, search, My List, genre grids | ~ | Badges seen on rows; grids unobserved |
| 18 | Prime Video | ~ | Placement checked against the live site with the real stylesheet; the extension itself unobserved there |
| 19 | Per-platform badge corner | ✓ | All 14 live badges carry the Netflix corner |
| 20 | Rating restated inside the hover preview | ✗ | **Never once reachable** — see risks |
| 21 | Is it finished, or still running | ✗ | Same surface as #20, so the same problem |

## Shipped — good to have

| # | Feature | Verified | Note |
| ---: | --- | :---: | --- |
| 22 | Hidden-genre picker | ✓ | Shift+G, 184 IDs, search and keyboard all working |
| 23 | Per-dataset status panel | ✓ | Reports each file separately |
| 24 | "Why isn't this showing?" diagnostic | ✓ | Found the real fault on its first use |
| 25 | Extension icons, generated from source | ✓ | |
| 26 | Landing website | ✓ | Reviewed and tap targets fixed |
| 27 | Faster imports | ✓ | Indirectly — all imports completed |
| 28 | Filter settings UI with an active-filter summary | ~ | Rendered in a harness |
| 29 | Settings page — cards, control states, AA contrast | ~ | |
| 30 | Preview harness (`preview.html`) | ✓ | |
| 31 | Modifier-click a badge to open IMDb | ✓ | Every badge linkable; the tooltip names the chord |
| 32 | Shift+B hides all badges | — | |

## Pending — core

| # | Feature | Blocker |
| ---: | --- | --- |
| 33 | Year disambiguation | The IMDb half is done — `startYear` is imported and returned. What is missing is a year from *Netflix* to compare against. 43% of titles share a name with another entry, and type alone cannot separate a 2011 series from a 2024 one |
| 34 | Move the preview-panel features somewhere reachable | The chip and run-status live in Netflix's hover preview, which never opened once in testing. This is the same fault that killed the season strip, and it is still unfixed for the two features that remain there |

## Pending — good to have

| # | Feature | Blocker |
| ---: | --- | --- |
| 35 | Firefox port | Manifest V3 with small changes; only worth it if Firefox is used |
| 36 | Disney+ | **Blocked**: `disneyplus.com` redirects to JioHotstar from India, so it can be neither tested nor supported from here |

## Pending — watching

| # | Feature |
| ---: | --- |
| 37 | Stop autoplay previews on hover |
| 38 | Auto-skip intro, recap and next-episode |
| 39 | Randomiser — pick one for me |
| 40 | Playback speed, wider range and persistent |
| 41 | Keyboard shortcuts |
| 42 | Remove "Continue Watching" entries |
| 43 | Subtitle styling |

## Pending — capture

| # | Feature | Note |
| ---: | --- | --- |
| 44 | Subtitle and transcript capture | Rests on an unverified assumption: that Netflix still renders subtitles as DOM text |
| 45 | Vocabulary and phrase lookup | Largest build here, against an established incumbent, but the clearest evidence of a paying market |
| 46 | Timestamp bookmarks with notes | |
| 47 | Save the artwork | Ordinary CDN images, outside the DRM boundary |
| 48 | Export My List and viewing history | |

Frame capture is not on this list and will not be: Netflix video is
Widevine-protected, and working around that is DRM circumvention.

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
