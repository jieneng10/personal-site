---
name: run-personal-site
description: Build, run, screenshot, and interact with the personal-site static web app. Use when asked to run the app, start the dev server, take a screenshot, test UI changes, or verify the site renders correctly.
---

static HTML single-page app with Supabase backend. No build step.
Drive it via `.claude/skills/run-personal-site/driver.mjs` — starts
a Python HTTP server, launches headless Chromium via Playwright,
navigates sections, takes screenshots, audits the console.

All paths below are relative to repo root.

## Prerequisites

Python 3 (for `http.server`), Node.js, and Playwright with Chromium.

```bash
sudo apt-get update
sudo apt-get install -y python3
```

```bash
npm install
npx playwright install chromium
```

## Setup

```bash
npm install          # installs playwright + marked
```

No build step — the site is static HTML/CSS/JS. The only npm dependency
is `marked` (Markdown renderer, bundled as a vendored copy at
`js/marked.min.js`) and `playwright` (dev-only, for the driver).

No env vars required. The site runs against Supabase at
`https://nskircwzcsmbkispshif.supabase.co` using the anon key baked
into `js/shared.js`. It works in guest mode without auth — all sections
render, news loads from the local JSON fallback.

## Run (agent path)

The driver handles server lifecycle, browser launch, interaction, and
cleanup:

```bash
node .claude/skills/run-personal-site/driver.mjs
```

Optional: `--port <n>` to override the default port 8000.

The driver performs these checks in order:

| step | what it verifies |
|---|---|
| Server startup | Python HTTP server on port 8000 (auto-finds free port) |
| Page load | `index.html` returns 200, DOM ready, defer scripts loaded |
| Title | `<title>` contains "jieneng" |
| Key elements | `#bgLayer`, `#sakuraCanvas`, `.sidebar`, `#contentPanel`, `#btnNewsToggle`, `#bgmPlayer`, `#wallpaperPicker` |
| Screenshot 1 | `screenshots/01-homepage.png` — initial render |
| Articles nav | Clicks `[data-section="articles"]`, verifies `#sec-articles.active` |
| Screenshot 2 | `screenshots/02-articles.png` |
| News sidebar | Clicks `#btnNewsToggle`, verifies `.news-sidebar.open`, counts `.news-card` items |
| Screenshot 3 | `screenshots/03-news-sidebar.png` |
| Settings nav | Clicks `[data-section="settings"]`, verifies `#sec-settings.active` |
| Screenshot 4 | `screenshots/04-settings.png` |
| Home restore | Clicks `[data-section="home"]`, verifies `#sec-home.active` |
| Console audit | Filters expected errors (CDN 404 when offline, SW 404 from GitHub Pages path prefix) |
| Screenshot 5 | `screenshots/05-homepage-scrolled.png` — scrolled view |

Screenshots → `screenshots/` at repo root.

Exit code 0 = all checks passed. Non-zero = failures.

## Direct invocation (unit-test style)

For PRs touching individual JS modules — import the function under test
in a Node script. The modules are IIFE-wrapped (`(function() { … })()`)
and attach to `window`, so you need a browser-like environment. Use
Playwright's `page.evaluate()` to call into them:

```js
// Example: test the news cache TTL logic via page.evaluate
const ttl = await page.evaluate(() => {
  // anime-news.js exposes internal constants on window for testing
  // Check the current cache age
  const raw = localStorage.getItem('animeNewsCache');
  if (!raw) return null;
  const data = JSON.parse(raw);
  return { age: Date.now() - data.ts, date: data.date, count: data.news.length };
});
```

The simpler path for most module changes is still the full driver —
it verifies the module works in context by clicking the section it
powers.

## Run (human path)

Open `index.html` directly in a browser, or serve the repo root:

```bash
python3 -m http.server 8000
# → open http://localhost:8000
```

Note: the service worker registration hard-codes `/personal-site/sw.js`
(GitHub Pages path). Locally this 404s — harmless, caches won't work
but everything else does.

## Test

No automated test suite. The driver IS the smoke test.

```bash
node .claude/skills/run-personal-site/driver.mjs
# Expected: "All checks passed ✓" with exit code 0
```

## Gotchas

- **Service Worker path is hard-coded to `/personal-site/sw.js`** —
  correct for GitHub Pages, 404s locally. The driver filters this from
  the console audit. If you change the repo name, update the path in
  `js/main.js` line 133.
- **Supabase CDN script may 404 without internet** — the page loads
  `supabase-js` from `cdn.jsdelivr.net`. In offline/headless, this
  fails and the site runs in fully-offline guest mode (localStorage +
  IndexedDB + JSON fallbacks). News still loads from
  `data/anime-news.json`.
- **BGM `desir.mp3` auto-plays on load** — `python3 -m http.server`
  handles range requests correctly, so the `<audio>` element works.
  Browsers may block autoplay; the driver doesn't depend on audio
  actually playing.
- **Wallpapers are preloaded aggressively** — all 6 `.webp` images
  (~1MB each) are fetched in the first few seconds. On slow
  connections this delays `waitForSelector` — the driver's 3s
  timeouts account for this.
- **`findPort` in the driver auto-increments** if the default port is
  busy — the port used may differ from what you passed. Check the
  console output for the actual port.
- **CSP blocks inline scripts** — the Content-Security-Policy in
  `index.html` allows `'self'`, `cdn.jsdelivr.net`, and
  `nskircwzcsmbkispshif.supabase.co`. Any new external dependency
  must be added to the CSP header.

## Troubleshooting

- **`Server not ready at … after 15000ms`**: the `python3` binary
  isn't on PATH, or the CWD is wrong. Verify `python3 --version` and
  that you're in the repo root.
- **`Cannot find module 'playwright'`**: run `npm install` first.
  Playwright is in `devDependencies`.
- **`browserType.launch: Executable doesn't exist`**: run
  `npx playwright install chromium` to download the browser binary.
- **All checks pass but screenshots are blank/black**: the viewport
  might be rendering before CSS loads. Increase the initial
  `waitForTimeout` in the driver (currently 1500ms after
  `domcontentloaded`).
- **News cards show 0**: the Supabase fetch failed (expected offline)
  AND `data/anime-news.json` is missing or invalid. Check the file
  exists and is valid JSON.
