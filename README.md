# Daily Briefing

Automated daily news briefing generator. It fetches recent articles from a
configurable list of Ukrainian and international sources, summarizes them with
Google Gemini into a single readable page (in Ukrainian), and publishes the
result as static HTML — designed to run unattended on GitHub Actions and be
served via GitHub Pages.

## How it works

Each run (`node briefing.js`):

1. **Collect** — loads every source in [`sources.config.js`](sources.config.js)
   and fetches its RSS/Atom feed. If a feed is missing or returns too few fresh
   items, it can fall back to scraping the site's homepage.
2. **Filter** — keeps only items published within the last **24 hours**
   (`HOURS_BACK`), verifies real publish dates for scraped items, and drops
   URLs already seen in the last few days (`HISTORY_DAYS`) so the same story
   doesn't reappear.
3. **Summarize** — sends the collected items to Gemini and asks for a single
   consolidated briefing. Multiple models are tried in order with automatic
   fallback (`GEMINI_MODELS`).
4. **Publish** — writes `briefing/YYYY-MM-DD.html`, updates `index.html`
   (redirect to the latest page), refreshes prev/next navigation across all
   pages, records `latest.json`, and rotates out pages older than
   `ROTATION_DAYS` (60 days).

If **no** items are collected from any source (e.g. a network outage), the run
aborts without writing, so the previously published briefing stays live.

### Per-source status

The footer of each briefing lists all sources with a status badge, so a broken
feed is visible on the page itself (not just in the CI logs):

| Badge | Meaning |
|-------|---------|
| `✓ N` | Fetched and contributed N fresh items (RSS or scrape, shown in tooltip) |
| `○`   | Fetched fine, but no fresh items in the window / all deduplicated |
| `✗`   | Fetch or parse failed (network error, block, dead feed) |

## Project layout

```
briefing.js          Main script (fetch → filter → summarize → publish)
sources.config.js    List of news sources (edit this to add/remove sources)
briefing/            Generated HTML pages, history.json, latest.json
index.html           Root redirect to the latest briefing
.github/workflows/   Scheduled GitHub Actions workflow
```

## Requirements

- **Node.js 18+** (uses global `fetch` / `AbortSignal.timeout`; CI runs Node 24)
- A **Google Gemini API key**

## Setup

```bash
npm install
```

Create a `.env` file in the project root (it is gitignored):

```
GEMINI_API_KEY=your_key_here
```

## Usage

```bash
node briefing.js
```

This generates today's briefing under `briefing/` and updates `index.html`.

## Configuration

### Sources

Edit [`sources.config.js`](sources.config.js). Each entry:

| Field | Description |
|-------|-------------|
| `name` | Display name shown in section headers and the sources list |
| `url` | RSS/Atom feed URL (tried first, every run) |
| `site` | Human-facing website URL used for the footer link (optional) |
| `minItems` | If the feed returns fewer fresh items than this and a scrape fallback exists, try scraping. Default: 1 |
| `fallbackType` | `'scrape'` (homepage) or `'rss'` (alternate feed via `altUrl`) |
| `fallbackUrl` | Homepage URL to scrape when `fallbackType: 'scrape'` |
| `altUrl` | Alternate feed URL when `fallbackType: 'rss'` |
| `scrapeRules` | Controls which homepage links count as articles (path filters, min title length, optional date regex) |

To add a source: add `{ name, url }`, run once, and if the RSS feed is
unreliable add `fallbackType: 'scrape'` with `fallbackUrl` and tuned
`scrapeRules`. See the comments at the top of the config file for full details.

### Tuning constants

Defined at the top of [`briefing.js`](briefing.js):

| Constant | Default | Purpose |
|----------|---------|---------|
| `HOURS_BACK` | 24 | Freshness window for included articles |
| `MAX_ITEMS` | 30 | Max items per source passed to the model |
| `HISTORY_DAYS` | 5 | How long a seen URL is remembered for dedup |
| `ROTATION_DAYS` | 60 | How long generated pages are kept on disk |
| `CONCURRENCY` | 3 | Parallel source fetches |
| `GEMINI_MODELS` | — | Models tried in order with fallback |

## Automation (GitHub Actions)

[`.github/workflows/daily-briefing.yml`](.github/workflows/daily-briefing.yml)
runs the script on a daily schedule (and on manual dispatch), then commits and
pushes the generated pages back to the repo. It requires a repository secret:

- `GEMINI_API_KEY`

The `contents: write` permission lets the workflow push the updated HTML. Enable
GitHub Pages on the repo to serve `index.html` / the `briefing/` pages.

> Note: GitHub's scheduled events sit in a shared queue and can be delayed,
> worst at the top of the hour. The cron uses an odd minute (`:17`) to dodge
> that congestion. Cron is always UTC and does not follow local DST.

## License

Personal project — no license specified.
