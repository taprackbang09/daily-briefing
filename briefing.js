#!/usr/bin/env node
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { load } = require('cheerio');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Runtime check — fetch / AbortSignal.timeout require Node 18+
// ---------------------------------------------------------------------------

const [NODE_MAJOR] = process.versions.node.split('.').map(Number);
if (NODE_MAJOR < 18) {
  console.error(`❌ Node 18+ required (fetch/AbortSignal.timeout). Current: ${process.versions.node}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOURCES = require('./sources.config.js');

for (const s of SOURCES) {
  if (!s.name || !s.url) {
    throw new Error(`sources.config.js: entry missing name/url: ${JSON.stringify(s)}`);
  }
}

const MAX_ITEMS = 30;
const HOURS_BACK = 24;
const CUTOFF_MS = HOURS_BACK * 60 * 60 * 1000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
const CONCURRENCY = 3;

// How many days a previously-seen URL is remembered and excluded from
// future briefings, to stop scraped (dateless) homepage items from
// reappearing day after day.
const HISTORY_DAYS = 5;

// How many days of generated briefing pages to keep on disk before
// deleting them. Independent from HISTORY_DAYS (that's for dedup).
const ROTATION_DAYS = 60;

// Cap how many scraped items get an extra per-article fetch to verify
// their real publish date. Keeps runtime bounded on sources that return
// a lot of scrape candidates.
const MAX_DATE_VERIFICATIONS_PER_SOURCE = 20;

// Supported Gemini models with fallback chain
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.0-flash'];

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY is missing in .env');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripHtml(str = '') {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(raw, base = null) {
  if (!raw) return '';
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'mc_cid',
      'mc_eid',
    ].forEach((p) => u.searchParams.delete(p));
    u.hash = '';
    return u.href;
  } catch {
    return String(raw).trim();
  }
}

function parseDate($el) {
  const raw =
    $el.find('pubDate').first().text() ||
    $el.find('published').first().text() ||
    $el.find('updated').first().text() ||
    $el.find('dc\\:date, date').first().text() ||
    $el.find('time').first().attr('datetime') ||
    '';
  if (!raw) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function shouldExcludePath(pathname, rules = {}) {
  const p = pathname.toLowerCase();

  if (rules.excludePathStartsWith?.some((x) => p.startsWith(x.toLowerCase()))) return true;
  if (rules.excludePathContains?.some((x) => p.includes(x.toLowerCase()))) return true;

  if (rules.includePathContains?.length) {
    if (!rules.includePathContains.some((x) => p.includes(x.toLowerCase()))) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Fetch with retries
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; DailyBriefingBot/4.0)',
    'Accept':
      'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*',
    'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
    ...options.headers,
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        ...options,
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });

      if ([403, 404, 410].includes(resp.status)) {
        return { text: null, status: resp.status };
      }

      if (!resp.ok) {
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        return { text: null, status: resp.status };
      }

      return { text: await resp.text(), status: resp.status };
    } catch (err) {
      const isLastAttempt = attempt >= retries;
      if (!isLastAttempt) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
        console.error(`  ⚠️ Fetch error after ${attempt + 1} attempt(s): ${err.message}`);
        return { text: null, status: null };
      }
    }
  }

  return { text: null, status: null };
}

// ---------------------------------------------------------------------------
// Fetch dispatcher
// ---------------------------------------------------------------------------

async function fetchSource(source) {
  const primary = await fetchWithRetry(source.url);
  if (primary.text) return { text: primary.text, mode: 'rss', status: primary.status };

  if (!source.fallbackUrl) return null;

  if (source.fallbackType === 'rss' && source.altUrl) {
    const alt = await fetchWithRetry(source.altUrl);
    if (alt.text) return { text: alt.text, mode: 'rss', status: alt.status };
  }

  if (source.fallbackType === 'scrape') {
    const html = await fetchWithRetry(source.fallbackUrl);
    if (html.text) return { text: html.text, mode: 'scrape', status: html.status };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parse RSS/Atom
// ---------------------------------------------------------------------------

function parseFeed(xml, sourceName, sourceUrl = '') {
  try {
    const $ = load(xml, { xmlMode: true });
    const now = Date.now();
    const items = [];
    const seen = new Set();

    $('item, entry').each((_, el) => {
      const $el = $(el);

      const title = stripHtml($el.find('title').first().text())
        .replace(/^<!\[CDATA\[|\]\]>$/g, '')
        .trim();

      if (!title || title.length < 8 || seen.has(title)) return;

      let url =
        $el.find('link[rel="alternate"]').attr('href') ||
        $el.find('link[href]').first().attr('href') ||
        $el.find('link').first().text().trim() ||
        $el.find('guid').first().text().trim() ||
        '';
      url = normalizeUrl(url, sourceUrl);

      const pubDate = parseDate($el);
      if (pubDate && now - pubDate.getTime() > CUTOFF_MS) return;

      const rawSummary =
        $el.find('summary').first().text() ||
        $el.find('description').first().text() ||
        $el.find('content\\:encoded').first().text() ||
        $el.find('content').first().text() ||
        '';

      const summary = stripHtml(rawSummary).slice(0, 320);

      seen.add(title);
      items.push({
        title,
        url,
        summary,
        pubDate: pubDate ? pubDate.toISOString() : null,
      });
    });

    console.log(`  ✓ ${sourceName}: ${items.length} RSS item(s)`);
    return items.slice(0, MAX_ITEMS);
  } catch (err) {
    console.error(`  ✗ ${sourceName} parseFeed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scrape fallback
// ---------------------------------------------------------------------------

function scrapeHomepage(html, sourceName, baseUrl, rules = {}) {
  try {
    const $ = load(html);
    const base = new URL(baseUrl);
    const items = [];
    const seen = new Set();

    const minTitleLength = rules.minTitleLength ?? 18;

    $('a').each((_, el) => {
      const $el = $(el);
      const title = $el.text().replace(/\s+/g, ' ').trim();
      const rawHref = $el.attr('href');

      if (!title || title.length < minTitleLength) return;
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;

      const fullUrl = normalizeUrl(rawHref, base.href);
      if (!fullUrl) return;
      if (!fullUrl.startsWith(base.origin)) return;

      let u;
      try {
        u = new URL(fullUrl);
      } catch {
        return;
      }

      const pathname = u.pathname || '/';
      const segments = pathname.split('/').filter(Boolean);

      if (segments.length < 2) return; // reduce nav/root links
      if (shouldExcludePath(pathname, rules)) return;

      const key = `${title}|${pathname}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({
        title,
        url: fullUrl,
        summary: '',
        pubDate: null,
      });
    });

    console.log(`  ✓ ${sourceName}: ${items.length} scraped item(s)`);
    return items.slice(0, MAX_ITEMS);
  } catch (err) {
    console.error(`  ✗ ${sourceName} scrape: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Date verification for scraped items
// ---------------------------------------------------------------------------
//
// scrapeHomepage() can only see a title + URL on the homepage, so every
// scraped item gets pubDate: null. That means the CUTOFF_MS freshness check
// in parseFeed() never applies to scraped items — an article that's been
// linked on a homepage for days (e.g. under a "related"/featured block)
// looks exactly as "fresh" as something published an hour ago. This fetches
// each scraped article's own page and looks for a real publish date, then
// drops anything that turns out to be older than HOURS_BACK.

function extractDateFromArticleHtml(html) {
  const $ = load(html);

  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[itemprop="datePublished"]',
    'time[datetime]',
  ];

  for (const sel of metaSelectors) {
    const $el = $(sel).first();
    const val = $el.attr('content') || $el.attr('datetime');
    if (val) {
      const d = new Date(val);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  // Fallback for sites (like thedefender.media) that just print a
  // DD.MM.YYYY date near the top of the article with no machine-readable
  // markup at all.
  const text = $('body').text();
  const match = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    // Validate month and day ranges before creating date
    const monthNum = parseInt(mm, 10);
    const dayNum = parseInt(dd, 10);
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
      const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  return null;
}

async function verifyScrapedItemDates(items, sourceName) {
  const toCheck = items.slice(0, MAX_DATE_VERIFICATIONS_PER_SOURCE);
  const skipped = items.slice(MAX_DATE_VERIFICATIONS_PER_SOURCE);

  const now = Date.now();
  let droppedStale = 0;

  const checked = await mapLimit(toCheck, CONCURRENCY, async (item) => {
    const res = await fetchWithRetry(item.url, {}, 1);
    if (!res.text) return item; // couldn't fetch — keep rather than drop silently

    const date = extractDateFromArticleHtml(res.text);
    if (!date) return item; // no date found — keep, can't be sure it's stale

    if (now - date.getTime() > CUTOFF_MS) {
      droppedStale++;
      return null; // confirmed stale — drop
    }

    return { ...item, pubDate: date.toISOString() };
  });

  if (droppedStale > 0) {
    console.log(`  🗑️ ${sourceName}: dropped ${droppedStale} scraped item(s) confirmed stale by article date`);
  }
  if (skipped.length > 0) {
    console.log(`  ⚠️ ${sourceName}: skipped date verification for ${skipped.length} item(s) over the ${MAX_DATE_VERIFICATIONS_PER_SOURCE}-check cap`);
  }

  return [...checked.filter(Boolean), ...skipped];
}

// ---------------------------------------------------------------------------
// Option B: RSS first, scrape if too few items
// ---------------------------------------------------------------------------

async function collectSourceItems(source) {
  const fetched = await fetchSource(source);
  if (!fetched) return { name: source.name, items: [], mode: 'none' };

  let items = [];
  let mode = fetched.mode;

  if (fetched.mode === 'rss') {
    items = parseFeed(fetched.text, source.name, source.url);

    const minItems = source.minItems ?? 1;
    if (source.fallbackType === 'scrape' && source.fallbackUrl && items.length < minItems) {
      console.log(
        `  → ${source.name}: only ${items.length} RSS item(s), trying scrape fallback...`
      );

      const alt = await fetchWithRetry(source.fallbackUrl);
      if (alt.text) {
        const scraped = scrapeHomepage(
          alt.text,
          source.name,
          source.fallbackUrl,
          source.scrapeRules || {}
        );

        const rssCount = items.length;
        const scrapedCount = scraped.length;

        if (scrapedCount > rssCount) {
          items = scraped;
          mode = 'scrape';
          console.log(`  ✓ ${source.name}: switched to scrape (${scrapedCount} > ${rssCount})`);
        } else {
          console.log(`  → ${source.name}: keeping RSS (${rssCount} >= ${scrapedCount})`);
        }
      }
    }
  } else {
    items = scrapeHomepage(
      fetched.text,
      source.name,
      source.fallbackUrl,
      source.scrapeRules || {}
    );
  }

  if (mode === 'scrape' && items.length > 0) {
    items = await verifyScrapedItemDates(items, source.name);
  }

  return { name: source.name, items, mode };
}

// ---------------------------------------------------------------------------
// Cross-day history (dedup fix)
// ---------------------------------------------------------------------------
//
// Even with date verification, history guards against anything that slips
// through (e.g. a site without a detectable date) reappearing day after day.

function historyPath(briefingDir) {
  return path.join(briefingDir, 'history.json');
}

function loadHistory(briefingDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath(briefingDir), 'utf8'));
    const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    return new Map(raw.filter(([, ts]) => ts > cutoff));
  } catch {
    return new Map();
  }
}

function saveHistory(briefingDir, historyMap) {
  fs.writeFileSync(historyPath(briefingDir), JSON.stringify([...historyMap]), 'utf8');
}

// truncated...