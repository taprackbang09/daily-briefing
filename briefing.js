#!/usr/bin/env node

require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { load } = require('cheerio');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');

// --- Конфігурація ---
const SOURCES = [
  { name: 'Мілітарний', url: 'https://mil.in.ua/uk/', extract: 'generic' },
  { name: 'DOU', url: 'https://dou.ua/', extract: 'dou' },
  { name: 'Mezha.ua', url: 'https://mezha.ua/feed/', extract: 'rss' },
  { name: 'Бабель', url: 'https://babel.ua/', extract: 'generic' },
  { name: 'The Defender', url: 'https://thedefender.media/uk/', extract: 'generic' },
  { name: 'Village', url: 'https://www.village.com.ua/', extract: 'generic' },
  { name: 'The War Zone', url: 'https://www.twz.com/', extract: 'generic' }
];

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Скрейпер ---
async function fetchPage(source) {
  console.log(`  Отримання ${source.name}...`);
  try {
    const resp = await fetch(source.url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'uk-UA,uk;q=0.9'
      },
      signal: AbortSignal.timeout(15000),
    });
    return resp.ok ? await resp.text() : null;
  } catch (err) {
    console.error(`  ✗ ${source.name}: ${err.message}`);
    return null;
  }
}

function extractContent(html, method) {
  const $ = load(html, { xmlMode: method === 'rss' });
  $('script, style, nav, footer, header, aside, .sidebar').remove();
  
  const items = [];
  const seen = new Set();

  if (method === 'dou') {
    $('.item a, .b-lenta li a').each((_, el) => {
      const title = $(el).text().trim();
      const url = $(el).attr('href');
      if (title.length > 15 && !seen.has(title)) {
        seen.add(title);
        items.push({ title, url });
      }
    });
  } else if (method === 'rss') {
    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const url   = $(el).find('guid').text().trim()
                 || $(el).find('link').text().trim();
      if (title.length > 10 && url && !seen.has(title)) {
        seen.add(title);
        items.push({ title, url });
      }
    });
    
    // Fallback for Mezha.ua: if RSS extraction failed, try HTML-based extraction
    if (items.length === 0 && html.includes('mezha')) {
      const $ = load(html);
      $('h2 a, h3 a, .entry-title a, .post-title a, a[href*="news"]').each((_, el) => {
        const title = $(el).text().trim();
        const url = $(el).attr('href');
        if (title.length > 10 && url && !seen.has(title)) {
          seen.add(title);
          items.push({ 
            title, 
            url: url.startsWith('http') ? url : 'https://mezha.ua' + url 
          });
        }
      });
    }
  } else if (method === 'mezha') {
    $('h2 a, h3 a, .entry-title a, .post-title a, a[href*="news"]').each((_, el) => {
      const title = $(el).text().trim();
      const url = $(el).attr('href');
      if (title.length > 10 && url && !seen.has(title)) {
        seen.add(title);
        items.push({ 
          title, 
          url: url.startsWith('http') ? url : 'https://mezha.ua' + url 
        });
      }
    });
  } else {
    $('article, .post, .card, h2, h3').each((_, el) => {
      const title = $(el).text().replace(/\s\s+/g, ' ').trim();
      const url = $(el).find('a').attr('href') || $(el).closest('a').attr('href');
      
      if (title.length > 20 && title.length < 300 && url && !seen.has(title)) {
        seen.add(title);
        items.push({ title, url: url.startsWith('http') ? url : '' });
      }
    });
  }
  return items.slice(0, 15);
}

// --- AI ---
async function generateBriefing(sourceData) {
  const parts = sourceData
    .filter(s => s.items.length > 0)
    .map(s => `## ${s.name}\n` + s.items.map(i => `- ${i.title} [link](${i.url})`).join('\n'))
    .join('\n\n');

  if (!parts) return "Немає новин.";

  const model = genAI.getGenerativeModel(
    { model: "gemini-2.5-flash" },
    { apiVersion: 'v1' }
  );

  const prompt = `Ти — персональний news curator. Зроби стислий daily briefing українською мовою.
1. "## Головне" — 3-5 найважливіших новин.
2. Тематичні секції з bullet points.
3. Кожна новина закінчується [↗](url).
Дані:\n${parts}`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    return "AI Error: " + err.message;
  }
}

// --- Main ---
async function main() {
  console.log('🗞️  Запуск генерації...\n');
  const results = await Promise.all(SOURCES.map(async (s) => {
    const html = await fetchPage(s);
    const items = html ? extractContent(html, s.extract) : [];
    console.log(`  ✓ ${s.name}: знайдено ${items.length} ел.`);
    return { name: s.name, items };
  }));

  console.log('\n🧠 Gemini готує підсумок...');
  const briefingMarkdown = await generateBriefing(results);
  const briefingHtml = marked(briefingMarkdown);
  const todayStr = new Date().toISOString().split('T')[0];

  const html = `<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Daily Briefing — ${todayStr}</title>
    <style>
        body { font-family: -apple-system, sans-serif; background: #faf8f5; color: #333; line-height: 1.6; max-width: 650px; margin: 40px auto; padding: 0 20px; }
        h1 { border-bottom: 2px solid #e16a3d; padding-bottom: 10px; font-size: 1.5rem; }
        h2 { color: #e16a3d; font-size: 1.1rem; text-transform: uppercase; margin-top: 1.5rem; letter-spacing: 1px; }
        ul { list-style: none; padding: 0; }
        li { margin-bottom: 12px; padding-left: 18px; position: relative; }
        li::before { content: "•"; position: absolute; left: 0; color: #e16a3d; font-weight: bold; }
        a { color: #c08060; text-decoration: none; font-weight: bold; margin-left: 5px; }
    </style>
</head>
<body>
    <h1>БРИФІНГ ЗА ${new Date().toLocaleDateString('uk-UA')}</h1>
    <div class="content">${briefingHtml}</div>
    <div style="margin-top: 40px; font-size: 0.8rem; color: #999; text-align: center;">Generated via Gemini 2.5 Flash</div>
</body>
</html>`;

  const briefingDir = path.join(__dirname, 'briefing');
  if (!fs.existsSync(briefingDir)) fs.mkdirSync(briefingDir);
  
  // 1. Записуємо файл щоденного звіту в папку briefing/
  const dailyFilePath = path.join(briefingDir, `${todayStr}.html`);
  fs.writeFileSync(dailyFilePath, html);

  // 2. Записуємо файл редиректу index.html в КОРЕНЕВУ директорію
  // Додаємо 'briefing/' до URL в мета-тегу
  const indexHtml = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=briefing/${todayStr}.html"></head></html>`;
  fs.writeFileSync(path.join(__dirname, 'index.html'), indexHtml);
  
  console.log(`\n✨ Готово!`);
  console.log(`📁 Звіт: briefing/${todayStr}.html`);
  console.log(`🚀 Редирект створено в корені: index.html`);
}

main().catch(console.error);