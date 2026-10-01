import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lua from '../../src/adapters/lua.js';
import { resolveUrl } from '../../src/adapters/registry.js';
import { cleanRef, createFollowEntry, safeCover } from '../../src/common/following.js';
import { FetchError, ProtectedContentError } from '../../src/common/errors.js';

// Shapes trimmed from responses captured in a reader's browser on luacomic.org
// (2026-10-01): Cloudflare blocks the build environment from the site itself.
const MEDIA = 'https://media.luacomic.org/file/V4IKlhs/uploads/series/baby-dragon/c94dc88b-620e-40b2-8d10-6569c9a1e32e';
const THUMB = 'https://media.luacomic.org/file/V4IKlhs/gk0hhl5bcus5p6lfq4n8oa2k.webp';
const SERIES = { id: 638, series_slug: 'baby-dragon', thumbnail: THUMB, title: 'Baby Dragon' };

const CHAPTER_1 = {
  chapter: {
    id: 35232, series_id: 638, season_id: null, index: '1.0', chapter_name: 'Chapter 1', chapter_title: null,
    chapter_data: { images: Array.from({ length: 10 }, (_, i) => `${MEDIA}/page_${String(i + 1).padStart(3, '0')}.webp`) },
    chapter_content: null, chapter_slug: 'chapter-1', chapter_type: 'Comic', price: 0,
    created_at: '2026-07-09T08:08:49.410Z', storage: 's3', public: true, series: SERIES, who_bought: [], chapters_to_be_freed: [],
  },
  previous_chapter: null,
  next_chapter: { id: 35233, chapter_name: 'Chapter 2', chapter_slug: 'chapter-2' },
};

const CHAPTER_80_PAYWALL = {
  paywall: true,
  series: SERIES,
  chapter: { id: 35311, chapter_name: 'Chapter 80', chapter_type: 'Comic', chapter_slug: 'chapter-80', price: 10 },
};

// GET /chapter/query?page=1&perPage=100&series_id=638 -- newest first; 43-80 cost 10 coins.
const row = (n) => ({
  id: 35231 + n, chapter_name: `Chapter ${n}`, chapter_title: n === 80 ? 'The End' : null, chapter_slug: `chapter-${n}`,
  price: n >= 43 ? 10 : 0, created_at: '2026-07-09T10:45:45.501Z', series: { series_slug: 'baby-dragon', id: 638 },
});
const LIST = {
  meta: { total: 80, per_page: 100, current_page: 1, last_page: 1, next_page_url: null },
  data: Array.from({ length: 80 }, (_, i) => row(80 - i)),
};

// The series page's embedded framework data escapes its quotes.
const SERIES_HTML = '<html><head><meta property="og:title" content="Baby Dragon - Lua Comic"/>'
  + '<meta name="description" content="Read Baby Dragon on Lua Comic - Reborn as a powerful dragon with memories of a tragic past."/>'
  + `<meta property="og:image" content="${THUMB}"/></head><body><script>self.__next_f.push([1,"`
  + '[\\"$\\",\\"$L24\\",null,{\\"series_id\\":638,\\"series_type\\":\\"Comic\\"}]'
  + '[\\"$\\",\\"$L2c\\",null,{\\"post\\":{\\"id\\":638,\\"title\\":\\"Baby Dragon\\",\\"series_slug\\":\\"baby-dragon\\"}}]'
  + '"])</script></body></html>';

const httpError = (url, status) => new FetchError(`HTTP ${status} for ${url}`, { url, status });

test('Lua: series and chapter URLs', () => {
  assert.deepEqual(lua.parseUrl('https://luacomic.org/series/baby-dragon'), { seriesId: 'baby-dragon', lang: 'en' });
  assert.deepEqual(lua.parseUrl('https://luacomic.org/series/baby-dragon/chapter-1/'),
    { seriesId: 'baby-dragon', lang: 'en', episodeNo: 1, chapterSlug: 'chapter-1' });
  assert.equal(lua.parseUrl('https://www.luacomic.org/series/x/chapter-12.5').episodeNo, 12.5);
  for (const bad of ['https://luacomic.org/', 'https://luacomic.org/series/x/not-a-chapter',
    'https://api.luacomic.org/chapter/baby-dragon/chapter-1', 'https://luacomic.org.evil.org/series/x', 'nope']) {
    assert.equal(lua.parseUrl(bad), null, bad);
  }
  assert.equal(resolveUrl('https://luacomic.org/series/baby-dragon').adapter.id, 'lua');
});

test('Lua: series page gives the numeric id, title, summary and cover', () => {
  assert.deepEqual(lua.parseSeriesPage(SERIES_HTML, 'baby-dragon'), {
    seriesNumericId: 638,
    title: 'Baby Dragon',
    summary: 'Reborn as a powerful dragon with memories of a tragic past.',
    cover: THUMB,
  });
  // Without the embedded data (a page saved without its scripts) the id is unknown.
  const plain = lua.parseSeriesPage('<meta property="og:title" content="Baby Dragon - Lua Comic"/>', 'baby-dragon');
  assert.equal(plain.seriesNumericId, null);
  assert.equal(plain.title, 'Baby Dragon');
});

test('Lua: chapter list marks priced chapters and keeps slugs and ids', () => {
  const chapters = lua.parseChapterPage(LIST, 'baby-dragon');
  assert.equal(chapters.length, 80);
  const byNumber = new Map(chapters.map((c) => [c.number, c]));
  assert.deepEqual(byNumber.get(80), {
    number: 80, title: 'The End', date: '2026-07-09', url: 'https://luacomic.org/series/baby-dragon/chapter-80',
    chapterSlug: 'chapter-80', chapterId: 35311, isFree: false, lock: { price: 10 },
  });
  assert.equal(byNumber.get(43).isFree, false);
  assert.equal(byNumber.get(42).isFree, true);
  assert.equal(byNumber.get(42).lock, undefined);
  assert.equal(byNumber.get(1).title, '');
  assert.throws(() => lua.parseChapterPage({ message: 'Cannot GET:/chapters/638' }, 'baby-dragon'), FetchError);
});

test('Lua: a free chapter gives its pages in order', () => {
  const images = lua.parseChapterImages(CHAPTER_1, 1);
  assert.equal(images.length, 10);
  assert.deepEqual(images[0], { url: `${MEDIA}/page_001.webp`, index: 1 });
  assert.deepEqual(images[9], { url: `${MEDIA}/page_010.webp`, index: 10 });
});

test('Lua: paywall, wrong chapter and non-comic answers are refused', () => {
  assert.throws(() => lua.parseChapterImages(CHAPTER_80_PAYWALL, 80),
    (e) => e instanceof ProtectedContentError && /costs 10 coins/.test(e.message));
  // The paywall flag alone is enough, even without a price.
  assert.throws(() => lua.parseChapterImages({ paywall: true, chapter: { chapter_slug: 'chapter-80' } }, 80),
    (e) => e instanceof ProtectedContentError && /is paywalled/.test(e.message));
  // A priced chapter that somehow came back with pages is still refused.
  const priced = { chapter: { ...CHAPTER_1.chapter, chapter_slug: 'chapter-43', chapter_name: 'Chapter 43', price: 10 } };
  assert.throws(() => lua.parseChapterImages(priced, 43), ProtectedContentError);
  assert.throws(() => lua.parseChapterImages(CHAPTER_1, 2), (e) => e instanceof FetchError && /answered chapter 1/.test(e.message));
  const novel = { chapter: { ...CHAPTER_1.chapter, chapter_type: 'Novel', chapter_data: null } };
  assert.throws(() => lua.parseChapterImages(novel, 1), /is Novel, not images/);
  const empty = { chapter: { ...CHAPTER_1.chapter, chapter_data: { images: [] } } };
  assert.throws(() => lua.parseChapterImages(empty, 1), /has no pages/);
});

test('Lua: a priced chapter is refused before any request', async () => {
  const chapter = lua.parseChapterPage(LIST, 'baby-dragon').find((c) => c.number === 80);
  await assert.rejects(lua.luaAdapter.getChapterImages({ seriesId: 'baby-dragon' }, chapter, {
    fetchJson: async () => assert.fail('must not contact the API for a paid chapter'),
  }), (e) => e instanceof ProtectedContentError && /costs 10 coins/.test(e.message));
});

test('Lua: a free chapter is fetched by series and chapter slug', async () => {
  const calls = [];
  const chapter = lua.parseChapterPage(LIST, 'baby-dragon').find((c) => c.number === 1);
  const images = await lua.luaAdapter.getChapterImages({ seriesId: 'baby-dragon' }, chapter, {
    fetchJson: async (url) => { calls.push(url); return CHAPTER_1; },
  });
  assert.deepEqual(calls, ['https://api.luacomic.org/chapter/baby-dragon/chapter-1']);
  assert.equal(images.length, 10);
});

test('Lua: getSeries reads the id from the series page, then lists every chapter', async () => {
  const raw = [];
  const json = [];
  const series = await lua.luaAdapter.getSeries({ seriesId: 'baby-dragon', lang: 'en' }, {
    fetchRaw: async (url) => { raw.push(url); return { text: async () => SERIES_HTML }; },
    fetchJson: async (url) => { json.push(url); return LIST; },
  });
  assert.deepEqual(raw, ['https://luacomic.org/series/baby-dragon']);
  assert.deepEqual(json, ['https://api.luacomic.org/chapter/query?page=1&perPage=100&series_id=638']);
  assert.equal(series.title, 'Baby Dragon');
  assert.equal(series.cover, THUMB);
  assert.deepEqual(series.chapters.map((c) => c.number), Array.from({ length: 80 }, (_, i) => i + 1));
  assert.equal(series.chapters.filter((c) => c.isFree).length, 42);
});

test('Lua: getSeries follows last_page across several list pages', async () => {
  const json = [];
  const series = await lua.luaAdapter.getSeries({ seriesId: 'baby-dragon' }, {
    fetchRaw: async () => ({ text: async () => SERIES_HTML }),
    fetchJson: async (url) => {
      json.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const numbers = page === 1 ? Array.from({ length: 100 }, (_, i) => 150 - i) : Array.from({ length: 50 }, (_, i) => 50 - i);
      return { meta: { last_page: 2, current_page: page }, data: numbers.map(row) };
    },
  });
  assert.equal(json.length, 2);
  assert.match(json[1], /page=2&perPage=100&series_id=638$/);
  assert.equal(series.chapters.length, 150);
});

test('Lua: a pasted chapter link finds the id through the chapter API', async () => {
  const json = [];
  const series = await lua.luaAdapter.getSeries({ seriesId: 'baby-dragon', chapterSlug: 'chapter-80' }, {
    fetchRaw: async (url) => { throw httpError(url, 403); },
    fetchJson: async (url) => { json.push(url); return url.includes('/query?') ? LIST : CHAPTER_80_PAYWALL; },
  });
  assert.equal(json[0], 'https://api.luacomic.org/chapter/baby-dragon/chapter-80');
  assert.match(json[1], /series_id=638$/);
  assert.equal(series.title, 'Baby Dragon');
  assert.equal(series.cover, THUMB);
});

test('Lua: unknown series and Cloudflare blocks get readable errors', async () => {
  await assert.rejects(lua.luaAdapter.getSeries({ seriesId: 'no-such' }, {
    fetchRaw: async (url) => { throw httpError(url, 404); },
    fetchJson: async () => assert.fail('no API call after a 404'),
  }), (e) => /no series "no-such"/.test(e.message));
  const json = [];
  await assert.rejects(lua.luaAdapter.getSeries({ seriesId: 'baby-dragon' }, {
    fetchRaw: async (url) => { throw httpError(url, 403); },
    fetchJson: async (url) => { json.push(url); throw httpError(url, 403); },
  }), (e) => e instanceof FetchError && /behind Cloudflare/.test(e.message));
  assert.deepEqual(json, ['https://api.luacomic.org/chapter/baby-dragon/chapter-1', 'https://api.luacomic.org/chapter/baby-dragon/chapter-0']);
});

test('Lua: a series link still works when the page is blocked, via chapter 1', async () => {
  const json = [];
  const series = await lua.luaAdapter.getSeries({ seriesId: 'baby-dragon' }, {
    fetchRaw: async (url) => { throw httpError(url, 403); },
    fetchJson: async (url) => { json.push(url); return url.includes('/query?') ? LIST : CHAPTER_1; },
  });
  assert.deepEqual(json.slice(0, 1), ['https://api.luacomic.org/chapter/baby-dragon/chapter-1']);
  assert.match(json[1], /series_id=638$/);
  assert.equal(series.title, 'Baby Dragon');
  assert.equal(series.chapters.length, 80);
  // An answer for another series is never used.
  await assert.rejects(lua.luaAdapter.getSeries({ seriesId: 'other' }, {
    fetchRaw: async (url) => { throw httpError(url, 403); },
    fetchJson: async (url) => (url.includes('/query?') ? assert.fail('wrong series id used') : CHAPTER_1),
  }), /Could not find the Lua Comic series id/);
});

test('Lua: Following stores the slug and chapter ids', () => {
  assert.deepEqual(cleanRef('lua', { seriesId: 'baby-dragon', chapterSlug: 'chapter-1' }), { seriesId: 'baby-dragon', lang: 'en' });
  assert.throws(() => cleanRef('lua', { seriesId: '../x' }), /Invalid followed series/);
  assert.equal(safeCover(THUMB), THUMB);
  const chapters = lua.parseChapterPage(LIST, 'baby-dragon').sort((a, b) => a.number - b.number);
  const entry = createFollowEntry({ adapterId: 'lua', ref: { seriesId: 'baby-dragon', lang: 'en' },
    series: { title: 'Baby Dragon', author: '', cover: THUMB, chapters } }, 1, 'x');
  assert.equal(entry.id, 'lua:en::baby-dragon');
  assert.equal(entry.cover, THUMB);
});
