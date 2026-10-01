/**
 * EZ Manga adapter.
 *
 * Reads the JSON API the site's own reader calls (vapi.ezmanga.org/api/v1).
 * The same API serves the mirror ezmanhwa.com, so links from either host
 * resolve to the same series.
 *
 * EZ Manga sells chapters. Each chapter says so explicitly (isFree, price,
 * requiresPurchase) and the server returns no images for one that requires
 * purchase. The adapter refuses those before any request and never looks for
 * their pages elsewhere.
 */

import { FetchError, ProtectedContentError } from '../common/errors.js';

const SITE = 'https://ezmanga.org';
const API = 'https://vapi.ezmanga.org/api/v1';
const HOSTS = ['ezmanga.org', 'www.ezmanga.org', 'beta.ezmanga.org', 'ezmanhwa.com', 'www.ezmanhwa.com'];
const PAGE_SIZE = 100; // the largest page size the list endpoint was seen to honour
const MAX_PAGES = 100;
const SEARCH_LIMIT = 50;
const CHAPTER_SLUG = /^chapter-(\d+(?:\.\d+)?)$/;

/* ------------------------------------------------------------------ *
 * Pure helpers (no network -- unit tested outside a browser)
 * ------------------------------------------------------------------ */

/**
 * A series slug from a URL path segment, decoded. EZ slugs keep punctuation
 * from the title ("how-is-this-hot-duke-just-a-background-character!", one
 * ending in "."), so only structurally unsafe values are rejected.
 */
export function cleanSlug(segment) {
  let slug;
  try { slug = decodeURIComponent(String(segment ?? '')); } catch { return null; }
  slug = slug.trim();
  if (!slug || slug.length > 300 || slug === '.' || slug === '..') return null;
  if (/[/\\?#\s]/.test(slug) || /\p{Cc}/u.test(slug)) return null;
  return slug;
}

/**
 * Parse an EZ Manga series or chapter URL (either host).
 *
 * @returns {{seriesId: string, lang: string, episodeNo?: number}|null}
 */
export function parseUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/series\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const seriesId = cleanSlug(match[1]);
  if (!seriesId) return null;
  if (match[2] === undefined) return { seriesId, lang: 'en' };
  const chapter = CHAPTER_SLUG.exec(match[2]);
  if (!chapter) return null;
  return { seriesId, lang: 'en', episodeNo: Number(chapter[1]) };
}

export function seriesUrl(slug) {
  return `${SITE}/series/${encodeURIComponent(slug)}`;
}

const apiSeries = (slug) => `${API}/series/${encodeURIComponent(slug)}`;

function httpsUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function plainText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Any one purchase signal is enough to treat a chapter as locked. */
export function isLockedChapter(row) {
  return row?.isFree !== true || row?.requiresPurchase === true || Number(row?.price) > 0;
}

function lockedError(number, row) {
  const price = Number(row?.discountedPrice ?? row?.price) || 0;
  return new ProtectedContentError(
    `EZ Manga chapter ${number} ${price > 0 ? `costs ${price} coins` : 'requires purchase'}. ` +
    'This extension only downloads free chapters and does not unlock paid ones.',
    { price },
  );
}

/** Series metadata from GET /series/{slug} (an unwrapped object). */
export function parseSeriesInfo(json, slug) {
  if (!json || typeof json !== 'object' || !json.slug) {
    throw new FetchError(`EZ Manga returned no series data for "${slug}".`);
  }
  if (String(json.type ?? '').toUpperCase() === 'NOVEL') {
    throw new FetchError(`"${json.title || slug}" is a text novel on EZ Manga, not a comic, so it has no pages to download.`);
  }
  const people = [json.author, json.artist].map((name) => String(name ?? '').trim()).filter(Boolean);
  return {
    title: String(json.title ?? '').trim() || slug,
    author: [...new Set(people)].join(', '),
    summary: plainText(json.description),
    cover: httpsUrl(json.cover),
  };
}

/** One page of GET /series/{slug}/chapters?page=N&perPage=M. */
export function parseChapterPage(json, slug) {
  if (!Array.isArray(json?.data)) throw new FetchError(`EZ Manga returned no chapter list for "${slug}".`);
  return json.data
    .filter((row) => Number.isFinite(Number(row?.number)) && Number(row.number) >= 0 && row.slug)
    .map((row) => {
      const locked = isLockedChapter(row);
      return {
        number: Number(row.number),
        title: String(row.title ?? '').trim(),
        date: String(row.createdAt ?? '').slice(0, 10),
        url: `${seriesUrl(slug)}/${encodeURIComponent(row.slug)}`,
        chapterSlug: String(row.slug),
        chapterId: Number.isSafeInteger(row.id) ? row.id : undefined,
        isFree: !locked,
        ...(locked ? { lock: { price: Number(row.discountedPrice ?? row.price) || 0 } } : {}),
      };
    });
}

/** Page images from GET /series/{slug}/chapters/{chapterSlug} (unwrapped). */
export function parseChapterImages(json, expectedNumber) {
  if (!json || typeof json !== 'object') {
    throw new FetchError(`EZ Manga returned no data for chapter ${expectedNumber}.`);
  }
  if (Number(json.number) !== Number(expectedNumber)) {
    throw new FetchError(`EZ Manga answered chapter ${json.number} when asked for ${expectedNumber}.`);
  }
  // Second line of defence: the server says it requires purchase.
  if (isLockedChapter(json)) throw lockedError(expectedNumber, json);
  const images = [];
  const seen = new Set();
  const pages = [...(Array.isArray(json.images) ? json.images : [])]
    .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
  for (const page of pages) {
    const url = httpsUrl(page?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const width = Number(page.width);
    const height = Number(page.height);
    images.push({ url, index: images.length + 1, ...(width > 0 ? { width } : {}), ...(height > 0 ? { height } : {}) });
  }
  if (!images.length) {
    throw new FetchError(String(json.content ?? '').trim()
      ? `EZ Manga chapter ${expectedNumber} is text, not images, so there is nothing to download.`
      : `EZ Manga chapter ${expectedNumber} has no pages. Check that it opens in your browser.`);
  }
  return images;
}

/** GET /series/search?q=... */
export function parseSearchResults(json) {
  if (!Array.isArray(json?.data)) return [];
  return json.data
    .filter((row) => String(row?.type ?? '').toUpperCase() !== 'NOVEL')
    .map((row) => {
      const slug = cleanSlug(row?.slug);
      if (!slug) return null;
      return {
        seriesId: slug,
        title: String(row.title ?? '').trim() || slug,
        author: '',
        thumbnail: httpsUrl(row.cover),
        url: seriesUrl(slug),
      };
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

export const ezmangaAdapter = {
  id: 'ezmanga',
  label: 'EZ Manga',
  hostPatterns: ['ezmanga.org', 'ezmanhwa.com'],
  capabilities: { search: true, originalQuality: false, download: true, languages: ['en'] },
  parseUrl,

  async search(query, _lang, ctx) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    return parseSearchResults(await ctx.fetchJson(`${API}/series/search?q=${encodeURIComponent(q)}&perPage=${SEARCH_LIMIT}`));
  },

  async getSeries(ref, ctx) {
    let info;
    try {
      info = parseSeriesInfo(await ctx.fetchJson(apiSeries(ref.seriesId)), ref.seriesId);
    } catch (error) {
      if (error?.status === 404) {
        throw new FetchError(`EZ Manga has no series "${ref.seriesId}". Check the link opens on ezmanga.org.`, { status: 404 });
      }
      throw error;
    }
    const byNumber = new Map();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = await ctx.fetchJson(`${apiSeries(ref.seriesId)}/chapters?page=${page}&perPage=${PAGE_SIZE}`);
      const batch = parseChapterPage(json, ref.seriesId);
      const before = byNumber.size;
      for (const chapter of batch) if (!byNumber.has(chapter.number)) byNumber.set(chapter.number, chapter);
      if (!json.next || !batch.length || byNumber.size === before) break;
    }
    const chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    if (!chapters.length) throw new FetchError(`No EZ Manga chapters found for "${ref.seriesId}".`);
    return { ...info, chapters };
  },

  async getChapterImages(ref, chapter, ctx) {
    // Refuse a chapter the list marked as paid before any request.
    if (chapter?.isFree === false) throw lockedError(chapter.number, chapter.lock);
    const slug = chapter?.chapterSlug || `chapter-${chapter?.number}`;
    return parseChapterImages(
      await ctx.fetchJson(`${apiSeries(ref.seriesId)}/chapters/${encodeURIComponent(slug)}`),
      chapter.number,
    );
  },
};
