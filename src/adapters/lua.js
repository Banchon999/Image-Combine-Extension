/**
 * Lua Comic adapter (luacomic.org, a HeanCMS site).
 *
 * Built from responses captured in a reader's own browser: Cloudflare blocks
 * the build environment from luacomic.org, api.luacomic.org and
 * media.luacomic.org alike, so none of this could be exercised live there.
 * The shapes below are copied from those captures.
 *
 *   GET luacomic.org/series/{slug}           page HTML; its embedded data
 *                                            carries the numeric series id
 *                                            (if blocked, a chapter answer
 *                                            below carries it too)
 *   GET api.luacomic.org/chapter/query?page=N&perPage=100&series_id={id}
 *                                            chapter list, newest first
 *   GET api.luacomic.org/chapter/{series}/{chapter}
 *                                            pages, or {paywall:true}
 *
 * Lua sells chapters for coins. Every listed chapter carries its price, and a
 * paid chapter's endpoint answers {paywall:true} with no pages. The adapter
 * refuses priced chapters before any request and never looks elsewhere.
 * There is no search: the site's search endpoint could not be identified.
 */

import { FetchError, ProtectedContentError } from '../common/errors.js';

const SITE = 'https://luacomic.org';
const API = 'https://api.luacomic.org';
const MEDIA = 'https://media.luacomic.org/';
const HOSTS = ['luacomic.org', 'www.luacomic.org'];
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const NUMBER = /(\d+(?:\.\d+)?)/;

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
 * Parse a Lua Comic series or chapter URL. A chapter URL also keeps its exact
 * slug, which lets getSeries find the series id from the API if the series
 * page cannot be read.
 *
 * @returns {{seriesId: string, lang: string, episodeNo?: number, chapterSlug?: string}|null}
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
  const chapterSlug = cleanSlug(match[2]);
  const number = /^chapter-(\d+(?:\.\d+)?)$/.exec(chapterSlug ?? '');
  if (!number) return null;
  return { seriesId, lang: 'en', episodeNo: Number(number[1]), chapterSlug };
}

export function seriesUrl(slug) {
  return `${SITE}/series/${encodeURIComponent(slug)}`;
}

function mediaUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, MEDIA);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

const unescapeJson = (text) => {
  try { return JSON.parse(`"${text}"`); } catch { return text; }
};

const decodeEntities = (text) => String(text ?? '')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Series id, title, description and cover from the series page HTML.
 *
 * The id sits in the page's embedded framework data, which escapes quotes
 * (\"series_id\":638), so the patterns accept both escaped and plain forms.
 */
export function parseSeriesPage(html, slug) {
  const text = String(html ?? '');
  const q = '\\\\?"';
  const post = new RegExp(`${q}post${q}:\\{${q}id${q}:(\\d+),${q}title${q}:${q}((?:[^"\\\\]|\\\\.)*?)${q},${q}series_slug${q}:${q}([^"\\\\]+)${q}`)
    .exec(text);
  const bySlug = post && post[3] === slug ? post : null;
  const idMatch = bySlug ? null : new RegExp(`${q}series_id${q}:(\\d+)`).exec(text);
  const id = Number(bySlug?.[1] ?? idMatch?.[1]);
  const meta = (name) => {
    const m = new RegExp(`<meta[^>]+(?:property|name)="${name}"[^>]+content="([^"]*)"`, 'i').exec(text)
      ?? new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${name}"`, 'i').exec(text);
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const ogTitle = meta('og:title').replace(/\s+-\s+Lua Comic$/i, '');
  const description = meta('og:description') || meta('description');
  return {
    seriesNumericId: Number.isSafeInteger(id) && id > 0 ? id : null,
    title: (bySlug ? unescapeJson(bySlug[2]) : '') || ogTitle || slug,
    // The meta description is prefixed "Read <title> on Lua Comic - ".
    summary: description.replace(/^Read .+? on Lua Comic\s*-\s*/i, ''),
    cover: mediaUrl(meta('og:image')),
  };
}

/** Chapter number from the slug ("chapter-80"), else the name ("Chapter 80"). */
export function chapterNumber(row) {
  const fromSlug = /^chapter-(\d+(?:\.\d+)?)$/.exec(String(row?.chapter_slug ?? ''));
  const fromName = NUMBER.exec(String(row?.chapter_name ?? ''));
  const value = Number(fromSlug?.[1] ?? fromName?.[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const isPriced = (row) => Number(row?.price) > 0;

function lockedError(number, price) {
  return new ProtectedContentError(
    `Lua Comic chapter ${number} ${Number(price) > 0 ? `costs ${Number(price)} coins` : 'is paywalled'}. ` +
    'This extension only downloads free chapters and does not unlock paid ones.',
    { price: Number(price) || 0 },
  );
}

/** One page of GET /chapter/query, as extension chapters. */
export function parseChapterPage(json, slug) {
  if (!Array.isArray(json?.data)) throw new FetchError(`Lua Comic returned no chapter list for "${slug}".`);
  const chapters = [];
  for (const row of json.data) {
    const number = chapterNumber(row);
    const chapterSlug = cleanSlug(row?.chapter_slug);
    if (number === null || !chapterSlug) continue;
    const locked = isPriced(row);
    chapters.push({
      number,
      title: String(row.chapter_title ?? '').trim(),
      date: String(row.created_at ?? '').slice(0, 10),
      url: `${seriesUrl(slug)}/${encodeURIComponent(chapterSlug)}`,
      chapterSlug,
      chapterId: Number.isSafeInteger(row.id) ? row.id : undefined,
      isFree: !locked,
      ...(locked ? { lock: { price: Number(row.price) } } : {}),
    });
  }
  return chapters;
}

/** Page images from GET /chapter/{series}/{chapter}. */
export function parseChapterImages(json, expectedNumber) {
  if (json?.paywall === true) throw lockedError(expectedNumber, json?.chapter?.price);
  const chapter = json?.chapter;
  if (!chapter || typeof chapter !== 'object') {
    throw new FetchError(`Lua Comic returned no data for chapter ${expectedNumber}.`);
  }
  const number = chapterNumber(chapter);
  if (number !== null && number !== Number(expectedNumber)) {
    throw new FetchError(`Lua Comic answered chapter ${number} when asked for ${expectedNumber}.`);
  }
  if (isPriced(chapter)) throw lockedError(expectedNumber, chapter.price);
  if (chapter.chapter_type && chapter.chapter_type !== 'Comic') {
    throw new FetchError(`Lua Comic chapter ${expectedNumber} is ${chapter.chapter_type}, not images, so there is nothing to download.`);
  }
  const images = [];
  const seen = new Set();
  for (const entry of Array.isArray(chapter.chapter_data?.images) ? chapter.chapter_data.images : []) {
    const url = mediaUrl(typeof entry === 'string' ? entry : entry?.url ?? entry?.src);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    images.push({ url, index: images.length + 1 });
  }
  if (!images.length) {
    throw new FetchError(`Lua Comic chapter ${expectedNumber} has no pages. Check that it opens in your browser.`);
  }
  return images;
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

/** Cloudflare's block or challenge page instead of the content we asked for. */
function blockedHint(error) {
  return error?.status === 403 || error?.status === 503
    ? ' Lua Comic is behind Cloudflare: open luacomic.org in this browser (complete any check it shows), then try again.'
    : '';
}

export const luaAdapter = {
  id: 'lua',
  label: 'Lua Comic',
  hostPatterns: ['luacomic.org'],
  capabilities: { search: false, originalQuality: false, download: true, languages: ['en'] },
  parseUrl,

  async search() {
    return [];
  },

  async getSeries(ref, ctx) {
    let page = { seriesNumericId: null, title: ref.seriesId, summary: '', cover: '' };
    let pageError = null;
    try {
      const response = await ctx.fetchRaw(seriesUrl(ref.seriesId));
      page = parseSeriesPage(await response.text(), ref.seriesId);
    } catch (error) {
      if (error?.status === 404) {
        throw new FetchError(`Lua Comic has no series "${ref.seriesId}". Check the link opens on luacomic.org.`, { status: 404 });
      }
      pageError = error;
    }

    // Without the page, a chapter's API answer carries the id: the pasted
    // chapter if any, else the usual first chapters. A paywalled answer still
    // names its series; only that metadata is read from it.
    let seriesId = page.seriesNumericId;
    const probes = [...new Set([ref.chapterSlug, 'chapter-1', 'chapter-0'].filter(Boolean))];
    for (const chapterSlug of seriesId ? [] : probes) {
      try {
        const json = await ctx.fetchJson(`${API}/chapter/${encodeURIComponent(ref.seriesId)}/${encodeURIComponent(chapterSlug)}`);
        const series = json?.series ?? json?.chapter?.series;
        if (series?.series_slug && series.series_slug !== ref.seriesId) continue;
        seriesId = Number(json?.chapter?.series_id ?? series?.id) || null;
        if (series?.title && page.title === ref.seriesId) page.title = String(series.title);
        if (series?.thumbnail && !page.cover) page.cover = mediaUrl(series.thumbnail);
        if (seriesId) break;
      } catch {
        // Try the next chapter; the error below names the real cause.
      }
    }
    if (!seriesId) {
      throw new FetchError(
        `Could not find the Lua Comic series id for "${ref.seriesId}".${blockedHint(pageError)}`,
        { status: pageError?.status },
      );
    }

    const byNumber = new Map();
    for (let n = 1; n <= MAX_PAGES; n++) {
      let json;
      try {
        json = await ctx.fetchJson(`${API}/chapter/query?page=${n}&perPage=${PAGE_SIZE}&series_id=${seriesId}`);
      } catch (error) {
        if (blockedHint(error)) throw new FetchError(`Lua Comic refused the chapter list.${blockedHint(error)}`, { status: error.status });
        throw error;
      }
      const batch = parseChapterPage(json, ref.seriesId);
      const before = byNumber.size;
      for (const chapter of batch) if (!byNumber.has(chapter.number)) byNumber.set(chapter.number, chapter);
      const last = Number(json?.meta?.last_page);
      if (!batch.length || byNumber.size === before || !(last > n)) break;
    }
    const chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    if (!chapters.length) throw new FetchError(`No Lua Comic chapters found for "${ref.seriesId}".`);
    return { title: page.title, author: '', summary: page.summary, cover: page.cover, chapters };
  },

  async getChapterImages(ref, chapter, ctx) {
    // Refuse a priced chapter before any request.
    if (chapter?.isFree === false) throw lockedError(chapter.number, chapter.lock?.price);
    const slug = chapter?.chapterSlug || `chapter-${chapter?.number}`;
    let json;
    try {
      json = await ctx.fetchJson(`${API}/chapter/${encodeURIComponent(ref.seriesId)}/${encodeURIComponent(slug)}`);
    } catch (error) {
      if (blockedHint(error)) throw new FetchError(`Lua Comic refused chapter ${chapter.number}.${blockedHint(error)}`, { status: error.status });
      throw error;
    }
    return parseChapterImages(json, chapter.number);
  },
};
