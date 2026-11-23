/**
 * Siren Scans adapter (sirenscans.com).
 *
 * A server-rendered site (htmx); the data comes from its pages and the two
 * small endpoints its own scripts call:
 *   GET /{slug}                             series page (title, type, cover, series uid)
 *   GET /?_chapters_html=1&series_uid=&series_slug=
 *                                           {"success":true,"chapter_count":N,"rows_html":"..."}
 *   GET /{slug}-chapter-{n}                 chapter page; <script id="chapter-offline-data">
 *                                           JSON lists every page image
 *   GET /?_ajax=suggest&q=                  search suggestions (JSON)
 *
 * Siren sells chapters for coins. Every row of the chapter list carries
 * data-ch-locked, data-ch-paid, data-ch-coins and data-ch-tier; any one of
 * them marks the chapter locked, and it is refused before any request. A
 * chapter page without its page list is treated as protected, never worked
 * around.
 *
 * Page images are listed as wsrv.nl proxy links around cdn.meowing.org; the
 * reader also shows the cdn.meowing.org originals, which are used here.
 */

import { FetchError, ProtectedContentError } from '../common/errors.js';

const SITE = 'https://sirenscans.com';
const HOSTS = ['sirenscans.com', 'www.sirenscans.com'];
const IMAGE_HOSTS = ['cdn.meowing.org'];
const SEARCH_LIMIT = 50;
// Site pages that are not series.
const RESERVED = new Set(['recently-updated', 'purchase', 'login', 'register', 'bookmarks', 'profile', 'settings', 'search', 'assets', 'components', 'cdn-cgi']);
const CHAPTER_PATH = /^\/(.+?)-chapter-(\d+)(?:[-.](\d+))?\/?$/;

/* ------------------------------------------------------------------ *
 * Pure helpers (no network -- unit tested outside a browser)
 * ------------------------------------------------------------------ */

export function cleanSlug(segment) {
  let slug;
  try { slug = decodeURIComponent(String(segment ?? '')); } catch { return null; }
  slug = slug.trim();
  if (!slug || slug.length > 300 || slug === '.' || slug === '..' || RESERVED.has(slug)) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  return slug;
}

/**
 * Parse a series ("/slug") or chapter ("/slug-chapter-N") link.
 *
 * @returns {{seriesId: string, lang: string, episodeNo?: number}|null}
 */
export function parseUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.includes(url.hostname.toLowerCase())) return null;
  const chapter = CHAPTER_PATH.exec(url.pathname);
  if (chapter) {
    const seriesId = cleanSlug(chapter[1]);
    if (!seriesId) return null;
    return { seriesId, lang: 'en', episodeNo: Number(chapter[3] === undefined ? chapter[2] : `${chapter[2]}.${chapter[3]}`) };
  }
  const series = url.pathname.match(/^\/([^/]+)\/?$/);
  const seriesId = series ? cleanSlug(series[1]) : null;
  return seriesId ? { seriesId, lang: 'en' } : null;
}

export const seriesUrl = (slug) => `${SITE}/${encodeURIComponent(slug)}`;
/** Following needs a numeric chapter id; Siren's own ids are hex strings. */
export const chapterIdFor = (number) => Math.round(Number(number) * 1000);

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

const plainText = (html) => decodeHtml(String(html ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * An image link on the CDN. wsrv.nl proxy links ("https://wsrv.nl/?url=
 * cdn.meowing.org/uploads/x.avif&w=200") are unwrapped to the original.
 */
export function imageUrl(value) {
  let url;
  try { url = new URL(decodeHtml(String(value ?? '')).trim(), SITE); } catch { return ''; }
  if (url.hostname === 'wsrv.nl') {
    const inner = url.searchParams.get('url') ?? '';
    try { url = new URL(/^https?:\/\//i.test(inner) ? inner : `https://${inner}`); } catch { return ''; }
    url.protocol = 'https:';
  }
  return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.hostname) ? url.href : '';
}

/** Series metadata and its uid from the series page. */
export function parseSeriesPage(html, slug) {
  const text = String(html ?? '');
  const list = /<div[^>]*id="chapters-list"[^>]*>/i.exec(text)?.[0] ?? '';
  const uid = /data-series-uid="([0-9a-z]+)"/i.exec(list)?.[1] ?? '';
  const heading = /<h1 class="text-2xl[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
  const ogTitle = /<meta property="og:title" content="([^"]*)"/i.exec(text);
  const title = (heading ? plainText(heading[1]) : '')
    || decodeHtml(ogTitle?.[1] ?? '').replace(/\s*\|\s*Siren Scans$/i, '').trim()
    || slug;
  const type = /mb-1\.5">Type<\/div>[\s\S]*?<span class="text-sm font-bold[^"]*">([^<]*)<\/span>/i.exec(text)?.[1]?.trim() ?? '';
  if (/^novel$/i.test(type)) {
    throw new FetchError(`"${title}" is a text novel on Siren Scans, not a comic, so it has no pages to download.`);
  }
  if (!uid) throw new FetchError(`Siren Scans has no chapter list on the page for "${slug}". Check the link opens on sirenscans.com.`);
  const summary = /<meta property="og:description" content="([^"]*)"/i.exec(text)
    ?? /<meta name="description" content="([^"]*)"/i.exec(text);
  const cover = /<meta property="og:image" content="([^"]*)"/i.exec(text);
  return {
    uid,
    title,
    author: '',
    summary: summary ? decodeHtml(summary[1]).trim() : '',
    cover: cover ? imageUrl(cover[1]) : '',
  };
}

const attr = (tag, name) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return match ? decodeHtml(match[1]) : undefined;
};

/** Whether a chapter row is locked: any one signal is enough. */
export function isLockedRow(row) {
  return row.locked !== '0' || row.paid !== '0' || Number(row.coins) > 0 || (Number(row.tier) > 0 && row.tierUnlocked !== '1');
}

/** Chapters from the _chapters_html answer. */
export function parseChapterList(json, slug) {
  if (!json || json.success !== true || typeof json.rows_html !== 'string') {
    throw new FetchError(`Siren Scans returned no chapter list for "${slug}".`);
  }
  const chapters = [];
  const seen = new Set();
  for (const [tag] of json.rows_html.matchAll(/<a\s[^>]*class="chapter-row[^>]*>/gi)) {
    const path = attr(tag, 'data-ch-url') ?? attr(tag, 'href') ?? '';
    const match = CHAPTER_PATH.exec(path);
    if (!match || match[1] !== slug) continue;
    const label = attr(tag, 'data-ch-label') ?? '';
    const fromLabel = /chapter\s*(\d+(?:\.\d+)?)/i.exec(label)?.[1];
    const number = Number(fromLabel ?? (match[3] === undefined ? match[2] : `${match[2]}.${match[3]}`));
    if (!Number.isFinite(number) || number < 0 || seen.has(number)) continue;
    seen.add(number);
    const row = {
      locked: attr(tag, 'data-ch-locked') ?? '0',
      paid: attr(tag, 'data-ch-paid') ?? '0',
      coins: attr(tag, 'data-ch-coins') ?? '0',
      tier: attr(tag, 'data-ch-tier') ?? '0',
      tierUnlocked: attr(tag, 'data-ch-tier-unlocked') ?? '0',
    };
    const locked = isLockedRow(row);
    const seconds = Number(attr(tag, 'data-ch-date'));
    chapters.push({
      number,
      title: label.replace(/^chapter\s*[\d.]+\s*[-:–—]?\s*/i, '').trim(),
      date: seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : '',
      url: `${SITE}${path}`,
      chapterId: chapterIdFor(number),
      isFree: !locked,
      ...(locked ? { lock: { price: Number(row.coins) || 0 } } : {}),
    });
  }
  return chapters.sort((a, b) => a.number - b.number);
}

function lockedError(number, price) {
  const cost = Number(price) > 0 ? `costs ${Number(price)} coins` : 'is locked';
  return new ProtectedContentError(
    `Siren Scans chapter ${number} ${cost}. This extension only downloads free chapters and does not unlock paid ones.`,
    { price: Number(price) || 0 },
  );
}

/** Page images from a chapter page, in the reader's order. */
export function parseChapterImages(html, expectedNumber, slug) {
  const text = String(html ?? '');
  const block = /<script id="chapter-offline-data" type="application\/json">([\s\S]*?)<\/script>/i.exec(text);
  let data = null;
  if (block) {
    try { data = JSON.parse(block[1]); } catch { data = null; }
  }
  if (!data || !Array.isArray(data.pages) || !data.pages.length) {
    // Second line of defence: no page list means the site withheld it.
    throw lockedError(expectedNumber);
  }
  if (data.novel === true) {
    throw new FetchError(`Siren Scans chapter ${expectedNumber} is a text chapter, not comic pages.`);
  }
  if (slug && data.seriesSlug && data.seriesSlug !== slug) {
    throw new FetchError(`Siren Scans answered a chapter of "${data.seriesSlug}" when asked for "${slug}".`);
  }
  const label = /chapter\s*(\d+(?:\.\d+)?)/i.exec(String(data.chapterLabel ?? ''))?.[1];
  if (label !== undefined && Number(label) !== Number(expectedNumber)) {
    throw new FetchError(`Siren Scans answered chapter ${label} when asked for ${expectedNumber}.`);
  }
  const images = [];
  const seen = new Set();
  for (const value of data.pages) {
    const url = imageUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    images.push({ url, index: images.length + 1 });
  }
  if (!images.length) throw new FetchError(`Siren Scans chapter ${expectedNumber} has no pages yet.`);
  return images;
}

/** /?_ajax=suggest results: comics only. */
export function parseSearchResults(json) {
  if (!json || json.success !== true || !Array.isArray(json.items)) return [];
  const results = [];
  for (const item of json.items) {
    if (/novel/i.test(String(item?.type ?? ''))) continue;
    const seriesId = cleanSlug(String(item?.url ?? '').replace(/^\//, '').replace(/\/$/, ''));
    if (!seriesId || CHAPTER_PATH.test(`/${seriesId}`)) continue;
    results.push({
      seriesId,
      title: String(item.title ?? '').trim() || seriesId,
      author: '',
      thumbnail: imageUrl(item.cover),
      url: seriesUrl(seriesId),
    });
  }
  return results.slice(0, SEARCH_LIMIT);
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

const pageText = async (ctx, url) => (await ctx.fetchRaw(url)).text();

export const sirenAdapter = {
  id: 'siren',
  label: 'Siren Scans',
  hostPatterns: ['sirenscans.com'],
  capabilities: { search: true, originalQuality: false, download: true, languages: ['en'] },
  parseUrl,

  async search(query, _lang, ctx) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    return parseSearchResults(await ctx.fetchJson(`${SITE}/?_ajax=suggest&q=${encodeURIComponent(q)}`));
  },

  async getSeries(ref, ctx) {
    let info;
    try {
      info = parseSeriesPage(await pageText(ctx, seriesUrl(ref.seriesId)), ref.seriesId);
    } catch (error) {
      if (error?.status === 404) {
        throw new FetchError(`Siren Scans has no series "${ref.seriesId}". Check the link opens on sirenscans.com.`, { status: 404 });
      }
      throw error;
    }
    const params = new URLSearchParams({ series_uid: info.uid, series_slug: ref.seriesId });
    const chapters = parseChapterList(await ctx.fetchJson(`${SITE}/?_chapters_html=1&${params}`), ref.seriesId);
    if (!chapters.length) throw new FetchError(`No Siren Scans chapters found for "${ref.seriesId}".`);
    const { uid: _uid, ...series } = info;
    return { ...series, chapters };
  },

  async getChapterImages(ref, chapter, ctx) {
    // Refuse a chapter the list marked as locked before any request.
    if (chapter?.isFree === false) throw lockedError(chapter.number, chapter.lock?.price);
    let url;
    try { url = new URL(chapter?.url ?? ''); } catch { url = null; }
    if (!url || url.protocol !== 'https:' || url.hostname !== 'sirenscans.com' || !CHAPTER_PATH.test(url.pathname)) {
      throw new FetchError(`Siren Scans chapter ${chapter?.number} has no valid link; reopen the series and try again.`);
    }
    return parseChapterImages(await pageText(ctx, url.href), chapter.number, ref?.seriesId);
  },
};
