/**
 * Eva Scans adapter (evascans.net; evascans.org redirects there).
 *
 * The same WordPress "MangaReader" theme as Violet Scans, down to the paid
 * chapter markup (a "#lockedChapterModal" button with data-coin and no link)
 * and the locked chapter page ("This chapter is locked", class="lock-card"),
 * so it is built from violet.js. Only the series path differs: /series/{slug}/.
 * Images are on evascans.net itself; covers come through Jetpack's i*.wp.com
 * CDN and are read from evascans.net instead.
 */

import { createMangaReaderSite } from './violet.js';

const eva = createMangaReaderSite({
  id: 'eva',
  label: 'Eva Scans',
  site: 'https://evascans.net',
  hosts: ['evascans.net', 'www.evascans.net', 'evascans.org', 'www.evascans.org'],
  hostPatterns: ['evascans.net', 'evascans.org'],
  seriesPath: 'series',
});

export const { parseUrl, seriesUrl, parseSeriesPage, seriesSlugFromChapterPage, parseChapterImages, parseSearchPage } = eva;
export const evaAdapter = eva.adapter;
