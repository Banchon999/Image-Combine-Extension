/**
 * Magus Manga adapter (magustoon.org).
 *
 * The same comic CMS as NYX Scans: the site's reader calls api.magustoon.org
 * with the same paths and fields (post, chapters, chapter, posts), so it is
 * built from nyx.js. Chapters carry explicit lock flags (isLocked,
 * isAccessible, price, isShortLinkLocked, isPermanentlyLocked); a locked one
 * is refused before any request. magusmanga.com is now an unrelated site and
 * is not handled here.
 */

import { createComicCmsSite } from './nyx.js';

const magus = createComicCmsSite({
  id: 'magus',
  label: 'Magus Manga',
  site: 'https://magustoon.org',
  api: 'https://api.magustoon.org/api',
  hosts: ['magustoon.org', 'www.magustoon.org'],
  hostPatterns: ['magustoon.org'],
});

export const { parseUrl, seriesUrl, parseSeriesInfo, parseChapterPage, parseChapterImages, parseSearchResults } = magus;
export const magusAdapter = magus.adapter;
