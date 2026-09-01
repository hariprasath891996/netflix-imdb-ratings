# IMDb Ratings for Netflix

Netflix doesn't show you IMDb ratings, so choosing something means opening a
second tab for every title that looks vaguely interesting. This is a small
Chrome extension that puts the rating straight onto the card.

**No API key, no account, no server.** Ratings come from IMDb's own published
dataset, downloaded to your machine and refreshed once on each day you use it.

Ratings are colour-coded so you can scan a row without reading the numbers:

| Badge | Default |
| --- | --- |
| 🟢 green | 7.5 and above |
| 🟠 amber | 6.5 – 7.4 |
| 🔴 red | below 6.5 |
| ⚪ grey | no IMDb rating found |

Those cut-offs are a taste call, not a fact, so they're editable in the
extension's settings. Changes apply to an open Netflix tab immediately — only
the colour mapping changes, so nothing is looked up again.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Open Netflix.

On first run it imports IMDb's ratings dataset — about 8 MB, roughly a minute.
Badges appear as soon as it finishes. There's nothing to sign up for.

## How it works

Two data sources, split by what each is good at.

**Ratings — no network call at all.** IMDb publishes every rated title as a
[bulk dataset](https://datasets.imdbws.com/): 1.7 million rows, ~8 MB gzipped,
regenerated daily. It's imported once into IndexedDB, after which looking up a
rating is a local read. Nothing can beat that for speed, and it means the
extension is not scraping ratings at all.

**Title → IMDb id — one small call, once per title, ever.** The dataset is
keyed by IMDb id, and Netflix only gives us a display name — which frequently
isn't IMDb's title:

| Netflix's label | IMDb's title |
| --- | --- |
| Laapataa Ladies | Lost Ladies |
| My Liberation Notes | My Liberation Diary |
| Hello, My Twenties! | Age of Youth |
| Misaeng: Incomplete Life | Misaeng |
| Couple on the Backtrack | Go Back Couple |

IMDb's suggestion endpoint resolves these in about a kilobyte of JSON. The
result is cached permanently, so each title costs one lookup once and never
again.

Choosing between suggestions is where accuracy is won or lost. IMDb ranks
upcoming releases highly, so searching "Youth" returns the unreleased 2026
entry above the rated 2015 one. Because the ratings index is local, the
extension checks whether a candidate is actually rated *while* picking, at no
network cost. Exactness still wins first: a rated film with the wrong name is a
worse answer than an unrated one with the right name.

### The files

- **`content.js`** runs inside the Netflix page. Netflix builds cards lazily as
  you scroll, so a `MutationObserver` notices new ones and an
  `IntersectionObserver` holds each lookup until the card is actually on screen.
  Titles come from each card's own `aria-label`, not from a child element.
- **`background.js`** owns both data sources, the IndexedDB stores, and the
  daily refresh.
- **`defaults.js`** holds the default thresholds, shared by the content script
  and the settings page so the numbers are defined in one place.
- **`content.css`** styles the badge. It sits top-right on purpose: Netflix
  uses the top-left corner for its TOP 10 ribbon and the bottom-left for
  "New Season" / "Recently added" tags.
- **`preview.html`** is a local harness for eyeballing the badge without
  loading the extension. Not part of the extension itself.

## Coverage

Measured against 430 real titles from an Indian Netflix homepage, a catalogue
heavy in Korean drama, Tamil and Telugu cinema, and anime:

| | Titles | Share |
| --- | ---: | ---: |
| Has an IMDb rating | 425 | **98.8%** |
| No rating found | 5 | 1.2% |

24 of those 425 matched an IMDb entry under a different name.

For comparison, the same 430 titles through the OMDb API returned 86%. The gap
was mostly not missing data — it was alias resolution.

## Known limitations

- **Netflix's HTML is not a contract.** Cards are found via `data-uia`
  attributes (`standard-card`, `ranked-card`, `progress-card`), which are
  Netflix's own test-automation hooks — far more stable than their class names,
  which are CSS-in-JS hashes that change every deploy. Still, they're free to
  rename them. If badges silently stop appearing, that's almost always why, and
  the fix is `CARD_SELECTORS` and `titleFromCard()` in `content.js`.
- **Matching is by name, without a year**, because Netflix cards don't display
  one. Remakes and sequels can resolve to the wrong entry — "Welcome to Waikiki
  2" matches season 1. The badge tooltip names the matched IMDb title and year
  precisely so a bad match is visible rather than silent, and **Clear matches**
  in the settings forces a fresh resolution.
- **The suggestion endpoint is undocumented.** It's the public JSON that powers
  IMDb's own search box, not a supported API, and could change without notice.
- **Some titles have no rating anywhere.** Trailers and unreleased films
  genuinely have nothing to show, and grey is the honest answer there.
- **Chrome only.** It's Manifest V3, so Firefox would need small changes.

## Ideas for later

- Make the badge a link through to the IMDb page
- Show the rating in the hover preview modal too, not just the card
- A minimum-rating filter that dims everything below your threshold
- Use vote counts to flag a 9.2 from 400 votes differently from one with 800,000

## Licence

MIT — see [LICENSE](LICENSE).
