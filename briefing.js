#!/usr/bin/env node
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { load } = require('cheerio');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOURCES = [
  {
    name: 'Мілітарний',
    url: 'https://militarnyi.com/uk/feed/',
    fallbackType: 'scrape',
    fallbackUrl: 'https://militarnyi.com/uk/',
    minItems: 5,
    scrapeRules: {
      includePathContains: ['/uk/news/', '/news/'],
      excludePathStartsWith: ['/uk/tag/', '/tag/', '/uk/author/', '/author/', '/category/'],
      minTitleLength: 18,
    },
  },
  {
    name: 'DOU',
    url: 'https://dou.ua/feed/',
    minItems: 1,
  },
  {
    name: 'Mezha.ua',
    url: 'https://mezha.ua/feed/',
    fallbackType: 'scrape',
    fallbackUrl: 'https://mezha.ua/',
    minItems: 5,
    scrapeRules: {
      includePathContains: ['/post/', '/news/', '/article/'],
      excludePathStartsWith: ['/tag/', '/author/', '/category/'],
      minTitleLength: 18,
    },
  },
  {
    name: 'Бабель',
    url: 'https://babel.ua/rss',
    fallbackType: 'scrape',
    fallbackUrl: 'https://babel.ua/',
    minItems: 1,
    scrapeRules: {
      includePathContains: ['/news/', '/probono/'],
      excludePathStartsWith: ['/tag/', '/tags/', '/authors/', '/author/', '/category/'],
      minTitleLength: 18,
    },
  },
  {
    name: 'The Defender',
    url: 'https://thedefender.media/uk/feed/',
    fallbackType: 'scrape',
    fallbackUrl: 'https://thedefender.media/uk/',
    minItems: 1,
    scrapeRules: {
      includePathContains: ['/uk/'],
      excludePathStartsWith: ['/uk/tag/', '/uk/tags/', '/uk/author/', '/uk/authors/', '/uk/category/'],
      minTitleLength: 18,
    },
  },
  {
    name: 'Village',
    url: 'https://www.village.com.ua/feeds/posts.atom',
    minItems: 1,
  },
  {
    name: 'The War Zone',
    url: 'https://www.twz.com/feed',
    minItems: 1,
  },
];

const MAX_ITEMS = 30;
const HOURS_BACK = 24;
const CUTOFF_MS = HOURS_BACK * 60 * 60 * 1000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
const CONCURRENCY = 3;

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
    } catch {
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
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

  return { name: source.name, items, mode };
}

// ---------------------------------------------------------------------------
// AI summarization
// ---------------------------------------------------------------------------

async function generateBriefing(sourceData) {
  const blocks = sourceData
    .filter((s) => s.items.length > 0)
    .map(
      (s) =>
        `## ${s.name}\n` +
        s.items
          .map((i) => `- ${i.title}${i.summary ? ` — ${i.summary}` : ''} [джерело](${i.url})`)
          .join('\n')
    )
    .join('\n\n');

  if (!blocks) return '⚠️ Немає новин за останні 24 години.';

  const model = genAI.getGenerativeModel(
    { model: 'gemini-3.5-flash' },
    { apiVersion: 'v1' }
  );

  const prompt = `Ти — редактор щоденного новинного дайджесту українською.

Правила:
- Відповідай ЛИШЕ markdown.
- Структура:
  1) ## 🔥 Головне (3–6 пунктів)
  2) Тематичні секції (лише доречні)
- Кожен пункт: одне коротке речення + [↗](url)
- Без дублювань, без вигадок, без повторів між секціями.
- Якщо одна новина є в різних джерелах — об'єднай в один пункт.

Дані:
${blocks}`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error(`Gemini error: ${err.message}`);
    return `## 🔥 Головне\n- Не вдалося згенерувати AI-дайджест. Нижче сирі заголовки.\n\n${blocks}`;
  }
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function renderMarkdownSafe(md) {
  const raw = marked.parse(md);
  return sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2']),
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}

function buildHtml(markdown, todayStr) {
  const briefingHtml = renderMarkdownSafe(markdown);
  const dateLabel = new Date().toLocaleDateString('uk-UA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Брифінг — ${todayStr}</title>
  <style>
    body { max-width: 760px; margin: 40px auto; padding: 0 16px; font-family: Georgia, serif; line-height: 1.6; color: #222; }
    h1 { margin-bottom: 20px; }
    h2 { margin-top: 28px; }
    a { color: #b35a1f; text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul { padding-left: 20px; }
    li { margin: 8px 0; }
    footer { margin-top: 40px; font-size: 12px; color: #777; }
  </style>
</head>
<body>
  <h1>${dateLabel}</h1>
  ${briefingHtml}
  <footer>Generated via Gemini · Sources: ${SOURCES.length} · Window: ${HOURS_BACK}h</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let idx = 0;

  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= arr.length) break;
      out[i] = await fn(arr[i], i);
    }
  });

  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🗞️ Starting briefing generation...');

  const results = await mapLimit(SOURCES, CONCURRENCY, async (source) => {
    try {
      return await collectSourceItems(source);
    } catch (err) {
      console.error(`  ✗ ${source.name}: ${err.message}`);
      return { name: source.name, items: [], mode: 'error' };
    }
  });

  const totalItems = results.reduce((sum, s) => sum + s.items.length, 0);

  console.log(`📦 Total items: ${totalItems}`);
  for (const r of results) {
    console.log(`  - ${r.name}: ${r.items.length} (${r.mode})`);
  }

  const markdown = await generateBriefing(results);

  const todayStr = new Date().toISOString().slice(0, 10);
  const html = buildHtml(markdown, todayStr);

  const briefingDir = path.join(__dirname, 'briefing');
  fs.mkdirSync(briefingDir, { recursive: true });

  const outPath = path.join(briefingDir, `${todayStr}.html`);
  fs.writeFileSync(outPath, html, 'utf8');

  const redirect = (target) =>
    `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${target}"></head></html>`;

  fs.writeFileSync(path.join(__dirname, 'index.html'), redirect(`briefing/${todayStr}.html`), 'utf8');
  fs.writeFileSync(path.join(briefingDir, 'index.html'), redirect(`${todayStr}.html`), 'utf8');

  fs.writeFileSync(
    path.join(briefingDir, 'latest.json'),
    JSON.stringify(
      {
        date: todayStr,
        totalItems,
        sources: results.map((r) => ({
          name: r.name,
          mode: r.mode,
          count: r.items.length,
        })),
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`✅ Done! ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});