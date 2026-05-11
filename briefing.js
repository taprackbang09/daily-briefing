#!/usr/bin/env node

require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { load } = require('cheerio');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOURCES = [
  { name: 'Мілітарний',  url: 'https://mil.in.ua/uk/feed/' },
  { name: 'DOU',         url: 'https://dou.ua/lenta/feeds/news/' },
  { name: 'Mezha.ua',    url: 'https://mezha.ua/feed/' },
  { name: 'Бабель',      url: 'https://babel.ua/rss' },
  { name: 'The Defender',url: 'https://thedefender.media/uk/feed/' },
  { name: 'Village',     url: 'https://www.village.com.ua/feed' },
  { name: 'The War Zone',url: 'https://www.twz.com/feed' },
];

const MAX_ITEMS     = 30;           // per source, before 24 h filter
const HOURS_BACK    = 24;
const CUTOFF_MS     = HOURS_BACK * 60 * 60 * 1000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchFeed(source) {
  console.log(`  Fetching ${source.name} …`);
  try {
    const resp = await fetch(source.url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; DailyBriefingBot/2.0)',
        'Accept':          'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.error(`  ✗ ${source.name}: HTTP ${resp.status}`);
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.error(`  ✗ ${source.name}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse — handles both RSS 2.0 and Atom feeds
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and collapse whitespace from a string.
 */
function stripHtml(str = '') {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s\s+/g, ' ').trim();
}

/**
 * Try every common date field and return a Date (or null if unparseable).
 */
function parseDate($el, $) {
  const raw =
    $el.find('pubDate').first().text() ||
    $el.find('published').first().text() ||
    $el.find('updated').first().text() ||
    $el.find('dc\\:date, date').first().text();

  if (!raw) return null;
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? null : d;
}

function parseFeed(xml, sourceName) {
  const $ = load(xml, { xmlMode: true });
  const now  = Date.now();
  const items = [];
  const seen  = new Set();

  // Support both RSS <item> and Atom <entry>
  $('item, entry').each((_, el) => {
    const $el = $(el);

    // Title
    const title = stripHtml($el.find('title').first().text()).replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    if (!title || title.length < 10 || seen.has(title)) return;

    // URL — try multiple fields
    const url =
      $el.find('link[href]').first().attr('href') ||       // Atom <link href="…"/>
      $el.find('link').first().text().trim() ||             // RSS <link>
      $el.find('guid').first().text().trim() ||             // RSS <guid>
      '';

    // Published date
    const pubDate = parseDate($el, $);
    if (pubDate && (now - pubDate.getTime()) > CUTOFF_MS) return; // older than cutoff

    // Summary / description for richer AI context
    const summary = stripHtml(
      $el.find('summary, description, content\\:encoded').first().text()
    ).slice(0, 300);

    if (!url) return;
    seen.add(title);
    items.push({ title, url, summary, pubDate });
  });

  console.log(`  ✓ ${sourceName}: ${items.length} item(s) in last ${HOURS_BACK}h`);
  return items.slice(0, MAX_ITEMS);
}

// ---------------------------------------------------------------------------
// AI summarisation
// ---------------------------------------------------------------------------

async function generateBriefing(sourceData) {
  const parts = sourceData
    .filter(s => s.items.length > 0)
    .map(s =>
      `## ${s.name}\n` +
      s.items
        .map(i => `- ${i.title}${i.summary ? ' — ' + i.summary : ''} [link](${i.url})`)
        .join('\n')
    )
    .join('\n\n');

  if (!parts) return '⚠️ No news items found in the last 24 hours.';

  const model = genAI.getGenerativeModel(
    { model: 'gemini-2.5-flash' },
    { apiVersion: 'v1' }
  );

  const prompt = `Ти — персональний news curator. Зроби стислий daily briefing українською мовою на основі новин за останні 24 години.

Структура відповіді:
1. **## 🔥 Головне** — 3–6 найважливіших подій. Якщо одна тема присутня в кількох джерелах — об'єднай в один пункт.
2. Тематичні секції (наприклад: **## 🛡️ Оборона та безпека**, **## 💻 Технології**, **## 🌍 Світ**, **## 🇺🇦 Україна**, **## 🔬 Наука & Суспільство** — використовуй лише ті, що доречні).
3. Кожен пункт — одне речення + посилання у форматі [↗](url).
4. Не повторюй новини між секціями.
5. Відповідай ЛИШЕ markdown, без додаткових пояснень.

Дані джерел:\n${parts}`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error('Gemini error:', err.message);
    return `**AI Error:** ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function buildHtml(briefingMarkdown, todayStr) {
  const briefingHtml = marked(briefingMarkdown);
  const dateLabel = new Date().toLocaleDateString('uk-UA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Брифінг — ${todayStr}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      background: #faf8f3;
      color: #2b2620;
      line-height: 1.7;
      min-height: 100vh;
    }

    .page {
      max-width: 700px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }

    header {
      border-bottom: 3px double #c47a3a;
      padding-bottom: 20px;
      margin-bottom: 36px;
    }

    .label {
      font-family: 'Courier New', monospace;
      font-size: 0.68rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #c47a3a;
      margin-bottom: 8px;
    }

    header h1 {
      font-size: 1.9rem;
      font-weight: 700;
      line-height: 1.2;
      color: #1a1410;
    }

    .content h2 {
      font-family: 'Courier New', monospace;
      font-size: 0.75rem;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #c47a3a;
      margin: 36px 0 14px;
      padding-bottom: 6px;
      border-bottom: 1px solid #e8e0d0;
    }

    .content ul {
      list-style: none;
      padding: 0;
    }

    .content li {
      position: relative;
      padding: 10px 0 10px 20px;
      border-bottom: 1px solid #f0ebe0;
      font-size: 0.97rem;
    }

    .content li::before {
      content: "▸";
      position: absolute;
      left: 0;
      color: #c47a3a;
      font-size: 0.8rem;
      top: 12px;
    }

    .content li:last-child { border-bottom: none; }

    .content a {
      color: #c47a3a;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.85em;
      margin-left: 4px;
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s;
    }

    .content a:hover { border-color: #c47a3a; }

    .content p { margin: 8px 0; font-size: 0.97rem; }

    footer {
      margin-top: 60px;
      padding-top: 20px;
      border-top: 1px solid #e0d8cc;
      text-align: center;
      font-family: 'Courier New', monospace;
      font-size: 0.7rem;
      letter-spacing: 0.1em;
      color: #b0a090;
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="label">Daily Intelligence Briefing</div>
      <h1>${dateLabel}</h1>
    </header>
    <div class="content">${briefingHtml}</div>
    <footer>
      GENERATED VIA GEMINI 2.5 FLASH &nbsp;·&nbsp; SOURCES: ${SOURCES.length} RSS FEEDS &nbsp;·&nbsp; WINDOW: LAST ${HOURS_BACK}H
    </footer>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🗞️  Starting briefing generation …\n');

  const results = await Promise.all(
    SOURCES.map(async (source) => {
      try {
        const xml   = await fetchFeed(source);
        const items = xml ? parseFeed(xml, source.name) : [];
        if (!xml) console.log(`  ✓ ${source.name}: skipped (fetch failed)`);
        return { name: source.name, items };
      } catch (err) {
        console.error(`  ✗ ${source.name}: unexpected — ${err.message}`);
        return { name: source.name, items: [] };
      }
    })
  );

  const totalItems = results.reduce((n, s) => n + s.items.length, 0);
  console.log(`\n📦 Total items collected: ${totalItems}`);

  console.log('\n🧠 Gemini is summarising …');
  const briefingMarkdown = await generateBriefing(results);

  const todayStr = new Date().toISOString().split('T')[0];
  const html     = buildHtml(briefingMarkdown, todayStr);

  // Write output files
  const briefingDir = path.join(__dirname, 'briefing');
  if (!fs.existsSync(briefingDir)) fs.mkdirSync(briefingDir, { recursive: true });

  const outPath = path.join(briefingDir, `${todayStr}.html`);
  fs.writeFileSync(outPath, html);

  // Redirect index files
  const redirectHtml = (target) =>
    `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${target}"></head></html>`;
  fs.writeFileSync(path.join(__dirname, 'index.html'), redirectHtml(`briefing/${todayStr}.html`));
  fs.writeFileSync(path.join(briefingDir, 'index.html'), redirectHtml(`${todayStr}.html`));

  console.log(`\n✅ Done! → ${outPath}`);
}

main().catch(console.error);
