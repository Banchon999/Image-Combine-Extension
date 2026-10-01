import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asuraAdapter, parseUrl, bareSlug, isEarlyAccess, parseSeriesInfo, parseChapterList,
  parseChapterImages, parseSearchResults,
} from '../../src/adapters/asura.js';
import { resolveUrl } from '../../src/adapters/registry.js';
import { FetchError, ProtectedContentError } from '../../src/common/errors.js';

// Shapes below are trimmed from live api.asurascans.com responses (2026-10-01).
const NOW = Date.parse('2026-10-01T06:32:00Z');
const CDN = 'https://cdn.asurascans.com/asura-images/chapters/nano-machine/332';

/* -------------------------------- URLs -------------------------------- */

test('series URL drops the rotating site-wide suffix', () => {
  assert.deepEqual(parseUrl('https://asurascans.com/comics/nano-machine-3ec3b16f'),
    { seriesId: 'nano-machine', lang: 'en' });
  // The suffix changes site-wide; an old link must map to the same series.
  assert.deepEqual(parseUrl('https://asurascans.com/comics/nano-machine-deadbeef/'),
    { seriesId: 'nano-machine', lang: 'en' });
  assert.deepEqual(parseUrl('https://www.asurascans.com/comics/nano-machine'),
    { seriesId: 'nano-machine', lang: 'en' });
});

test('chapter URL keeps decimal side chapters and chapter 0', () => {
  assert.equal(parseUrl('https://asurascans.com/comics/return-of-the-mount-hua-sect-3ec3b16f/chapter/152.5').episodeNo, 152.5);
  assert.equal(parseUrl('https://asurascans.com/comics/villain-to-kill-3ec3b16f/chapter/0').episodeNo, 0);
  assert.equal(parseUrl('https://asurascans.com/comics/nano-machine-3ec3b16f/chapter/332').episodeNo, 332);
});

test('rejects other paths, hosts and malformed chapter tokens', () => {
  for (const input of [
    'https://asurascans.com/novels/solo-swordmaster',
    'https://asurascans.com/browse?genres=action',
    'https://asurascans.com/comics/',
    'https://asurascans.com/comics/nano-machine/chapter/abc',
    'https://asurascans.com/comics/nano-machine/chapter/1e3',
    'https://asurascans.com.example.org/comics/nano-machine',
    'ftp://asurascans.com/comics/nano-machine',
    'https://asurascans.com/comics/Bad_Slug!',
    'not a url',
  ]) assert.equal(parseUrl(input), null, input);
});

test('registry routes Asura links to the Asura adapter', () => {
  const { adapter, ref } = resolveUrl('https://asurascans.com/comics/nano-machine-3ec3b16f/chapter/5');
  assert.equal(adapter.id, 'asura');
  assert.deepEqual(ref, { seriesId: 'nano-machine', lang: 'en', episodeNo: 5 });
});

test('bareSlug only strips an 8-hex suffix', () => {
  assert.equal(bareSlug('solo-swordmaster-3ec3b16f'), 'solo-swordmaster');
  assert.equal(bareSlug('the-s-classes-that-i-raised'), 'the-s-classes-that-i-raised');
  assert.equal(bareSlug('max-level-returner-123'), 'max-level-returner-123');
});

/* ------------------------------ early access ------------------------------ */

test('early access needs the premium flag and a future end date', () => {
  const future = '2026-10-01T09:18:50.434268Z';
  const past = '2026-10-01T06:14:26.213179Z';
  assert.equal(isEarlyAccess({ is_premium: true, early_access_until: future }, NOW), true);
  // The list endpoint keeps is_premium:true for a while after unlocking.
  assert.equal(isEarlyAccess({ is_premium: true, early_access_until: past }, NOW), false);
  assert.equal(isEarlyAccess({ is_premium: true }, NOW), true);
  assert.equal(isEarlyAccess({ is_premium: false, early_access_until: future }, NOW), false);
});

/* ------------------------------- parsing ------------------------------- */

test('chapter list sorts ascending and keeps decimals, chapter 0 and ids', () => {
  const chapters = parseChapterList({ data: [
    { id: 261902, number: 10, slug: 'chapter-10', is_premium: true,
      early_access_until: '2026-10-01T09:18:50.434268Z', published_at: '2026-10-01T03:18:50Z' },
    { id: 152281, number: 152.5, title: 'Side Story', is_premium: false, published_at: '2024-01-02T00:00:00Z' },
    { id: 152280, number: 0, is_premium: false, published_at: '2023-12-25T10:11:49Z' },
    { id: 999, number: 0, is_premium: false }, // duplicate number: first wins
    { id: 5, number: 'x' },
  ] }, 'war-of-extinction', NOW);

  assert.deepEqual(chapters.map((c) => c.number), [0, 10, 152.5]);
  assert.equal(chapters[0].chapterId, 152280);
  assert.equal(chapters[0].date, '2023-12-25');
  assert.equal(chapters[2].title, 'Side Story');
  assert.equal(chapters[2].url, 'https://asurascans.com/comics/war-of-extinction/chapter/152.5');
  assert.equal(chapters[1].isFree, false);
  assert.equal(chapters[1].unlockTime, '2026-10-01T09:18:50.434268Z');
  assert.equal(chapters[2].isFree, true);
  assert.equal('unlockTime' in chapters[2], false);
});

test('chapter list rejects a response without a data array', () => {
  assert.throws(() => parseChapterList({ error: 'series not found' }, 'x', NOW), FetchError);
});

test('series info strips HTML and joins author and artist', () => {
  const info = parseSeriesInfo({ series: {
    title: 'Nano Machine', author: 'Hanjung Wolya', artist: 'REDICE Studio',
    description: '<p>Nanotechnology meets martial arts &amp; more.</p><p>Second.</p>',
    cover: 'https://cdn.asurascans.com/asura-images/covers/nano-machine.e31bdb.webp',
  } }, 'nano-machine');
  assert.equal(info.title, 'Nano Machine');
  assert.equal(info.author, 'Hanjung Wolya, REDICE Studio');
  assert.equal(info.summary, 'Nanotechnology meets martial arts & more.\n\nSecond.');
  assert.equal(info.cover, 'https://cdn.asurascans.com/asura-images/covers/nano-machine.e31bdb.webp');

  const sparse = parseSeriesInfo({ series: { author: null, artist: 'Same', cover: 'javascript:alert(1)' } }, 'slug');
  assert.equal(sparse.title, 'slug');
  assert.equal(sparse.author, 'Same');
  assert.equal(sparse.cover, '');
});

test('chapter images keep order and dimensions, skip duplicates and non-https', () => {
  const images = parseChapterImages({ data: { access_gate: '', is_locked: false, unlock_time: null, chapter: {
    number: 332, pages: [
      { url: `${CDN}/8cdc64.webp?v=1790787858`, width: 1532, height: 1024 },
      { url: `${CDN}/8cdc64.webp?v=1790787858`, width: 1532, height: 1024 },
      { url: 'http://insecure.example/p.webp' },
      { url: `${CDN}/a1b2c3.webp`, width: 800 },
    ],
  } } }, 332);
  assert.deepEqual(images, [
    { url: `${CDN}/8cdc64.webp?v=1790787858`, index: 1, width: 1532, height: 1024 },
    { url: `${CDN}/a1b2c3.webp`, index: 2, width: 800 },
  ]);
});

test('a locked chapter response is protected and names the unlock time', () => {
  // Live response for war-of-extinction chapter 10 during early access: no pages.
  const locked = { data: { access_gate: '', is_locked: true, unlock_time: '2026-10-01T09:18:50.434268Z',
    chapter: { number: 10, page_count: 0, is_premium: true } } };
  assert.throws(() => parseChapterImages(locked, 10), (error) =>
    error instanceof ProtectedContentError && /early access until 2026-10-01 09:18 UTC/.test(error.message));
});

test('any access gate is treated as protected, never worked around', () => {
  const gated = { data: { access_gate: 'login', is_locked: false, chapter: { number: 3, pages: [{ url: `${CDN}/x.webp` }] } } };
  assert.throws(() => parseChapterImages(gated, 3), ProtectedContentError);
});

test('a mismatched or empty chapter response is a fetch error', () => {
  assert.throws(() => parseChapterImages({ data: { chapter: { number: 9, pages: [{ url: `${CDN}/x.webp` }] } } }, 10), FetchError);
  assert.throws(() => parseChapterImages({ data: { chapter: { number: 10, pages: [] } } }, 10), FetchError);
  assert.throws(() => parseChapterImages({}, 10), FetchError);
});

test('search results map slugs to series links', () => {
  const results = parseSearchResults({ data: [
    { slug: 'nano-machine', title: 'Nano Machine', author: 'Hanjung Wolya', cover: 'https://cdn.asurascans.com/c.webp' },
    { slug: 'Bad Slug' },
  ] });
  assert.deepEqual(results, [{ seriesId: 'nano-machine', title: 'Nano Machine', author: 'Hanjung Wolya',
    thumbnail: 'https://cdn.asurascans.com/c.webp', url: 'https://asurascans.com/comics/nano-machine' }]);
});

/* ------------------------------- adapter ------------------------------- */

test('a chapter listed as early access is refused before any request', async () => {
  const chapter = { number: 10, isFree: false, unlockTime: '2026-10-01T09:18:50Z' };
  await assert.rejects(
    asuraAdapter.getChapterImages({ seriesId: 'war-of-extinction' }, chapter, {
      fetchJson: async () => assert.fail('must not contact the API for a locked chapter'),
    }),
    (error) => error instanceof ProtectedContentError && /until 2026-10-01 09:18 UTC/.test(error.message),
  );
});

test('a free chapter is requested by its exact (decimal) number', async () => {
  const calls = [];
  const images = await asuraAdapter.getChapterImages({ seriesId: 'return-of-the-mount-hua-sect' }, { number: 152.5, isFree: true }, {
    fetchJson: async (url) => {
      calls.push(url);
      return { data: { is_locked: false, access_gate: '', chapter: { number: 152.5, pages: [{ url: `${CDN}/p.webp` }] } } };
    },
  });
  assert.deepEqual(calls, ['https://api.asurascans.com/api/series/return-of-the-mount-hua-sect/chapters/152.5']);
  assert.equal(images.length, 1);
});

test('getSeries reads metadata and chapters from the API', async () => {
  const calls = [];
  const series = await asuraAdapter.getSeries({ seriesId: 'nano-machine' }, {
    now: () => NOW,
    fetchJson: async (url) => {
      calls.push(url);
      if (url.endsWith('/chapters')) return { data: [{ id: 2, number: 2 }, { id: 1, number: 1 }] };
      return { series: { title: 'Nano Machine', author: 'Hanjung Wolya' } };
    },
  });
  assert.deepEqual(calls.sort(), [
    'https://api.asurascans.com/api/series/nano-machine',
    'https://api.asurascans.com/api/series/nano-machine/chapters',
  ]);
  assert.equal(series.title, 'Nano Machine');
  assert.deepEqual(series.chapters.map((c) => c.number), [1, 2]);
});

test('getSeries explains an unknown slug instead of a bare HTTP 404', async () => {
  await assert.rejects(
    asuraAdapter.getSeries({ seriesId: 'no-such-series' }, {
      fetchJson: async (url) => { throw new FetchError(`HTTP 404 for ${url}`, { url, status: 404 }); },
    }),
    (error) => error instanceof FetchError && /no series "no-such-series"/.test(error.message),
  );
});

test('search pages with offset while has_more, capped and de-duplicated', async () => {
  const calls = [];
  const page = (slugs, hasMore) => ({ data: slugs.map((slug) => ({ slug, title: slug })), meta: { has_more: hasMore } });
  const results = await asuraAdapter.search('the', 'en', {
    fetchJson: async (url) => {
      calls.push(url);
      const offset = Number(new URL(url).searchParams.get('offset'));
      return offset === 0 ? page(['a', 'b'], true) : offset === 50 ? page(['b', 'c'], true) : page(['d'], true);
    },
  });
  assert.equal(calls.length, 3, 'stops at the page cap even when has_more stays true');
  assert.match(calls[0], /\/api\/search\?q=the&limit=50&offset=0$/);
  assert.deepEqual(results.map((r) => r.seriesId), ['a', 'b', 'c', 'd']);

  calls.length = 0;
  await asuraAdapter.search('nano', 'en', { fetchJson: async (url) => { calls.push(url); return page(['nano-machine'], false); } });
  assert.equal(calls.length, 1);
  assert.deepEqual(await asuraAdapter.search('  ', 'en', { fetchJson: async () => assert.fail('no request for an empty query') }), []);
});
