/** Korean NAVER Webtoon: JSON episode listing and HTML chapter images. */
import { FetchError, CancelledError } from '../common/errors.js';
import { buildSiteSearchUrl, readSearchPage } from '../common/site-search.js';

const ROOT = 'https://comic.naver.com';
const HOSTS = ['comic.naver.com', 'm.comic.naver.com'];

export function parseUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.includes(url.hostname)) return null;
  const match = url.pathname.match(/^\/(webtoon|bestChallenge|challenge)\/(list|detail)(?:\.nhn)?\/?$/);
  const seriesId = url.searchParams.get('titleId');
  if (!match || !/^\d+$/.test(seriesId ?? '')) return null;
  const no = url.searchParams.get('no');
  return { seriesId, lang: 'ko', section: match[1],
    ...(no && /^\d+$/.test(no) ? { episodeNo: Number(no) } : {}) };
}

export function buildListUrl(ref, page = 1) {
  return `${ROOT}/api/article/list?titleId=${encodeURIComponent(ref.seriesId)}&page=${page}&sort=ASC`;
}

export function chapterUrl(ref, number) {
  const section = ['webtoon', 'bestChallenge', 'challenge'].includes(ref.section) ? ref.section : 'webtoon';
  return `${ROOT}/${section}/detail?titleId=${encodeURIComponent(ref.seriesId)}&no=${number}`;
}

export function parseChapterPage(json, ref) {
  if (!Array.isArray(json?.articleList)) {
    throw new FetchError('NAVER returned no episode list. Open the series in your browser to check access.');
  }
  return json.articleList.filter(c => Number.isSafeInteger(Number(c.no)) && Number(c.no) > 0)
    .map(c => ({ number: Number(c.no), title: String(c.subtitle ?? ''),
      date: c.serviceDateDescription ?? '', url: chapterUrl(ref, Number(c.no)) }));
}

/** Read a series title from a NAVER list page's og:title, '' if unavailable. */
export function parseListPageTitle(doc) {
  const title = doc?.querySelector?.('meta[property="og:title"]')?.getAttribute('content');
  return String(title ?? '').trim();
}

/** Fetch the list page and read its og:title; never throws (best-effort title). */
async function readListPageTitle(ref, ctx) {
  try {
    const doc = await ctx.fetchDoc(`${ROOT}/webtoon/list?titleId=${encodeURIComponent(ref.seriesId)}`);
    return parseListPageTitle(doc);
  } catch {
    return '';
  }
}

export function parseViewerImages(doc) {
  const images = [];
  const seen = new Set();
  // Mobile browsers are redirected to m.comic.naver.com. That viewer uses
  // img.toon_image, with the real page in data-src and a transparent src until
  // scrolled into view. Do not broaden this to all images (ads/covers/avatars).
  for (const img of doc.querySelectorAll('#comic_view_area img, .wt_viewer img, img.toon_image')) {
    const src = img.getAttribute('data-src')?.trim() || img.getAttribute('src')?.trim();
    if (!src) continue;
    let url;
    try { url = new URL(src, ROOT); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.pathname.includes('/static/')) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const width = Number(img.getAttribute('width'));
    const height = Number(img.getAttribute('height'));
    images.push({ url: url.href, index: images.length + 1,
      ...(width > 0 ? { width } : {}), ...(height > 0 ? { height } : {}) });
  }
  return images;
}

export const naverAdapter = {
  id: 'naver', label: 'NAVER Webtoon', hostPatterns: HOSTS,
  capabilities: { search: true, originalQuality: false, download: true, languages: ['ko'] },
  parseUrl,
  async search(query, _lang, ctx) {
    const result = readSearchPage('naver', await ctx.fetchDoc(buildSiteSearchUrl('naver', query)));
    if (!result.ready) throw new FetchError('NAVER search needs a rendered page. Use Search in the extension.');
    return result.items;
  },
  async getSeries(ref, ctx) {
    let info = {};
    try {
      info = await ctx.fetchJson(`${ROOT}/api/article/list/info?titleId=${encodeURIComponent(ref.seriesId)}`);
    } catch (error) {
      if (ctx.signal?.aborted) throw new CancelledError();
      // Metadata failure need not discard an accessible episode list.
    }
    const chapters = new Map();
    let page = 1;
    for (let count = 0; count < 1000; count++) {
      if (ctx.signal?.aborted) throw new CancelledError();
      const json = await ctx.fetchJson(buildListUrl(ref, page));
      const batch = parseChapterPage(json, ref);
      const before = chapters.size;
      for (const chapter of batch) chapters.set(chapter.number, chapter);
      const next = Number(json.pageInfo?.nextPage);
      if (!next) break;
      if (!batch.length || before === chapters.size || !Number.isSafeInteger(next) || next <= page) {
        throw new FetchError('NAVER episode pagination stopped advancing; refusing an incomplete list.');
      }
      if (count === 999) throw new FetchError('NAVER episode list exceeded the pagination limit.');
      page = next;
    }
    if (!chapters.size) throw new FetchError(`No readable NAVER chapters for ${ref.seriesId}`);
    const artists = info?.communityArtists ?? {};
    const names = [...(artists.writers ?? []), ...(artists.painters ?? []), ...(artists.originAuthors ?? [])]
      .map(a => a.name).filter(Boolean);
    // `titleName` comes from the info endpoint, which can 403 or need a login
    // for some titles and was swallowed above. Without it the filename would be
    // the numeric series id ("NAVER 831555"); the list page carries the real
    // localized title in og:title, so read that before falling back to the id.
    let title = info?.titleName;
    if (!title) title = await readListPageTitle(ref, ctx);
    return { title: title || `NAVER ${ref.seriesId}`, author: [...new Set(names)].join(', '),
      summary: info?.synopsis ?? '', cover: info?.thumbnailUrl ?? '',
      chapters: [...chapters.values()].sort((a,b) => a.number - b.number) };
  },
  async getChapterImages(ref, chapter, ctx) {
    const doc = await ctx.fetchDoc(chapterUrl(ref, chapter.number));
    const images = parseViewerImages(doc);
    if (!images.length) throw new FetchError('No NAVER chapter images found. Check that this episode opens in your browser (login or access may be required).');
    return images;
  },
};
