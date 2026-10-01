/**
 * NYX Scans adapter.
 *
 * Reads the JSON API the site's own reader calls (api.nyxscans.com). The page
 * HTML embeds the same data in a serialized JavaScript format, which would
 * mean evaluating site code; the API returns plain JSON.
 *
 * NYX sells chapters for coins, and some unlock through an ad link instead.
 * Every chapter carries explicit flags for this (isLocked, isAccessible,
 * price, isShortLinkLocked), and the server returns no images for a locked
 * one. The adapter refuses those chapters before any request and never looks
 * for their pages elsewhere.
 */

import { FetchError, ProtectedContentError } from '../common/errors.js';

const SITE = 'https://nyxscans.com';
const API = 'https://api.nyxscans.com/api';
const HOSTS = ['nyxscans.com', 'www.nyxscans.com'];
const PAGE_SIZE = 200; // what the site's own reader asks for
const MAX_PAGES = 50;
const SEARCH_LIMIT = 50;
// Chapter slugs are "chapter-<number>"; side chapters may carry a decimal.
const CHAPTER_SLUG = /^chapter-(\d+(?:\.\d+)?)$/;

/* ------------------------------------------------------------------ *
 * Pure helpers (no network -- unit tested outside a browser)
 * ------------------------------------------------------------------ */

/**
 * A series slug as it appears in a URL path segment, decoded.
 *
 * NYX slugs are not limited to [a-z0-9-]: real ones contain apostrophes and
 * colons ("i-only-need-the-duke's-child", "roxana:-the-way-to-..."), so only
 * structurally unsafe values are rejected.
 */
export function cleanSlug(segment) {
  let slug;
  try { slug = decodeURIComponent(String(segment ?? '')); } catch { return null; }
  slug = slug.trim();
  if (!slug || slug.length > 200 || slug === '.' || slug === '..') return null;
  if (/[/\\?#\s]/.test(slug) || /\p{Cc}/u.test(slug)) return null;
  return slug;
}

/**
 * Parse a NYX series or chapter URL.
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

/**
 * Whether anonymous readers can open a chapter. Any one lock signal is
 * enough to treat it as locked: coins (price), an ad-link unlock, a timed or
 * permanent lock, or the server simply saying it is not accessible.
 */
export function isLockedChapter(row) {
  return row?.isLocked === true
    || row?.isAccessible === false
    || Number(row?.price) > 0
    || row?.isShortLinkLocked === true
    || row?.isLockedByCoins === true;
}

function lockedError(number, row) {
  const reason = row?.isShortLinkLocked
    ? 'unlocks through an ad link'
    : Number(row?.price) > 0 ? `costs ${Number(row.price)} coins` : 'is locked';
  const until = Date.parse(row?.unlockAt ?? '');
  const when = Number.isNaN(until) ? '' : ` until ${new Date(until).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  return new ProtectedContentError(
    `NYX chapter ${number} ${reason}${when}. This extension only downloads free chapters and does not unlock paid ones.`,
    { price: Number(row?.price) || 0, unlockAt: row?.unlockAt ?? null },
  );
}

/** Series metadata from GET /api/post?postSlug=... */
export function parseSeriesInfo(json, slug) {
  const post = json?.post;
  if (!post || typeof post !== 'object' || !Number.isSafeInteger(post.id)) {
    throw new FetchError(`NYX returned no series data for "${slug}".`);
  }
  if (post.isNovel === true) {
    throw new FetchError(`"${post.postTitle || slug}" is a text novel on NYX, not a comic, so it has no pages to download.`);
  }
  const people = [post.author, post.artist].map((name) => String(name ?? '').trim()).filter(Boolean);
  return {
    postId: post.id,
    title: String(post.postTitle ?? '').trim() || slug,
    author: [...new Set(people)].join(', '),
    summary: plainText(post.postContent),
    cover: httpsUrl(post.featuredImage),
  };
}

/** One page of GET /api/chapters?postId=..., as extension chapters. */
export function parseChapterPage(json, slug) {
  const rows = json?.post?.chapters;
  if (!Array.isArray(rows)) throw new FetchError(`NYX returned no chapter list for "${slug}".`);
  return rows
    .filter((row) => Number.isFinite(Number(row?.number)) && Number(row.number) >= 0 && row.slug)
    .map((row) => {
      const locked = isLockedChapter(row);
      return {
        number: Number(row.number),
        title: String(row.title ?? '').trim(),
        date: String(row.createdAt ?? '').slice(0, 10),
        url: `${seriesUrl(slug)}/${encodeURIComponent(row.slug)}`,
        chapterId: Number.isSafeInteger(row.id) ? row.id : undefined,
        isFree: !locked,
        ...(locked ? { lock: { price: Number(row.price) || 0, isShortLinkLocked: row.isShortLinkLocked === true, unlockAt: row.unlockAt ?? null } } : {}),
      };
    });
}

/** Page images from GET /api/chapter?chapterId=... */
export function parseChapterImages(json, expectedNumber) {
  const chapter = json?.chapter;
  if (!chapter || typeof chapter !== 'object') {
    throw new FetchError(`NYX returned no data for chapter ${expectedNumber}.`);
  }
  if (Number(chapter.number) !== Number(expectedNumber)) {
    throw new FetchError(`NYX answered chapter ${chapter.number} when asked for ${expectedNumber}.`);
  }
  // Second line of defence: the server says locked. Never look elsewhere.
  if (isLockedChapter(chapter)) throw lockedError(expectedNumber, chapter);
  const images = [];
  const seen = new Set();
  const pages = [...(Array.isArray(chapter.images) ? chapter.images : [])]
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
    throw new FetchError(`NYX chapter ${expectedNumber} has no pages. Check that it opens in your browser.`);
  }
  return images;
}

/** GET /api/posts?searchTerm=... -- comics only; novels come back separately. */
export function parseSearchResults(json) {
  if (!Array.isArray(json?.posts)) return [];
  return json.posts
    .filter((post) => post?.isNovel !== true)
    .map((post) => {
      const slug = cleanSlug(post?.slug);
      if (!slug) return null;
      return {
        seriesId: slug,
        title: String(post.postTitle ?? '').trim() || slug,
        author: '',
        thumbnail: httpsUrl(post.featuredImage),
        url: seriesUrl(slug),
      };
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

export const nyxAdapter = {
  id: 'nyx',
  label: 'NYX Scans',
  hostPatterns: ['nyxscans.com'],
  capabilities: { search: true, originalQuality: false, download: true, languages: ['en'] },
  parseUrl,

  async search(query, _lang, ctx) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    return parseSearchResults(await ctx.fetchJson(`${API}/posts?searchTerm=${encodeURIComponent(q)}&take=${SEARCH_LIMIT}`));
  },

  async getSeries(ref, ctx) {
    let info;
    try {
      info = parseSeriesInfo(await ctx.fetchJson(`${API}/post?postSlug=${encodeURIComponent(ref.seriesId)}`), ref.seriesId);
    } catch (error) {
      if (error?.status === 404) {
        throw new FetchError(`NYX has no series "${ref.seriesId}". Check the link opens on nyxscans.com.`, { status: 404 });
      }
      throw error;
    }
    const byNumber = new Map();
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await ctx.fetchJson(
        `${API}/chapters?postId=${info.postId}&skip=${page * PAGE_SIZE}&take=${PAGE_SIZE}&order=asc&userId=`,
      );
      const batch = parseChapterPage(json, ref.seriesId);
      const before = byNumber.size;
      for (const chapter of batch) if (!byNumber.has(chapter.number)) byNumber.set(chapter.number, chapter);
      const total = Number(json?.totalChapterCount);
      if (batch.length < PAGE_SIZE || byNumber.size === before || (total > 0 && byNumber.size >= total)) break;
    }
    const chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    if (!chapters.length) throw new FetchError(`No NYX chapters found for "${ref.seriesId}".`);
    const { postId: _postId, ...series } = info;
    return { ...series, chapters };
  },

  async getChapterImages(_ref, chapter, ctx) {
    // Refuse a chapter the list marked as locked before any request.
    if (chapter?.isFree === false) throw lockedError(chapter.number, chapter.lock);
    if (!Number.isSafeInteger(chapter?.chapterId)) {
      throw new FetchError(`NYX chapter ${chapter?.number} has no id; reopen the series and try again.`);
    }
    return parseChapterImages(await ctx.fetchJson(`${API}/chapter?chapterId=${chapter.chapterId}`), chapter.number);
  },
};
