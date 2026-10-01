import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webtoonsAdapter, buildEpisodesApiUrl, parseEpisodesApi, isCanvas } from '../../src/adapters/webtoons.js';

// Rows trimmed from live m.webtoons.com/api/v1/webtoon/95/episodes (2026-10-01).
const row = (n, extra = {}) => ({
  episodeNo: n,
  thumbnail: `/20250116_127/thumb_${n}.png`,
  episodeTitle: `[Season 3] Ep. ${n - 418}`,
  viewerLink: `/en/fantasy/tower-of-god/season-3-ep-${n - 418}/viewer?title_no=95&episode_no=${n}`,
  exposureDateMillis: 1740362508000,
  displayUp: false,
  hasBgm: false,
  ...extra,
});
const REF = { seriesId: '95', lang: 'en', genre: 'fantasy', slug: 'tower-of-god' };

/** A list page as parseSeriesMeta / parseChapterList / parseMaxPage see it. */
function listPage(numbers = [], title = 'Tower of God') {
  const item = (n) => ({
    getAttribute: (name) => (name === 'data-episode-no' ? String(n) : null),
    querySelector: (selector) => (selector.includes('subj')
      ? { textContent: `Ep. ${n}` }
      : selector.includes('date') ? { textContent: 'Feb 23, 2025' } : null),
  });
  return {
    querySelector: (selector) => (selector === 'meta[property="og:title"]' ? { getAttribute: () => title } : null),
    querySelectorAll: (selector) => (selector.includes('_episodeItem') ? numbers.map(item) : []),
  };
}

test('WEBTOON: episode API URLs for originals and CANVAS', () => {
  assert.equal(buildEpisodesApiUrl(REF), 'https://m.webtoons.com/api/v1/webtoon/95/episodes?pageSize=1000');
  assert.equal(buildEpisodesApiUrl(REF, 1000), 'https://m.webtoons.com/api/v1/webtoon/95/episodes?pageSize=1000&cursor=1000');
  const canvas = { seriesId: '803012', lang: 'en', genre: 'canvas', slug: 'barcoded' };
  assert.equal(isCanvas(canvas), true);
  assert.equal(isCanvas({ genre: 'challenge' }), true);
  assert.equal(isCanvas(REF), false);
  assert.equal(buildEpisodesApiUrl(canvas), 'https://m.webtoons.com/api/v1/canvas/803012/episodes?pageSize=1000');
});

test('WEBTOON: episode API rows become chapters with absolute links and the site\'s date', () => {
  const { chapters, nextCursor } = parseEpisodesApi({ result: { episodeList: [row(653, { episodeTitle: '[Season 3] Ep. 235 (Season 3 Finale)' })], nextCursor: 0 } });
  assert.equal(nextCursor, 0);
  assert.deepEqual(chapters, [{
    number: 653,
    title: '[Season 3] Ep. 235 (Season 3 Finale)',
    // 2025-02-24 02:01 UTC is the evening of Feb 23 in the US, as the site lists it.
    date: '2025-02-23',
    thumbnail: 'https://webtoon-phinf.pstatic.net/20250116_127/thumb_653.png',
    url: 'https://www.webtoons.com/en/fantasy/tower-of-god/season-3-ep-235/viewer?title_no=95&episode_no=653',
  }]);
  assert.equal(parseEpisodesApi({ result: { episodeList: [], nextCursor: 600 } }).nextCursor, 600);
  // A CANVAS id asked of the originals endpoint answers {result:null,success:false}.
  assert.throws(() => parseEpisodesApi({ result: null, message: null, success: false }), /no episode list/);
});

test('WEBTOON: getSeries takes the whole list from the API in one request', async () => {
  const docs = [];
  const json = [];
  const series = await webtoonsAdapter.getSeries(REF, {
    fetchDoc: async (url) => { docs.push(url); return listPage([653, 652, 651]); },
    fetchJson: async (url) => { json.push(url); return { result: { episodeList: Array.from({ length: 652 }, (_, i) => row(i + 2)), nextCursor: 0 } }; },
  });
  assert.equal(docs.length, 1, 'only the first list page, for title and cover');
  assert.equal(json.length, 1);
  assert.equal(series.title, 'Tower of God');
  assert.equal(series.chapters.length, 652);
  assert.equal(series.chapters[0].number, 2);
  assert.equal(series.chapters.at(-1).number, 653);
});

test('WEBTOON: getSeries follows the API cursor', async () => {
  const json = [];
  const series = await webtoonsAdapter.getSeries(REF, {
    fetchDoc: async () => listPage([1500]),
    fetchJson: async (url) => {
      json.push(url);
      const cursor = Number(new URL(url).searchParams.get('cursor') ?? 0);
      const from = cursor + 1;
      const to = Math.min(cursor + 1000, 1500);
      return { result: { episodeList: Array.from({ length: to - from + 1 }, (_, i) => row(from + i)), nextCursor: to < 1500 ? to : 0 } };
    },
  });
  assert.equal(json.length, 2);
  assert.match(json[1], /cursor=1000$/);
  assert.equal(series.chapters.length, 1500);
});

test('WEBTOON: falls back to the HTML list if the API fails or misses an episode', async () => {
  for (const fetchJson of [
    async () => { throw new Error('HTTP 500'); },
    // Missing the newest episode the list page shows: not trusted.
    async () => ({ result: { episodeList: [row(651), row(652)], nextCursor: 0 } }),
  ]) {
    const docs = [];
    const series = await webtoonsAdapter.getSeries(REF, {
      fetchDoc: async (url) => { docs.push(url); return listPage([653, 652, 651]); },
      fetchJson,
    });
    assert.ok(docs.length >= 1);
    assert.deepEqual(series.chapters.map((c) => c.number), [651, 652, 653]);
    assert.equal(series.chapters[0].title, 'Ep. 651', 'chapters come from the HTML list');
  }
});
