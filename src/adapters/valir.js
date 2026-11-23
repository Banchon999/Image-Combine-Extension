/**
 * Valir Scans adapter (valirscans.org).
 *
 * A Next.js site with no public JSON API for chapters, so the data comes from
 * the React Server Components payload each page embeds
 * (self.__next_f.push([1,"..."])), read as data and never evaluated:
 *   GET /series/comic/{slug}?page=N   series object and 100 chapters per page
 *   GET /series/comic/{slug}/chapter/{n}   the chapter with its page list
 *   GET /series?q={query}              search results ("initialSeries")
 *
 * Valir sells chapters for coins. Each chapter in the list says so
 * explicitly (isLocked, coinPrice, hasAccess, earlyAccessUntil); a locked one
 * is refused before any request. The server sends a locked chapter's pages
 * redacted (isRedacted, empty imageUrl). Pages can also be served encrypted
 * or split into tiles/strips/fragments; this adapter never reassembles or
 * decrypts those and refuses the chapter instead.
 */

import { FetchError, ProtectedContentError } from '../common/errors.js';

const SITE = 'https://valirscans.org';
const HOSTS = ['valirscans.org', 'www.valirscans.org'];
const MEDIA_HOSTS = ['media.valirscans.org', 'valirscans.org'];
const MAX_PAGES = 50;
const SEARCH_LIMIT = 50;
const NOVEL_TYPES = /^(web_)?novel$|^light_novel$/i;

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
 * Parse a series or chapter link. Novel links (/series/novel/...) are
 * recognised so the user gets a clear "this is a novel" answer.
 *
 * @returns {{seriesId: string, lang: string, episodeNo?: number, novel?: boolean}|null}
 */
export function parseUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/series\/(comic|novel)\/([^/]+)(?:\/chapter\/(\d+(?:\.\d+)?))?\/?$/);
  if (!match) return null;
  const seriesId = cleanSlug(match[2]);
  if (!seriesId) return null;
  return {
    seriesId,
    lang: 'en',
    ...(match[1] === 'novel' ? { novel: true } : {}),
    ...(match[3] === undefined ? {} : { episodeNo: Number(match[3]) }),
  };
}

export const seriesUrl = (slug) => `${SITE}/series/comic/${encodeURIComponent(slug)}`;
export const chapterUrl = (slug, number) => `${seriesUrl(slug)}/chapter/${number}`;
/** Following needs a numeric chapter id; Valir's own ids are strings. */
export const chapterIdFor = (number) => Math.round(Number(number) * 1000);

function httpsUrl(value, allowed = null) {
  try {
    const url = new URL(String(value ?? ''), SITE);
    if (url.protocol !== 'https:') return '';
    if (allowed && !allowed.includes(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

/**
 * The text of every RSC chunk a Next.js page pushes, joined. Each chunk is a
 * JavaScript string literal, which is valid JSON, so JSON.parse reads it.
 */
export function flightText(html) {
  let out = '';
  for (const [, literal] of String(html ?? '').matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { out += JSON.parse(literal); } catch { /* skip a malformed chunk */ }
  }
  return out;
}

/** The JSON value that starts at `start` in `text` (an object or array), or undefined. */
export function jsonAt(text, start) {
  const open = text[start];
  if (open !== '{' && open !== '[') return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

/** Every JSON value that follows `"key":` in the payload. */
function* valuesOf(text, key) {
  const needle = `"${key}":`;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    const value = jsonAt(text, at + needle.length);
    if (value !== undefined) yield value;
  }
}

const isNovelType = (type) => NOVEL_TYPES.test(String(type ?? ''));

/**
 * Locked for an anonymous reader if any one signal says so: the lock flag, a
 * coin price, no access, or early access still running.
 */
export function isLockedChapter(row, now = Date.now()) {
  const early = Date.parse(row?.earlyAccessUntil ?? '');
  return row?.isLocked === true
    || Number(row?.coinPrice) > 0
    || row?.hasAccess === false
    || row?.isFree === false
    || (!Number.isNaN(early) && early > now);
}

function lockedError(number, price) {
  const cost = Number(price) > 0 ? `costs ${Number(price)} coins` : 'is locked';
  return new ProtectedContentError(
    `Valir Scans chapter ${number} ${cost}. This extension only downloads free chapters and does not unlock paid ones.`,
    { price: Number(price) || 0 },
  );
}

const novelError = (title) => new FetchError(`"${title}" is a text novel on Valir Scans, not a comic, so it has no pages to download.`);

/**
 * One /series/comic/{slug}?page=N page: series metadata, that page's
 * chapters and the page count.
 */
export function parseSeriesPage(html, slug, now = Date.now()) {
  const text = flightText(html);
  let series = null;
  for (const value of valuesOf(text, 'series')) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'description' in value
      && (value.urlSlug === slug || value.slug === slug)) { series = value; break; }
  }
  if (!series) throw new FetchError(`Valir Scans returned no series data for "${slug}".`);
  const title = String(series.title ?? '').trim() || slug;
  if (isNovelType(series.type)) throw novelError(title);

  let rows = null;
  for (const value of valuesOf(text, 'chapters')) {
    if (Array.isArray(value) && (value.length === 0 || value.some((row) => row && 'hasAccess' in row))) { rows = value; break; }
  }
  if (!rows) throw new FetchError(`Valir Scans returned no chapter list for "${slug}".`);
  const chapters = [];
  for (const row of rows) {
    const number = Number(row?.number);
    if (!Number.isFinite(number) || number < 0) continue;
    if (row.contentFormat && row.contentFormat !== 'IMAGES') continue;
    const locked = isLockedChapter(row, now);
    const label = String(row.title ?? '').trim();
    chapters.push({
      number,
      // Titles mostly read "Chapter 6"; keep only text beyond that, if any.
      title: label.replace(/^chapter\s*[\d.]+\s*[-:–—]?\s*/i, '').trim(),
      date: String(row.publishedAt ?? '').slice(0, 10),
      url: chapterUrl(slug, number),
      chapterId: chapterIdFor(number),
      isFree: !locked,
      ...(locked ? { lock: { price: Number(row.coinPrice) || 0 } } : {}),
    });
  }
  const pages = /"currentPage":(\d+),"totalPages":(\d+)/.exec(text);
  return {
    title,
    author: '',
    summary: String(series.description ?? '').trim(),
    cover: httpsUrl(series.coverImage),
    chapters,
    totalPages: pages ? Number(pages[2]) : 1,
  };
}

/** Page images from a chapter page, by page number. */
export function parseChapterImages(html, expectedNumber) {
  const text = flightText(html);
  let chapter = null;
  for (const value of valuesOf(text, 'chapter')) {
    if (value && typeof value === 'object' && Array.isArray(value.pages)) { chapter = value; break; }
  }
  if (!chapter) {
    throw new FetchError(`Valir Scans chapter ${expectedNumber} has no page list (a text chapter, or the page changed). Check that it opens in your browser.`);
  }
  if (Number(chapter.number) !== Number(expectedNumber)) {
    throw new FetchError(`Valir Scans answered chapter ${chapter.number} when asked for ${expectedNumber}.`);
  }
  const content = chapter.pages
    .filter((page) => page && (page.kind ?? 'CONTENT') === 'CONTENT')
    .sort((a, b) => (Number(a.pageNumber) || 0) - (Number(b.pageNumber) || 0));
  // Second line of defence: redacted (locked), encrypted or split pages.
  // Never reassemble or decrypt them.
  if (content.some((page) => page.isRedacted === true || !page.imageUrl)) throw lockedError(expectedNumber);
  if (content.some((page) => page.isEncrypted === true || page.hasFragments === true || page.hasStrips === true
    || (Array.isArray(page.tiles) && page.tiles.length) || (Array.isArray(page.fragments) && page.fragments.length))) {
    throw new ProtectedContentError(`Valir Scans chapter ${expectedNumber} is served in a protected (encrypted or split) form. This extension does not decrypt or reassemble pages.`);
  }
  const images = [];
  const seen = new Set();
  for (const page of content) {
    const url = httpsUrl(page.imageUrl, MEDIA_HOSTS);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const width = Number(page.width);
    const height = Number(page.height);
    images.push({ url, index: images.length + 1, ...(width > 0 ? { width } : {}), ...(height > 0 ? { height } : {}) });
  }
  if (!images.length) throw new FetchError(`Valir Scans chapter ${expectedNumber} has no pages yet.`);
  return images;
}

/** /series?q= results: comics only. */
export function parseSearchPage(html) {
  const text = flightText(html);
  let rows = [];
  for (const value of valuesOf(text, 'initialSeries')) {
    if (Array.isArray(value)) { rows = value; break; }
  }
  const results = [];
  for (const row of rows) {
    if (isNovelType(row?.type)) continue;
    const seriesId = cleanSlug(row?.urlSlug ?? row?.slug);
    if (!seriesId) continue;
    results.push({
      seriesId,
      title: String(row.title ?? '').trim() || seriesId,
      author: '',
      thumbnail: httpsUrl(row.coverImage),
      url: seriesUrl(seriesId),
    });
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

const pageText = async (ctx, url) => (await ctx.fetchRaw(url)).text();

export const valirAdapter = {
  id: 'valir',
  label: 'Valir Scans',
  hostPatterns: ['valirscans.org'],
  capabilities: { search: true, originalQuality: false, download: true, languages: ['en'] },
  parseUrl,

  async search(query, _lang, ctx) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    return parseSearchPage(await pageText(ctx, `${SITE}/series?q=${encodeURIComponent(q)}`)).slice(0, SEARCH_LIMIT);
  },

  async getSeries(ref, ctx) {
    if (ref.novel) throw novelError(ref.seriesId);
    let first;
    try {
      first = parseSeriesPage(await pageText(ctx, seriesUrl(ref.seriesId)), ref.seriesId);
    } catch (error) {
      if (error?.status === 404) {
        throw new FetchError(`Valir Scans has no comic "${ref.seriesId}". Check the link opens on valirscans.org.`, { status: 404 });
      }
      throw error;
    }
    const byNumber = new Map(first.chapters.map((chapter) => [chapter.number, chapter]));
    const total = Math.min(first.totalPages, MAX_PAGES);
    for (let page = 2; page <= total; page++) {
      const next = parseSeriesPage(await pageText(ctx, `${seriesUrl(ref.seriesId)}?page=${page}`), ref.seriesId);
      const before = byNumber.size;
      for (const chapter of next.chapters) if (!byNumber.has(chapter.number)) byNumber.set(chapter.number, chapter);
      if (byNumber.size === before) break;
    }
    const chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    if (!chapters.length) throw new FetchError(`No Valir Scans chapters found for "${ref.seriesId}".`);
    const { totalPages: _totalPages, ...series } = first;
    return { ...series, chapters };
  },

  async getChapterImages(_ref, chapter, ctx) {
    // Refuse a chapter the list marked as locked before any request.
    if (chapter?.isFree === false) throw lockedError(chapter.number, chapter.lock?.price);
    let url;
    try { url = new URL(chapter?.url ?? ''); } catch { url = null; }
    if (!url || url.protocol !== 'https:' || url.hostname !== 'valirscans.org') {
      throw new FetchError(`Valir Scans chapter ${chapter?.number} has no valid link; reopen the series and try again.`);
    }
    return parseChapterImages(await pageText(ctx, url.href), chapter.number);
  },
};
