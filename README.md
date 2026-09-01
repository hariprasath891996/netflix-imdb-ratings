# IMDb Ratings for Netflix

Netflix doesn't show you IMDb ratings, so choosing something means opening a
second tab for every title that looks vaguely interesting. This is a small
Chrome extension that puts the rating straight onto the card.

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

This isn't on the Chrome Web Store — you load it directly from the folder.

1. **Get a free OMDb API key** at [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx).
   Pick the free tier (1,000 lookups a day) and confirm the activation email.
2. Clone or download this repository.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select this folder.
6. Click the extension's icon in the toolbar, paste your API key, hit **Save**.
7. Open Netflix and reload the page.

## How it works

Three files do the work:

- **`content.js`** runs inside the Netflix page. Netflix builds title cards
  lazily as you scroll, so it uses a `MutationObserver` to notice new cards and
  an `IntersectionObserver` to hold each lookup until the card is actually on
  screen — scrolling past three rows shouldn't spend quota on thirty. Titles
  come from each card's own `aria-label`, not from a child element.
- **`background.js`** is the service worker. It makes the OMDb call, caches
  every result for 30 days, and dedupes in-flight requests so one title
  appearing on five rows is still one network call.
- **`defaults.js`** holds the default thresholds, shared by the content script
  and the settings page so the numbers are defined in one place.
- **`content.css`** styles the badge. It sits top-right on purpose: Netflix
  uses the top-left corner for its TOP 10 ribbon and the bottom-left for
  "New Season" / "Recently added" tags.

The API call lives in the background worker rather than the content script for
two reasons: the page's CORS rules don't apply out there, and the API key never
enters a context Netflix's own JavaScript can read.

## Known limitations

Worth being upfront about these:

- **Netflix's HTML is not a contract.** Cards are found via `data-uia`
  attributes (`standard-card`, `ranked-card`, `progress-card`), which are
  Netflix's own test-automation hooks — far more stable than their class names,
  which are CSS-in-JS hashes that change every deploy. Still, they're free to
  rename them. If badges silently stop appearing, that's almost always why, and
  the fix is `CARD_SELECTORS` and `titleFromCard()` in `content.js`.
- **Titles are matched by name only**, with no year, because Netflix cards
  don't display one. Remakes and common titles can therefore match the wrong
  film. "Clear cache" in the settings forces a fresh lookup.
- **1,000 lookups a day** on OMDb's free tier. The 30-day cache means normal
  browsing stays well under it, but a first run on a fresh install eats a few
  hundred.
- **Chrome only.** It's Manifest V3, so Firefox would need small changes.

## Ideas for later

- Make the badge a link through to the IMDb page
- Show the rating in the hover preview modal too, not just the card
- A minimum-rating filter that dims everything below your threshold
- Rotten Tomatoes score alongside IMDb (OMDb returns it in the same response)

## Licence

MIT — see [LICENSE](LICENSE).
