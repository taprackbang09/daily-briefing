// sources.config.js
//
// List of news/content sources for the daily briefing generator.
// Edit this file to add, remove, or tweak sources — no need to touch the
// main script.
//
// Each entry:
//   name         - Display name, shown in section headers and the sources list.
//   url          - RSS/Atom feed URL. Tried first, every run.
//   minItems     - If the RSS feed returns fewer than this many items within
//                  the last HOURS_BACK hours, and fallbackType is 'scrape',
//                  the script tries scraping the homepage instead. Default: 1.
//   fallbackType - 'scrape' to fall back to homepage scraping, 'rss' to try
//                  an alternate feed URL (altUrl) instead. Omit if the RSS
//                  feed alone is reliable enough.
//   fallbackUrl  - Homepage URL to scrape when fallbackType is 'scrape'.
//   altUrl       - Alternate feed URL to try when fallbackType is 'rss'.
//   scrapeRules  - Only used when scraping. Controls which links on the
//                  homepage count as articles:
//                    includePathContains   - link path must contain one of
//                                             these substrings (e.g. '/news/')
//                    excludePathStartsWith - link path must NOT start with
//                                             any of these (e.g. '/tag/')
//                    excludePathContains   - link path must NOT contain any
//                                             of these substrings
//                    minTitleLength        - minimum link text length to be
//                                             treated as a real headline
//                                             (filters out nav/menu links)
//                    dateFallbackRegex     - OPTIONAL. Only set this if the
//                                             site prints a plain-text date
//                                             (no <meta>/<time> markup) near
//                                             the top of each article, and
//                                             you've confirmed the pattern
//                                             only matches the real publish
//                                             date, not e.g. a footer
//                                             copyright year or a date on a
//                                             "related articles" teaser. Used
//                                             only for that source — never
//                                             applied globally. Must have
//                                             (dd)(mm)(yyyy) capture groups.
//
// To add a new source:
//   1. Find its RSS feed URL (usually /feed/, /rss, or /feeds/posts.atom).
//   2. Add an entry with just { name, url } and run the script once.
//   3. If it logs "0 RSS item(s)" often, add fallbackType: 'scrape',
//      fallbackUrl: '<homepage>', and scrapeRules tuned to that site's
//      URL structure (open the homepage, inspect a few article links).

module.exports = [
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
      // thedefender.media has no <meta>/<time> publish-date markup; it just
      // prints a DD.MM.YYYY date near the top of the article body. Scoped
      // to this source only — see the note on dateFallbackRegex above.
      dateFallbackRegex: /\b(\d{2})\.(\d{2})\.(\d{4})\b/,
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
  {
    name: 'NV.ua',
    url: 'https://nv.ua/ukr/rss/all.xml',
    minItems: 1,
  },
  // 'Українська правда' (pravda.com.ua) removed: its RSS endpoint sits
  // behind a Cloudflare JS bot-management challenge ("Just a moment...",
  // cf-mitigated: challenge header). A plain fetch() can never pass this —
  // it requires executing Cloudflare's challenge script like a real
  // browser would. Re-add only if you find an unprotected alternate feed
  // path, or wire up a headless-browser fetch (Playwright) just for this
  // source.
];