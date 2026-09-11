/** Kakao Page: free by default, optional existing-session access. Server authorization wins. */

import { FetchError, ProtectedContentError } from '../common/errors.js';
import { buildSiteSearchUrl, readSearchPage } from '../common/site-search.js';

const HOST = 'page.kakao.com';
const API = 'https://bff-page.kakao.com/api/gateway';
// The list API pages through a cursor; 100 is comfortably above the largest
// window it will return, so most series need a single request.
const WINDOW_SIZE = 100;
// Only exists so a change in the pagination contract cannot spin forever.
const MAX_PAGES = 100;

/**
 * Parse a Kakao Page content or viewer URL.
 *
 * Shapes handled:
 *   https://page.kakao.com/content/69103222
 *   https://page.kakao.com/content/69103222/viewer/69302779
 *
 * @returns {{seriesId: string, lang: string, episodeNo?: number}|null}
 */
export function parseUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== HOST) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const contentIndex = segments.indexOf('content');
  if (contentIndex === -1) return null;

  const seriesId = segments[contentIndex + 1];
  if (!seriesId || !/^\d+$/.test(seriesId)) return null;

  const viewerIndex = segments.indexOf('viewer');
  const rawEpisode = viewerIndex === -1 ? undefined : segments[viewerIndex + 1];
  const episodeNo = rawEpisode && /^\d+$/.test(rawEpisode) ? Number(rawEpisode) : undefined;

  return {
    seriesId,
    lang: 'ko',
    ...(episodeNo === undefined ? {} : { episodeNo }),
  };
}

/** Shown whenever a locked chapter is skipped. Kept in one place so it stays consistent. */
export const LOCKED_MESSAGE =
  'This Kakao chapter is not marked free. If you already bought or rented it and can read it ' +
  'in this browser, enable "Use my existing Kakao access" and select it explicitly. ' +
  'The extension does not purchase, unlock or decrypt chapters.';

export function buildListUrl(seriesId, cursorIndex) {
  return (
    `${API}/api/v2/content/product/list?series_id=${encodeURIComponent(seriesId)}` +
    `&cursor_index=${cursorIndex}&cursor_direction=NEXT` +
    `&window_size=${WINDOW_SIZE}&sort_type=asc`
  );
}

export function buildViewerUrl(seriesId, productId) {
  return (
    `${API}/api/v1/viewer/data?series_id=${encodeURIComponent(seriesId)}` +
    `&product_id=${encodeURIComponent(productId)}`
  );
}

// The list API returns `thumbnail` as a bare storage key ("kid") such as
// "5bBdC/dJMcahC3iav/BAfwXGez7VfQ4KveEsiZD0" rather than a URL. The Kakao image
// CDN serves that key as an image, and its host is already covered by the
// Referer rule, so the panel can load it.
const THUMBNAIL_BASE = 'https://page-images.kakaoentcdn.com/download/resource?kid=';

/**
 * Turn a Kakao thumbnail reference into a loadable URL.
 *
 * A bare storage key is expanded onto the image CDN; an already-absolute URL
 * (or a protocol-relative one) is passed through unchanged so a future API
 * that returns full URLs keeps working. Anything empty yields '' so the panel
 * falls back to its placeholder tile instead of a broken image.
 */
export function buildThumbnailUrl(thumbnail) {
  const key = String(thumbnail ?? '').trim();
  if (!key) return '';
  if (/^https?:\/\//i.test(key)) return key;
  if (key.startsWith('//')) return `https:${key}`;
  return `${THUMBNAIL_BASE}${encodeURIComponent(key)}`;
}

/**
 * Map one page of the list API onto chapters.
 *
 * `cursor_index` is the site's own 1-based position in the series and is used
 * as the chapter number, because Kakao titles carry the episode number as text
 * ("... 3화") rather than a separate field.
 */
export function parseChapterPage(result) {
  const chapters = [];
  for (const entry of result?.list ?? []) {
    const item = entry?.item;
    if (!item?.product_id) continue;
    chapters.push({
      number: Number(entry.cursor_index),
      title: String(item.title ?? '').trim(),
      productId: String(item.product_id),
      // The authoritative signal. Anything not explicitly true is treated as locked.
      isFree: item.is_free === true,
      pageCount: item.page_count,
    });
  }
  return chapters;
}

/** Extract image references from viewer data. */
export function parseViewerImages(viewerData) {
  if (viewerData?.type !== 'ImageViewerData') {
    throw new FetchError(`Unsupported Kakao viewer type: ${viewerData?.type ?? 'none'}`);
  }
  const files = viewerData.imageDownloadData?.files ?? [];
  if (!Array.isArray(files)) throw new FetchError('Kakao image list has an unexpected format.');
  return files.map((file, index) => {
    if (typeof file?.secureUrl !== 'string' || !/^https?:\/\//i.test(file.secureUrl)) {
      throw new FetchError(`Kakao image ${index + 1} has no valid download URL.`);
    }
    return {
      url: file.secureUrl,
      index: Number(file.no) || index + 1,
      ...(Number(file.width) > 0 ? { width: Number(file.width) } : {}),
      ...(Number(file.height) > 0 ? { height: Number(file.height) } : {}),
    };
  }).sort((a, b) => a.index - b.index);
}

/** @type {import('./types.js').SiteAdapter} */
export const kakaoAdapter = {
  id: 'kakao',
  label: 'Kakao Page',
  hostPatterns: [HOST],
  capabilities: {
    search: true,
    // Image URLs are signed; there is no quality parameter to strip.
    originalQuality: false,
    download: true,
    languages: ['ko'],
    // Free-only remains the default, but an explicit job can use existing access.
    freeChaptersOnly: false,
    accountAccess: true,
  },

  parseUrl,

  async search(query, _lang, ctx) {
    const result = readSearchPage('kakao', await ctx.fetchDoc(buildSiteSearchUrl('kakao', query)));
    if (!result.ready) throw new FetchError('Kakao search needs a rendered page. Use Search in the extension.');
    return result.items;
  },

  async getSeries(ref, ctx) {
    // Keyed by product id so a repeated page cannot produce duplicate chapters,
    // which would otherwise be downloaded twice.
    const byProduct = new Map();
    let cursor = 0;
    let seriesItem = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (ctx.signal?.aborted) break;
      const json = await ctx.fetchJson(buildListUrl(ref.seriesId, cursor));
      const result = json?.result;
      if (!result || !Array.isArray(result.list)) throw new FetchError(`Kakao list API returned an unexpected response for ${ref.seriesId}. Open the series on page.kakao.com, then retry and include this series URL if it fails.`);

      seriesItem ??= result.series_item;
      const batch = parseChapterPage(result);
      if (batch.length === 0) break;

      const before = byProduct.size;
      for (const chapter of batch) byProduct.set(chapter.productId, chapter);
      // A page that adds nothing new means the cursor is not advancing.
      if (byProduct.size === before) break;

      if (!result.has_next) break;
      const next = batch[batch.length - 1].number;
      if (!Number.isFinite(next) || next <= cursor) break;
      cursor = next;
    }

    const chapters = [...byProduct.values()];
    if (chapters.length === 0) {
      throw new FetchError(`No chapters found for Kakao series ${ref.seriesId}`);
    }

    return {
      title: seriesItem?.title ?? `Kakao ${ref.seriesId}`,
      author: [seriesItem?.operator_property?.author, seriesItem?.operator_property?.illustrator]
        .filter(Boolean)
        .join(', '),
      summary: seriesItem?.operator_property?.description ?? '',
      cover: buildThumbnailUrl(seriesItem?.thumbnail),
      chapters: chapters.sort((a, b) => a.number - b.number),
    };
  },

  /**
   * Image references for one chapter.
   *
   * Default mode refuses non-free chapters before a request. Explicit account
   * mode asks the existing read-only viewer endpoint with the user's browser
   * session. No guessed entitlement flags, ticket/purchase endpoint, token
   * extraction, or decryption. A successful supported response is required.
   */
  async getChapterImages(ref, chapter, ctx, opts = {}) {
    if (chapter?.isFree !== true && opts.kakaoAccountAccess !== true) {
      throw new ProtectedContentError(LOCKED_MESSAGE, {
        site: 'kakao',
        seriesId: ref?.seriesId,
        chapter: chapter?.number,
      });
    }

    let json;
    try {
      json = await ctx.fetchJson(buildViewerUrl(ref.seriesId, chapter.productId));
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        throw new FetchError(
          `Kakao viewer request was rejected (HTTP ${error.status}). ` +
          'Check that this episode opens in the same browser/profile and that your rental is still valid. ' +
          'If it opens there, the extension session/API may differ; this error does not prove you lack access or that DRM is present.',
          { status: error.status },
        );
      }
      throw error;
    }

    // A missing field does not prove a paywall: it may be an API/schema error.
    // Preserve the server's decision without mislabelling every failure as DRM.
    const viewerData = json?.viewer_data ?? json?.result?.viewer_data;
    if (!viewerData) {
      throw new FetchError(
        `Kakao returned no viewer data for episode ${chapter.productId ?? chapter.number}. ` +
        'Open this episode on page.kakao.com to check access, then retry. ' +
        'If it still fails, share the episode URL and this error.',
      );
    }

    const images = parseViewerImages(viewerData);
    if (images.length === 0) {
      throw new FetchError(`Kakao chapter ${chapter.number} returned no images`);
    }
    return images.map(image => ({ ...image, requirePlainImage: true }));
  },
};
