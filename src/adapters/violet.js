/**
 * Violet Scans adapter (violetmanga.com; violetscans.org/.com links redirect there).
 *
 * A WordPress site on the "MangaReader" theme, so everything comes from the
 * pages themselves, read as text:
 *   GET /comics/{slug}/          series info table and the full chapter list
 *   GET /{slug}-chapter-{n}/     ts_reader.run({...sources:[{images:[...]}]})
 *   GET /?s={query} (/page/N/)   search results, 10 per page
 *
 * Violet sells chapters for coins. In the chapter list a paid chapter has no
 * link at all, only a "#lockedChapterModal" button with its price
 * (data-coin), so it is marked not free there and refused before any request.
 * The site serves a paid chapter's page without reader data ("This chapter is
 * locked ... Buy now for 50 Coins"); that answer is treated as protected.
 *
 * Page order is the reader's own order, never re-sorted by file name: some
 * chapters list 0002 ... 0009 then 0001, and 0001 is the real last page
 * (closing panel and recruiting notice).
 */

import { FetchError, ProtectedContentError } from '../common/errors.js';

const SITE = 'https://violetmanga.com';
const HOSTS = ['violetmanga.com', 'www.violetmanga.com', 'violetscans.org', 'www.violetscans.org', 'violetscans.com', 'www.violetscans.com'];
const SEARCH_LIMIT = 50;
const SEARCH_MAX_PAGES = 5;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// "/serena-chapter-147/"; a decimal side chapter would read "-chapter-12-5".
const CHAPTER_PATH = /^\/(.+?)-chapter-(\d+)(?:[-.](\d+))?\/?$/;

/* ------------------------------------------------------------------ *
 * Pure helpers (no network -- unit tested outside a browser)
 * ------------------------------------------------------------------ */

export function cleanSlug(segment) {
  let slug;
  try { slug = decodeURIComponent(String(segment ?? '')); } catch { return null; }
  slug = slug.trim();
  if (!slug || slug.length > 300 || slug === '.' || slug === '..') return null;
  if (/[/\\?#\s]/.test(slug) || /\p{Cc}/u.test(slug)) return null;
  return slug;
}

/**
 * Parse a series or chapter link on any Violet host.
 *
 * Every chapter link seen (1,966 across 25 series) is "/{series slug}-chapter-N/",
 * so the series comes straight from it; getSeries still checks the chapter
 * page's own series link if that guess ever 404s.
 *
 * @returns {{seriesId: string, lang: string, episodeNo?: number, chapterPath?: string}|null}
 */
export function parseUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase())) return null;
  const series = url.pathname.match(/^\/comics\/([^/]+)\/?$/);
  if (series) {
    const seriesId = cleanSlug(series[1]);
    return seriesId ? { seriesId, lang: 'en' } : null;
  }
  const chapter = CHAPTER_PATH.exec(url.pathname);
  if (!chapter) return null;
  const seriesId = cleanSlug(chapter[1]);
  if (!seriesId) return null;
  const episodeNo = Number(chapter[3] === undefined ? chapter[2] : `${chapter[2]}.${chapter[3]}`);
  return { seriesId, lang: 'en', episodeNo, chapterPath: url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/` };
}

export function seriesUrl(slug) {
  return `${SITE}/comics/${encodeURIComponent(slug)}/`;
}

/** Decode the HTML entities WordPress emits in titles and text. */
export function decodeHtml(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

const plainText = (html) => decodeHtml(String(html ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
  .replace(/<[^>]*>/g, ''))
  .replace(/[ \t]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .trim();

function httpsUrl(value) {
  try {
    const url = new URL(decodeHtml(String(value ?? '')).trim(), SITE);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/** "October 21, 2026" -> "2026-10-21", without a time-zone shift. */
export function isoDate(text) {
  const match = /([a-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(String(text ?? ''));
  const month = match ? MONTHS.indexOf(match[1].toLowerCase()) : -1;
  if (month < 0) return '';
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

/**
 * Following remembers chapters by a numeric id. Free chapters carry none in
 * the list (only paid ones expose a post id), so the id is derived from the
 * chapter number for every chapter alike; it then stays the same when a paid
 * chapter becomes free.
 */
export const chapterIdFor = (number) => Math.round(Number(number) * 1000);

/** The value of one row ("Type", "Author", ...) of the series info table. */
function infoRow(html, label) {
  const match = new RegExp(`<h1>\\s*${label}\\s*</h1>\\s*<i>([\\s\\S]*?)</i>`, 'i').exec(html);
  const value = match ? plainText(match[1]) : '';
  return value === '-' ? '' : value;
}

/** Series metadata and every chapter from the /comics/{slug}/ page. */
export function parseSeriesPage(html, slug) {
  const text = String(html ?? '');
  const type = infoRow(text, 'Type');
  const heading = /<h1[^>]*class="entry-title"[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
  const ogTitle = /<meta property="og:title" content="([^"]*)"/i.exec(text);
  const title = (heading ? plainText(heading[1]) : '')
    || decodeHtml(ogTitle?.[1] ?? '').replace(/\s+Manga\s*\|\s*Violet Scans$/i, '').trim()
    || slug;
  if (/^novel$/i.test(type)) {
    throw new FetchError(`"${title}" is a text novel on Violet Scans, not a comic, so it has no pages to download.`);
  }
  const people = [infoRow(text, 'Author'), infoRow(text, 'Artist')].filter(Boolean);
  const synopsis = /<div class="entry-content entry-content-single"[^>]*>([\s\S]*?)<\/div>/i.exec(text);
  const cover = /<meta property="og:image" content="([^"]*)"/i.exec(text)
    ?? /<div class="thumb"[^>]*>\s*<img[^>]*src="([^"]+)"/i.exec(text);

  const chapters = [];
  const seen = new Set();
  for (const [, rawNumber, body] of text.matchAll(/<li data-num="([^"]*)"[^>]*>([\s\S]*?)<\/li>/gi)) {
    if (!/^\d+(?:\.\d+)?$/.test(rawNumber.trim())) continue;
    const number = Number(rawNumber);
    if (seen.has(number)) continue;
    const label = plainText(/class="chapternum"[^>]*>([\s\S]*?)<\/span>/i.exec(body)?.[1] ?? '');
    const date = isoDate(plainText(/class="chapterdate"[^>]*>([\s\S]*?)<\/span>/i.exec(body)?.[1] ?? ''));
    const chapter = {
      number,
      // Labels read "Chapter 6"; keep only text beyond that, if any.
      title: label.replace(/^chapter\s*[\d.]+\s*[-:–—]?\s*/i, '').trim(),
      date,
      chapterId: chapterIdFor(number),
    };
    if (/lockedChapterModal/i.test(body)) {
      const coins = Number(/data-coin="(\d+)"/i.exec(body)?.[1]) || 0;
      chapters.push({ ...chapter, url: `${SITE}/${encodeURIComponent(slug)}-chapter-${String(number).replace('.', '-')}/`, isFree: false, lock: { price: coins } });
    } else {
      const href = /<a\s[^>]*href="([^"]+)"/i.exec(body);
      const url = href ? httpsUrl(href[1]) : '';
      if (!url || new URL(url).hostname !== 'violetmanga.com') continue;
      chapters.push({ ...chapter, url, isFree: true });
    }
    seen.add(number);
  }
  return {
    title,
    author: [...new Set(people)].join(', '),
    summary: synopsis ? plainText(synopsis[1]) : '',
    cover: cover ? httpsUrl(cover[1]) : '',
    chapters: chapters.sort((a, b) => a.number - b.number),
  };
}

/** The series slug a chapter page links back to. */
export function seriesSlugFromChapterPage(html) {
  const text = String(html ?? '');
  const link = /class="allc"[^>]*>[\s\S]*?href="https:\/\/violetmanga\.com\/comics\/([^/"]+)\/"/i.exec(text)
    ?? /itemprop="item"\s+href="https:\/\/violetmanga\.com\/comics\/([^/"]+)\/"/i.exec(text)
    ?? /href="https:\/\/violetmanga\.com\/comics\/([^/"]+)\/"\s+class="[^"]*btn-back/i.exec(text);
  return link ? cleanSlug(link[1]) : null;
}

function lockedError(number, price, freeAt = '') {
  const cost = Number(price) > 0 ? `costs ${Number(price)} coins` : 'is locked';
  return new ProtectedContentError(
    `Violet Scans chapter ${number} ${cost}${freeAt ? ` (the site lists it as free from ${freeAt})` : ''}. ` +
    'This extension only downloads free chapters and does not unlock paid ones.',
    { price: Number(price) || 0 },
  );
}

/** Page images from a chapter page, in the reader's own order. */
export function parseChapterImages(html, expectedNumber) {
  const text = String(html ?? '');
  const reader = /ts_reader\.run\((\{[\s\S]*?\})\);/.exec(text);
  if (!reader) {
    // Second line of defence: the site served the locked page.
    if (/This chapter is locked|class="lock-card"/i.test(text)) {
      // The price and countdown sit in their own tags and lines.
      const words = plainText(text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')).replace(/\s+/g, ' ');
      const price = /Buy now for (\d+) Coins/i.exec(words)?.[1];
      const freeAt = /Free in (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)/i.exec(words)?.[1] ?? '';
      throw lockedError(expectedNumber, price, freeAt);
    }
    throw new FetchError(`Violet Scans chapter ${expectedNumber} has no image reader (a text chapter, or the page changed). Check that it opens in your browser.`);
  }
  let data;
  try { data = JSON.parse(reader[1]); } catch {
    throw new FetchError(`Violet Scans chapter ${expectedNumber}: could not read the page list.`);
  }
  const source = (Array.isArray(data?.sources) ? data.sources : []).find((s) => Array.isArray(s?.images) && s.images.length);
  const images = [];
  const seen = new Set();
  for (const value of source?.images ?? []) {
    const url = httpsUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    images.push({ url, index: images.length + 1 });
  }
  if (!images.length) throw new FetchError(`Violet Scans chapter ${expectedNumber} has no pages yet.`);
  return images;
}

/** One page of /?s= results: comics only (novels carry "[Novel]" in the title). */
export function parseSearchPage(html) {
  const text = String(html ?? '');
  const start = text.indexOf('class="listupd"');
  if (start < 0) return { results: [], hasNext: false };
  const end = text.indexOf('class="pagination"', start);
  const list = text.slice(start, end > 0 ? end : undefined);
  const results = [];
  for (const [, block] of list.matchAll(/<div class="bsx">([\s\S]*?)<\/a>/gi)) {
    const link = /href="https:\/\/violetmanga\.com\/comics\/([^/"]+)\/"/i.exec(block);
    const seriesId = link ? cleanSlug(link[1]) : null;
    if (!seriesId) continue;
    const title = decodeHtml(/title="([^"]*)"/i.exec(block)?.[1] ?? '').trim()
      || plainText(/<div class="tt">([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '');
    // Not by slug: "...-of-a-martial-arts-novel" is a comic.
    if (/\[novel\]/i.test(title) || /violet-format--novel/i.test(block)) continue;
    const image = /<img[^>]*src="([^"]+)"/i.exec(block);
    results.push({ seriesId, title: title || seriesId, author: '', thumbnail: image ? httpsUrl(image[1]) : '', url: seriesUrl(seriesId) });
  }
  return { results, hasNext: /class="next page-numbers"|class="page-numbers next"/i.test(text.slice(end > 0 ? end : start)) };
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

const pageText = async (ctx, url) => (await ctx.fetchRaw(url)).text();

export const violetAdapter = {
  id: 'violet',
  label: 'Violet Scans',
  hostPatterns: ['violetmanga.com', 'violetscans.org', 'violetscans.com'],
  capabilities: { search: true, originalQuality: false, download: true, languages: ['en'] },
  parseUrl,

  async search(query, _lang, ctx) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const found = new Map();
    for (let page = 1; page <= SEARCH_MAX_PAGES && found.size < SEARCH_LIMIT; page++) {
      const url = page === 1 ? `${SITE}/?s=${encodeURIComponent(q)}` : `${SITE}/page/${page}/?s=${encodeURIComponent(q)}`;
      const { results, hasNext } = parseSearchPage(await pageText(ctx, url));
      for (const result of results) if (!found.has(result.seriesId)) found.set(result.seriesId, result);
      if (!hasNext || !results.length) break;
    }
    return [...found.values()].slice(0, SEARCH_LIMIT);
  },

  async getSeries(ref, ctx) {
    let html;
    try {
      html = await pageText(ctx, seriesUrl(ref.seriesId));
    } catch (error) {
      if (error?.status !== 404) throw error;
      // A chapter link whose series slug was guessed wrong: ask the chapter page.
      const slug = ref.chapterPath
        ? seriesSlugFromChapterPage(await pageText(ctx, `${SITE}${ref.chapterPath}`))
        : null;
      if (!slug || slug === ref.seriesId) {
        throw new FetchError(`Violet Scans has no series "${ref.seriesId}". Check the link opens on violetmanga.com.`, { status: 404 });
      }
      // Correct the reference itself, so Following stores the real series.
      ref.seriesId = slug;
      html = await pageText(ctx, seriesUrl(slug));
    }
    const series = parseSeriesPage(html, ref.seriesId);
    if (!series.chapters.length) throw new FetchError(`No Violet Scans chapters found for "${ref.seriesId}".`);
    return series;
  },

  async getChapterImages(_ref, chapter, ctx) {
    // Refuse a chapter the list marked as paid before any request.
    if (chapter?.isFree === false) throw lockedError(chapter.number, chapter.lock?.price);
    let url;
    try { url = new URL(chapter?.url ?? ''); } catch { url = null; }
    if (!url || url.protocol !== 'https:' || url.hostname !== 'violetmanga.com') {
      throw new FetchError(`Violet Scans chapter ${chapter?.number} has no valid link; reopen the series and try again.`);
    }
    return parseChapterImages(await pageText(ctx, url.href), chapter.number);
  },
};
