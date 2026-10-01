/**
 * Asura Scans adapter.
 *
 * Reads the site's own public JSON API (api.asurascans.com) rather than
 * scraping the Astro-rendered pages: the API is what the reader itself calls,
 * and it returns the full chapter list unpaginated (verified up to 360
 * chapters) plus each page's dimensions.
 *
 * Paid early access is enforced by the server, not by us: a locked chapter
 * comes back with `is_locked: true`, an `unlock_time` and no `pages` at all.
 * The adapter only reports that and when it ends; it never tries another
 * route to the images.
 */

import { FetchError, ProtectedContentError } from '../common/errors.js';

const SITE = 'https://asurascans.com';
const API = 'https://api.asurascans.com/api';
const HOSTS = ['asurascans.com', 'www.asurascans.com'];

// Series paths carry a site-wide 8-hex suffix (/comics/nano-machine-3ec3b16f)
// that is identical on every series, i.e. it rotates for the whole site. The
// bare slug is the stable identity: both the API and the site accept it, and
// the site 302s a bare or stale suffix to the current one.
const SUFFIX = /-[0-9a-f]{8}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Side chapters are numbered 152.1 ... 152.6, and prologues are chapter 0.
const CHAPTER_NO = /^\d+(?:\.\d+)?$/;

const SEARCH_PAGE_SIZE = 50; // the API caps `limit` at 50 and ignores `page`
const SEARCH_MAX_PAGES = 3;

/* ------------------------------------------------------------------ *
 * Pure helpers (no network -- unit tested outside a browser)
 * ------------------------------------------------------------------ */

/** Strip the rotating suffix; null if what remains is not a plausible slug. */
export function bareSlug(segment) {
  const slug = String(segment ?? '').toLowerCase().replace(SUFFIX, '');
  return SLUG.test(slug) && slug.length <= 200 ? slug : null;
}

/**
 * Parse an Asura series or chapter URL.
 *
 * @returns {{seriesId: string, lang: string, episodeNo?: number}|null}
 */
export function parseUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase())) return null;

  const match = url.pathname.match(/^\/comics\/([^/]+)(?:\/chapter\/([^/]+))?\/?$/);
  if (!match) return null;
  const seriesId = bareSlug(match[1]);
  if (!seriesId) return null;
  if (match[2] !== undefined && !CHAPTER_NO.test(match[2])) return null;
  return {
    seriesId,
    lang: 'en',
    ...(match[2] !== undefined ? { episodeNo: Number(match[2]) } : {}),
  };
}

export function seriesUrl(slug) {
  return `${SITE}/comics/${encodeURIComponent(slug)}`;
}

export function chapterUrl(slug, number) {
  return `${seriesUrl(slug)}/chapter/${number}`;
}

/** Descriptions arrive as HTML (<p>...</p>); keep the words, drop the markup. */
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

function httpsUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * Whether a chapter is still in paid early access at `now`.
 *
 * `is_premium` alone is not enough: the list endpoint is cached and keeps
 * saying `true` for a while after `early_access_until` has passed, when the
 * chapter endpoint already serves it free. A premium flag with no end date is
 * treated as locked. Either way the chapter endpoint decides at download time.
 */
export function isEarlyAccess(chapter, now = Date.now()) {
  if (chapter?.is_premium !== true) return false;
  const until = Date.parse(chapter.early_access_until ?? '');
  return Number.isNaN(until) || until > now;
}

/** Why a chapter can't be downloaded yet, naming when it unlocks if known. */
function lockedError(number, unlockTime) {
  const until = Date.parse(unlockTime ?? '');
  const when = Number.isNaN(until) ? '' : ` until ${new Date(until).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  return new ProtectedContentError(
    `Asura chapter ${number} is in paid early access${when}. It becomes free after that; this extension does not unlock paid chapters.`,
    { unlockTime: unlockTime ?? null },
  );
}

/** Series metadata from GET /api/series/{slug}. */
export function parseSeriesInfo(json, slug) {
  const series = json?.series;
  if (!series || typeof series !== 'object') {
    throw new FetchError(`Asura returned no series data for "${slug}".`);
  }
  const people = [series.author, series.artist]
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  return {
    title: String(series.title ?? '').trim() || slug,
    author: [...new Set(people)].join(', '),
    summary: plainText(series.description),
    cover: httpsUrl(series.cover),
  };
}

/** Chapter list from GET /api/series/{slug}/chapters, ascending by number. */
export function parseChapterList(json, slug, now = Date.now()) {
  if (!Array.isArray(json?.data)) {
    throw new FetchError(`Asura returned no chapter list for "${slug}".`);
  }
  const byNumber = new Map();
  for (const item of json.data) {
    const number = Number(item?.number);
    if (!Number.isFinite(number) || number < 0 || byNumber.has(number)) continue;
    const locked = isEarlyAccess(item, now);
    byNumber.set(number, {
      number,
      title: String(item.title ?? '').trim(),
      date: String(item.published_at ?? '').slice(0, 10),
      url: chapterUrl(slug, number),
      // Decimal numbers can't serve as a Following id; the API's own id can.
      chapterId: Number.isSafeInteger(item.id) ? item.id : undefined,
      isFree: !locked,
      ...(locked ? { unlockTime: item.early_access_until ?? null } : {}),
    });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** Page images from GET /api/series/{slug}/chapters/{number}. */
export function parseChapterImages(json, expectedNumber) {
  const data = json?.data;
  if (!data || typeof data !== 'object') {
    throw new FetchError(`Asura returned no data for chapter ${expectedNumber}.`);
  }
  // Second line of defence: the list said free, but the server disagrees (or
  // gates the chapter some other way). Never look for the pages elsewhere.
  if (data.is_locked === true || data.access_gate) {
    throw lockedError(expectedNumber, data.unlock_time);
  }
  const chapter = data.chapter;
  // Guard against the API answering a different chapter than we asked for.
  if (Number(chapter?.number) !== Number(expectedNumber)) {
    throw new FetchError(`Asura answered chapter ${chapter?.number} when asked for ${expectedNumber}.`);
  }
  const images = [];
  const seen = new Set();
  for (const page of Array.isArray(chapter.pages) ? chapter.pages : []) {
    const url = httpsUrl(page?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const width = Number(page.width);
    const height = Number(page.height);
    images.push({
      url,
      index: images.length + 1,
      ...(width > 0 ? { width } : {}),
      ...(height > 0 ? { height } : {}),
    });
  }
  if (!images.length) {
    throw new FetchError(`Asura chapter ${expectedNumber} has no pages. Check that it opens in your browser.`);
  }
  return images;
}

/** One page of GET /api/search results. */
export function parseSearchResults(json) {
  if (!Array.isArray(json?.data)) return [];
  return json.data
    .map((item) => {
      const slug = bareSlug(item?.slug);
      if (!slug) return null;
      return {
        seriesId: slug,
        title: String(item.title ?? '').trim() || slug,
        author: String(item.author ?? '').trim(),
        thumbnail: httpsUrl(item.cover),
        url: seriesUrl(slug),
      };
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

const api = (path) => `${API}${path}`;

export const asuraAdapter = {
  id: 'asura',
  label: 'Asura Scans',
  hostPatterns: ['asurascans.com'],
  capabilities: { search: true, originalQuality: false, download: true, languages: ['en'] },
  parseUrl,

  async search(query, _lang, ctx) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const results = new Map();
    for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
      const json = await ctx.fetchJson(api(
        `/search?q=${encodeURIComponent(q)}&limit=${SEARCH_PAGE_SIZE}&offset=${page * SEARCH_PAGE_SIZE}`,
      ));
      for (const item of parseSearchResults(json)) {
        if (!results.has(item.seriesId)) results.set(item.seriesId, item);
      }
      if (json?.meta?.has_more !== true) break;
    }
    return [...results.values()];
  },

  async getSeries(ref, ctx) {
    const slug = encodeURIComponent(ref.seriesId);
    let info;
    let list;
    try {
      [info, list] = await Promise.all([
        ctx.fetchJson(api(`/series/${slug}`)),
        ctx.fetchJson(api(`/series/${slug}/chapters`)),
      ]);
    } catch (error) {
      // The API answers an unknown slug with a bare 404; say what that means.
      if (error?.status === 404) {
        throw new FetchError(`Asura has no series "${ref.seriesId}". Check the link opens on asurascans.com.`, { status: 404 });
      }
      throw error;
    }
    const chapters = parseChapterList(list, ref.seriesId, ctx.now?.() ?? Date.now());
    if (!chapters.length) throw new FetchError(`No Asura chapters found for "${ref.seriesId}".`);
    return { ...parseSeriesInfo(info, ref.seriesId), chapters };
  },

  async getChapterImages(ref, chapter, ctx) {
    // Refuse a chapter the list marked as early access before any request, the
    // same rule the Kakao adapter follows for non-free chapters.
    if (chapter?.isFree === false) throw lockedError(chapter.number, chapter.unlockTime);
    const json = await ctx.fetchJson(api(
      `/series/${encodeURIComponent(ref.seriesId)}/chapters/${chapter.number}`,
    ));
    return parseChapterImages(json, chapter.number);
  },
};
