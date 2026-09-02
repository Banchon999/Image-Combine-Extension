/**
 * webtoons.com adapter.
 *
 * Every selector and URL shape below was verified against the live site rather
 * than assumed; where a naive selector would have been wrong, the comment says
 * so, because these are exactly the things that break silently on a redesign.
 */

import { FetchError, UnsupportedUrlError } from '../common/errors.js';

export const LANGUAGES = ['en', 'zh-hant', 'th', 'id', 'es', 'fr', 'de'];

const ORIGIN = 'https://www.webtoons.com';
// A series with hundreds of episodes paginates ~10 per page; this only exists
// so a markup change that breaks the "no new episodes" check cannot spin forever.
const MAX_LIST_PAGES = 500;

/* ------------------------------------------------------------------ *
 * Pure URL helpers (no DOM, no network -- unit tested outside a browser)
 * ------------------------------------------------------------------ */

/**
 * Parse any webtoons.com series or viewer URL.
 * Accepts both www and m (mobile) hosts.
 *
 * @returns {{seriesId: string, lang: string, genre: string, slug: string, episodeNo?: number}|null}
 */
export function parseUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (!/(^|\.)webtoons\.com$/i.test(url.hostname)) return null;

  const titleNo = url.searchParams.get('title_no');
  if (!titleNo || !/^\d+$/.test(titleNo)) return null;

  // Path is /{lang}/{genre}/{slug}/(list|{episode-slug}/viewer)
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const [lang, genre = '', slug = ''] = segments;
  const episodeParam = url.searchParams.get('episode_no');
  const episodeNo = episodeParam && /^\d+$/.test(episodeParam) ? Number(episodeParam) : undefined;

  return {
    seriesId: titleNo,
    lang: LANGUAGES.includes(lang) ? lang : 'en',
    genre,
    slug,
    ...(episodeNo === undefined ? {} : { episodeNo }),
  };
}

/** URL of one page of the episode list. */
export function buildListUrl({ lang, genre, slug, seriesId }, page = 1) {
  const path = `/${lang}/${genre || 'unknown'}/${slug || 'series'}/list`;
  return `${ORIGIN}${path}?title_no=${encodeURIComponent(seriesId)}&page=${page}`;
}

/** URL of the search results page for a language. */
export function buildSearchUrl(query, lang = 'en') {
  const safeLang = LANGUAGES.includes(lang) ? lang : 'en';
  return `${ORIGIN}/${safeLang}/search?keyword=${encodeURIComponent(query)}`;
}

/**
 * Turn a CDN image URL into its original-quality form.
 *
 * The viewer serves episode images with `?type=q90`, a server-side
 * recompression. Dropping just that parameter returns the source encode at the
 * same pixel dimensions -- measured at 159 KB vs 57 KB on a sample page, so
 * this is a real quality difference and not a placebo.
 *
 * Only the `type` parameter is removed; other parameters (cache-busting `t`,
 * for instance) are load-bearing and must survive.
 */
export function toOriginalQuality(imageUrl) {
  try {
    const url = new URL(imageUrl);
    if (!url.searchParams.has('type')) return imageUrl;
    url.searchParams.delete('type');
    // Avoid leaving a bare "?" behind when `type` was the only parameter.
    return url.searchParams.size === 0
      ? `${url.origin}${url.pathname}`
      : url.toString();
  } catch {
    return imageUrl;
  }
}

/* ------------------------------------------------------------------ *
 * DOM parsers (take a Document; exercised against fixtures in Chromium)
 * ------------------------------------------------------------------ */

const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');

/** Series title/author/summary/cover from a list page. */
export function parseSeriesMeta(doc) {
  const meta = (property) =>
    doc.querySelector(`meta[property="${property}"]`)?.getAttribute('content') ?? '';

  return {
    title: meta('og:title') || text(doc.querySelector('h1.subj, .info .subj')) || 'Untitled',
    author: text(doc.querySelector('.author_area .author, .author_area, .author')),
    summary: meta('og:description') || text(doc.querySelector('.summary')),
    cover: meta('og:image'),
  };
}

/**
 * Episode entries from one list page.
 *
 * The episode number comes from the `data-episode-no` attribute on the <li>,
 * not from parsing the href. Both are present, but the attribute is
 * authoritative and survives href format changes.
 */
export function parseChapterList(doc) {
  const items = doc.querySelectorAll('ul#_listUl li._episodeItem, li._episodeItem');
  const chapters = [];

  for (const li of items) {
    const raw = li.getAttribute('data-episode-no');
    const number = Number(raw);
    if (!Number.isFinite(number)) continue;

    const anchor = li.querySelector('a.detail_list_link, a[href*="viewer"]');
    chapters.push({
      number,
      title: text(li.querySelector('span.subj span, span.subj')) || `Episode ${number}`,
      date: text(li.querySelector('span.date')),
      thumbnail: li.querySelector('span.thmb img')?.getAttribute('src') ?? '',
      url: anchor?.getAttribute('href') ?? '',
    });
  }
  return chapters;
}

/** Highest `page=` number linked from the paginator, or 1 if unpaginated. */
export function parseMaxPage(doc) {
  let max = 1;
  for (const a of doc.querySelectorAll('div.paginate a[href*="page="]')) {
    const match = (a.getAttribute('href') ?? '').match(/[?&]page=(\d+)/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * Episode image references from a viewer page.
 *
 * Scoping to `#_imageList img._images` is essential, not stylistic: the viewer
 * page carries over 1300 `data-url` attributes, nearly all of them lazy-loaded
 * recommendation thumbnails. A bare `[data-url]` selector returns those too and
 * would download a few hundred unrelated images per chapter.
 */
export function parseViewerImages(doc, { originalQuality = true } = {}) {
  const nodes = doc.querySelectorAll('#_imageList img._images, #_imageList img[data-url]');
  const images = [];

  for (const img of nodes) {
    const raw = img.getAttribute('data-url');
    if (!raw) continue;
    const preferred = originalQuality ? toOriginalQuality(raw) : raw;
    // width/height are published in the markup, which lets the PDF writer size
    // pages without decoding a single image.
    const width = Number(img.getAttribute('width'));
    const height = Number(img.getAttribute('height'));
    images.push({
      url: preferred,
      // Some WEBTOON CDN edges reject the source URL while still serving the
      // published q90 variant. Keep it as a per-page fallback instead of
      // throwing away the whole chapter when "original quality" is enabled.
      ...(preferred !== raw ? { fallbackUrl: raw } : {}),
      index: images.length + 1,
      ...(Number.isFinite(width) && width > 0 ? { width: Math.round(width) } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height: Math.round(height) } : {}),
    });
  }
  return images;
}

/**
 * Search results.
 *
 * Results are `a.link._card_item` carrying `data-title-no`; the title lives in
 * `strong.title`, not the `.subj` class the series pages use.
 */
export function parseSearchResults(doc) {
  const results = [];
  for (const a of doc.querySelectorAll('a._card_item[data-title-no], a[data-title-no]')) {
    const seriesId = a.getAttribute('data-title-no');
    const href = a.getAttribute('href') ?? '';
    if (!seriesId || !href.includes('title_no=')) continue;
    results.push({
      seriesId,
      title: text(a.querySelector('strong.title, .info_text .title')) || 'Untitled',
      author: text(a.querySelector('.author')),
      thumbnail: a.querySelector('.image_wrap img, img')?.getAttribute('src') ?? '',
      url: new URL(href, ORIGIN).toString(),
    });
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

/** @type {import('./types.js').SiteAdapter} */
export const webtoonsAdapter = {
  id: 'webtoons',
  label: 'WEBTOON',
  hostPatterns: ['webtoons.com'],
  capabilities: {
    search: true,
    originalQuality: true,
    download: true,
    languages: LANGUAGES,
  },

  parseUrl,

  async search(query, lang, ctx) {
    const doc = await ctx.fetchDoc(buildSearchUrl(query, lang));
    return parseSearchResults(doc);
  },

  async getSeries(ref, ctx) {
    const firstPage = await ctx.fetchDoc(buildListUrl(ref, 1));
    const meta = parseSeriesMeta(firstPage);

    const byNumber = new Map();
    for (const chapter of parseChapterList(firstPage)) byNumber.set(chapter.number, chapter);

    // The paginator only exposes a sliding window of page links, so the last
    // page is discovered by walking forward rather than read off page 1.
    let page = 1;
    let knownMax = parseMaxPage(firstPage);
    while (page < knownMax && page < MAX_LIST_PAGES) {
      page += 1;
      if (ctx.signal?.aborted) break;
      const doc = await ctx.fetchDoc(buildListUrl(ref, page));
      const chapters = parseChapterList(doc);
      const before = byNumber.size;
      for (const chapter of chapters) byNumber.set(chapter.number, chapter);
      // Stop on an empty page, or one that adds nothing new: past the end the
      // site re-serves the last page instead of returning an error.
      if (chapters.length === 0 || byNumber.size === before) break;
      knownMax = Math.max(knownMax, parseMaxPage(doc));
    }

    return {
      ...meta,
      chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
    };
  },

  async getChapterImages(ref, chapter, ctx, { originalQuality = true } = {}) {
    const url =
      chapter.url ||
      `${ORIGIN}/${ref.lang}/${ref.genre}/${ref.slug}/ep/viewer?title_no=${ref.seriesId}&episode_no=${chapter.number}`;
    const doc = await ctx.fetchDoc(url);
    const images = parseViewerImages(doc, { originalQuality });
    if (images.length === 0) {
      throw new FetchError(`No images found in chapter ${chapter.number}`, { url });
    }
    return images;
  },
};

/** Throwing variant of parseUrl, for call sites that need a hard failure. */
export function requireUrl(input) {
  const parsed = parseUrl(input);
  if (!parsed) throw new UnsupportedUrlError(`Not a webtoons.com series URL: ${input}`);
  return parsed;
}
