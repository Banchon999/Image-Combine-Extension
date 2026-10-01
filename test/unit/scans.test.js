import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nyx from '../../src/adapters/nyx.js';
import * as ez from '../../src/adapters/ezmanga.js';
import { resolveUrl } from '../../src/adapters/registry.js';
import { FetchError, ProtectedContentError } from '../../src/common/errors.js';

// Shapes trimmed from live api.nyxscans.com and vapi.ezmanga.org responses (2026-10-01).
const NYX_MEDIA = 'https://media.nyxscans.com/upload/series/a-secretly-capable-child-is-seeking-for-her-dad';
const EZ_MEDIA = 'https://media.ezmanga.org/file/c0c7f7/upload/series/the-forgotten-field/qak8Q188mS/tOrNRb';

/* ================================ NYX ================================ */

test('NYX: series and chapter URLs, including slugs with punctuation', () => {
  assert.deepEqual(nyx.parseUrl('https://nyxscans.com/series/a-secretly-capable-child-is-seeking-for-her-dad'),
    { seriesId: 'a-secretly-capable-child-is-seeking-for-her-dad', lang: 'en' });
  assert.deepEqual(nyx.parseUrl("https://nyxscans.com/series/i-only-need-the-duke's-child/chapter-12"),
    { seriesId: "i-only-need-the-duke's-child", lang: 'en', episodeNo: 12 });
  assert.equal(nyx.parseUrl('https://nyxscans.com/series/roxana:-the-way-to-protect/').seriesId, 'roxana:-the-way-to-protect');
  assert.equal(nyx.parseUrl('https://nyxscans.com/series/x/chapter-0').episodeNo, 0);
  for (const bad of ['https://nyxscans.com/', 'https://nyxscans.com/series/x/not-a-chapter',
    'https://nyxscans.com.evil.org/series/x', 'https://api.nyxscans.com/series/x', 'nope']) {
    assert.equal(nyx.parseUrl(bad), null, bad);
  }
  assert.equal(resolveUrl('https://nyxscans.com/series/x/chapter-3').adapter.id, 'nyx');
});

test('NYX: any lock signal marks a chapter as not free', () => {
  const open = { isLocked: false, isAccessible: true, price: 0, isShortLinkLocked: false };
  assert.equal(nyx.isLockedChapter(open), false);
  for (const flag of [{ isLocked: true }, { isAccessible: false }, { price: 100 }, { isShortLinkLocked: true }, { isLockedByCoins: true }]) {
    assert.equal(nyx.isLockedChapter({ ...open, ...flag }), true, JSON.stringify(flag));
  }
});

test('NYX: chapter list keeps ids, chapter 0 and the lock details', () => {
  const chapters = nyx.parseChapterPage({ post: { chapters: [
    { id: 51036, slug: 'chapter-52', number: 52, title: '', isLocked: true, isAccessible: false, price: 100,
      isPermanentlyLocked: true, isShortLinkLocked: false, unlockAt: null, createdAt: '2026-09-30T17:10:27.650Z' },
    { id: 28864, slug: 'chapter-0', number: 0, title: 'prologue', isLocked: false, isAccessible: true, price: 0 },
  ] }, totalChapterCount: 2 }, 'a-secretly-capable-child-is-seeking-for-her-dad');
  assert.deepEqual(chapters.map((c) => [c.number, c.chapterId, c.isFree]), [[52, 51036, false], [0, 28864, true]]);
  assert.equal(chapters[0].lock.price, 100);
  assert.equal(chapters[1].url, 'https://nyxscans.com/series/a-secretly-capable-child-is-seeking-for-her-dad/chapter-0');
  assert.throws(() => nyx.parseChapterPage({ error: 'x' }, 's'), FetchError);
});

test('NYX: novels are refused with a clear reason', () => {
  assert.throws(() => nyx.parseSeriesInfo({ post: { id: 550, postTitle: 'X [Novel]', isNovel: true } }, 'x-novel'),
    (e) => e instanceof FetchError && /text novel/.test(e.message));
  const info = nyx.parseSeriesInfo({ post: { id: 549, postTitle: 'A Secretly Capable Child', isNovel: false,
    postContent: '<p>Jongno District.</p><p>Second.</p>', featuredImage: 'https://media.nyxscans.com/c.webp', author: '' } }, 's');
  assert.equal(info.postId, 549);
  assert.equal(info.summary, 'Jongno District.\n\nSecond.');
});

test('NYX: images come back in page order; a locked chapter is protected', () => {
  const images = nyx.parseChapterImages({ chapter: { number: 51, isLocked: false, isAccessible: true, price: 0, images: [
    { id: 2, order: 1, url: `${NYX_MEDIA}/page-0002.webp`, width: 800, height: 1200 },
    { id: 1, order: 0, url: `${NYX_MEDIA}/page-0001.webp`, width: 800, height: 1200 },
    { id: 3, order: 2, url: 'http://insecure.example/p.webp' },
  ] } }, 51);
  assert.deepEqual(images.map((i) => [i.index, i.url.slice(-14)]), [[1, 'page-0001.webp'], [2, 'page-0002.webp']]);
  // Live answer for chapter 52 (100 coins): no images.
  assert.throws(() => nyx.parseChapterImages({ chapter: { number: 52, isLocked: true, isAccessible: false, price: 100, images: [] } }, 52),
    (e) => e instanceof ProtectedContentError && /costs 100 coins/.test(e.message));
  assert.throws(() => nyx.parseChapterImages({ chapter: { number: 9, images: [] } }, 10), FetchError);
});

test('NYX: a locked chapter is refused before any request', async () => {
  const chapter = { number: 52, chapterId: 51036, isFree: false, lock: { price: 100, isShortLinkLocked: false } };
  await assert.rejects(nyx.nyxAdapter.getChapterImages({ seriesId: 's' }, chapter, {
    fetchJson: async () => assert.fail('must not contact the API for a locked chapter'),
  }), ProtectedContentError);
  const adLocked = { number: 7, chapterId: 1, isFree: false, lock: { price: 0, isShortLinkLocked: true } };
  await assert.rejects(nyx.nyxAdapter.getChapterImages({ seriesId: 's' }, adLocked, { fetchJson: async () => assert.fail() }),
    (e) => /unlocks through an ad link/.test(e.message));
});

test('NYX: getSeries resolves the slug, then pages chapters 200 at a time in ascending order', async () => {
  const calls = [];
  const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: 1000 + from + i, slug: `chapter-${from + i}`, number: from + i, isLocked: false, isAccessible: true, price: 0 }));
  const series = await nyx.nyxAdapter.getSeries({ seriesId: "i-only-need-the-duke's-child" }, {
    fetchJson: async (url) => {
      calls.push(url);
      if (url.includes('/post?')) return { post: { id: 593, postTitle: 'Duke', isNovel: false } };
      const skip = Number(new URL(url).searchParams.get('skip'));
      return { post: { chapters: skip === 0 ? rows(1, 200) : rows(201, 230) }, totalChapterCount: 230 };
    },
  });
  assert.equal(calls[0], "https://api.nyxscans.com/api/post?postSlug=i-only-need-the-duke's-child");
  assert.match(calls[1], /chapters\?postId=593&skip=0&take=200&order=asc/);
  assert.match(calls[2], /skip=200&take=200/);
  assert.equal(calls.length, 3);
  assert.equal(series.chapters.length, 230);
  assert.equal(series.postId, undefined, 'internal id is not leaked into the series object');
});

test('NYX: search keeps comics and drops novels', () => {
  const found = nyx.parseSearchResults({ posts: [
    { slug: 'a-secretly-capable-child-is-seeking-for-her-dad', postTitle: 'A Secretly Capable Child', isNovel: false, featuredImage: 'https://media.nyxscans.com/c.webp' },
    { slug: 'x-novel', postTitle: 'X [Novel]', isNovel: true },
  ], novelPosts: [{ slug: 'y-novel' }] });
  assert.deepEqual(found.map((r) => r.seriesId), ['a-secretly-capable-child-is-seeking-for-her-dad']);
});

/* ============================== EZ Manga ============================== */

test('EZ Manga: both hosts parse; punctuation in slugs survives', () => {
  assert.deepEqual(ez.parseUrl('https://ezmanga.org/series/the-forgotten-field/chapter-36'),
    { seriesId: 'the-forgotten-field', lang: 'en', episodeNo: 36 });
  assert.deepEqual(ez.parseUrl('https://ezmanhwa.com/series/the-forgotten-field'), { seriesId: 'the-forgotten-field', lang: 'en' });
  assert.equal(ez.parseUrl('https://ezmanga.org/series/how-is-this-hot-duke-just-a-background-character!').seriesId,
    'how-is-this-hot-duke-just-a-background-character!');
  assert.equal(ez.parseUrl('https://ezmanga.org/series/x/chapter-1.5').episodeNo, 1.5);
  for (const bad of ['https://ezmanga.org/', 'https://vapi.ezmanga.org/api/v1/series/x', 'https://ezmanga.org.evil.org/series/x']) {
    assert.equal(ez.parseUrl(bad), null, bad);
  }
  assert.equal(resolveUrl('https://ezmanhwa.com/series/x').adapter.id, 'ezmanga');
});

test('EZ Manga: chapter list marks paid chapters', () => {
  const chapters = ez.parseChapterPage({ data: [
    { id: 32901, slug: 'chapter-36', number: 36, title: null, price: 0, isFree: true, requiresPurchase: false, createdAt: '2026-09-29T14:13:38.717Z' },
    { id: 40000, slug: 'chapter-120', number: 120, title: null, price: 100, isFree: false, requiresPurchase: true },
  ], totalItems: 2, next: null }, 'the-forgotten-field');
  assert.deepEqual(chapters.map((c) => [c.number, c.isFree, c.chapterSlug, c.chapterId]),
    [[36, true, 'chapter-36', 32901], [120, false, 'chapter-120', 40000]]);
  assert.equal(chapters[0].title, '');
  assert.equal(chapters[0].date, '2026-09-29');
});

test('EZ Manga: images in order; paid and text chapters are explained', () => {
  const images = ez.parseChapterImages({ number: 36, isFree: true, price: 0, requiresPurchase: false, images: [
    { url: `${EZ_MEDIA}/01.webp`, order: 1, width: 800, height: 13000 },
    { url: `${EZ_MEDIA}/00.webp`, order: 0, width: 800, height: 13000 },
  ] }, 36);
  assert.deepEqual(images.map((i) => i.url.slice(-7)), ['00.webp', '01.webp']);
  // Live answer for a 100-coin chapter: no images.
  assert.throws(() => ez.parseChapterImages({ number: 120, isFree: false, price: 100, requiresPurchase: true, images: [] }, 120),
    (e) => e instanceof ProtectedContentError && /costs 100 coins/.test(e.message));
  assert.throws(() => ez.parseChapterImages({ number: 3, isFree: true, price: 0, images: [], content: '<p>Text</p>' }, 3),
    (e) => e instanceof FetchError && /is text, not images/.test(e.message));
});

test('EZ Manga: a paid chapter is refused before any request; a free one uses its slug', async () => {
  await assert.rejects(ez.ezmangaAdapter.getChapterImages({ seriesId: 's' }, { number: 120, isFree: false, lock: { price: 100 } }, {
    fetchJson: async () => assert.fail('must not contact the API for a paid chapter'),
  }), ProtectedContentError);
  const calls = [];
  await ez.ezmangaAdapter.getChapterImages({ seriesId: 'how-is-this-hot-duke-just-a-background-character!' },
    { number: 5, isFree: true, chapterSlug: 'chapter-5' }, {
      fetchJson: async (url) => { calls.push(url); return { number: 5, isFree: true, price: 0, images: [{ url: `${EZ_MEDIA}/00.webp`, order: 0 }] }; },
    });
  assert.deepEqual(calls, ['https://vapi.ezmanga.org/api/v1/series/how-is-this-hot-duke-just-a-background-character!/chapters/chapter-5']);
});

test('EZ Manga: getSeries follows "next" through every chapter page', async () => {
  const calls = [];
  const series = await ez.ezmangaAdapter.getSeries({ seriesId: 'the-forgotten-field' }, {
    fetchJson: async (url) => {
      calls.push(url);
      if (!url.includes('/chapters')) return { slug: 'the-forgotten-field', title: 'The Forgotten Field', type: 'MANHWA', description: '<p>Every day, I pray.</p>' };
      const page = Number(new URL(url).searchParams.get('page'));
      const rows = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, slug: `chapter-${i}`, number: i, isFree: true, price: 0 }))
        : [{ id: 200, slug: 'chapter-100', number: 100, isFree: true, price: 0 }];
      return { data: rows, next: page === 1 ? 2 : null };
    },
  });
  assert.match(calls[1], /chapters\?page=1&perPage=100$/);
  assert.match(calls[2], /chapters\?page=2&perPage=100$/);
  assert.equal(calls.length, 3);
  assert.equal(series.chapters.length, 101);
  assert.equal(series.summary, 'Every day, I pray.');
});

test('EZ Manga: unknown slug gets a readable error; novels are refused', async () => {
  await assert.rejects(ez.ezmangaAdapter.getSeries({ seriesId: 'no-such' }, {
    fetchJson: async (url) => { throw new FetchError(`HTTP 404 for ${url}`, { url, status: 404 }); },
  }), (e) => /no series "no-such"/.test(e.message));
  assert.throws(() => ez.parseSeriesInfo({ slug: 'n', title: 'N', type: 'NOVEL' }, 'n'), /text novel/);
  assert.deepEqual(ez.parseSearchResults({ data: [{ slug: 'a', title: 'A', type: 'MANHWA' }, { slug: 'b', type: 'NOVEL' }] }).map((r) => r.seriesId), ['a']);
});
