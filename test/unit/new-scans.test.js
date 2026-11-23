import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as eva from '../../src/adapters/eva.js';
import * as magus from '../../src/adapters/magus.js';
import * as valir from '../../src/adapters/valir.js';
import * as siren from '../../src/adapters/siren.js';
import { resolveUrl } from '../../src/adapters/registry.js';
import { cleanRef, safeCover, chapterSnapshot } from '../../src/common/following.js';
import { FetchError, ProtectedContentError } from '../../src/common/errors.js';

// Shapes trimmed from live pages and API answers (2026-11-23), quirks kept.

const raw = (map) => async (url) => {
  const entry = map(url);
  if (entry instanceof Error) throw entry;
  return { text: async () => entry };
};
const never = async () => assert.fail('must not request a locked chapter');

/* ---------------- Eva Scans (MangaReader theme, like Violet) ---------------- */

const EVA_UP = 'https://evascans.net/wp-content/uploads';
const evaFree = (n) => `
<li data-num="${n}">
<a href="https://evascans.net/a-king-is-born-on-the-road-chapter-${n}/" >
<div class="chbox"><div class="eph-num">
<span class="chapternum"> Chapter ${n}</span>
<span class="chapterdate">November 20, 2026</span>
</div></div></a>
</li>`;
const evaLocked = (n) => `
<li data-num="${n}">
<a data-bs-toggle="modal" data-bs-target="#lockedChapterModal" data-id="270234" data-coin="50" data-title="Chapter ${n}" >
<div class="chbox"><div class="eph-num">
<span class="chapternum"> Chapter ${n}</span>
<span class="chapterdate">November 20, 2026</span>
</div><span class=" text-gold "><svg viewBox="0 0 512 512"><path d="M0 405.3"/></svg> 50</span></div></a>
</li>`;
const EVA_SERIES = `<html><head>
<meta property="og:title" content="A King is Born on the Road Manga &ndash; Eva Scans" />
<meta property="og:image" content="https://i2.wp.com/evascans.net/wp-content/uploads/2026/11/cover.jpeg" />
</head><body>
<h1 class="entry-title" itemprop="name">A King is Born on the Road</h1>
<div class="entry-content entry-content-single" itemprop="description"><p>Iris Lefos was once a queen.</p></div>
<div class="tsinfo bixbox">
<div class="imptdt"><h1> Type </h1> <i>Manhwa</i></div>
<div class="imptdt"><h1> Author </h1> <i>Anthony</i></div>
<div class="imptdt"><h1> Artist </h1> <i>Mara</i></div>
</div>
<ul class="clstyle">${evaLocked(20)}${evaFree(19)}${evaFree(1)}${evaFree(0)}</ul></body></html>`;
// Chapter 1's real order: 0008 is the opening credit page, 0007 the closing
// one ("read the next chapter on evascans.net"), checked by eye.
const EVA_PAGES = ['0008_de8673df', '0016_1c9f5195', '0001_05b05d93', '0007_3143525f']
  .map((name) => `${EVA_UP}/manga/19e9bca8f890213b3bfdeff78c432b95/${name}.webp`);
const EVA_CHAPTER = `<html><body>
<div class="allc">All chapters are in <a href="https://evascans.net/series/a-king-is-born-on-the-road/">A King is Born on the Road</a></div>
<script>ts_reader.run(${JSON.stringify({ post_id: 270212, sources: [{ source: 'Server 1', images: EVA_PAGES }] }).replace(/\//g, '\\/')});</script>
</body></html>`;

test('Eva: links, series page, paid chapters and cover', () => {
  assert.deepEqual(eva.parseUrl('https://evascans.net/series/serena/'), { seriesId: 'serena', lang: 'en' });
  assert.deepEqual(eva.parseUrl('https://evascans.org/serena-chapter-151/'),
    { seriesId: 'serena', lang: 'en', episodeNo: 151, chapterPath: '/serena-chapter-151/' });
  assert.equal(eva.parseUrl('https://evascans.net/comics/serena/'), null, 'Violet path, not Eva');
  assert.equal(eva.parseUrl('https://evascans.net.evil.org/series/x/'), null);
  assert.equal(resolveUrl('https://evascans.net/series/serena/').adapter.id, 'eva');

  const series = eva.parseSeriesPage(EVA_SERIES, 'a-king-is-born-on-the-road');
  assert.equal(series.title, 'A King is Born on the Road');
  assert.equal(series.author, 'Anthony, Mara');
  assert.equal(series.cover, `${EVA_UP}/2026/11/cover.jpeg`, 'Photon CDN link unwrapped');
  assert.deepEqual(series.chapters.map((c) => [c.number, c.isFree]), [[0, true], [1, true], [19, true], [20, false]]);
  assert.deepEqual(series.chapters[3].lock, { price: 50 });
  assert.equal(eva.seriesSlugFromChapterPage(EVA_CHAPTER), 'a-king-is-born-on-the-road');
});

test('Eva: pages keep the reader order; paid chapters are refused before any request', async () => {
  assert.deepEqual(eva.parseChapterImages(EVA_CHAPTER, 1).map((i) => i.url.split('/').pop().slice(0, 4)), ['0008', '0016', '0001', '0007']);
  const locked = '<html><body><div class="lock-card"><h2>This chapter is locked.</h2></div></body></html>';
  assert.throws(() => eva.parseChapterImages(locked, 20), (e) => e instanceof ProtectedContentError && /Eva Scans chapter 20/.test(e.message));
  const paid = eva.parseSeriesPage(EVA_SERIES, 'a-king-is-born-on-the-road').chapters.at(-1);
  await assert.rejects(eva.evaAdapter.getChapterImages({ seriesId: 'x' }, paid, { fetchRaw: never }),
    (e) => e instanceof ProtectedContentError && /costs 50 coins/.test(e.message));
  await assert.rejects(eva.evaAdapter.getChapterImages({ seriesId: 'x' }, { number: 1, isFree: true, url: 'https://violetmanga.com/x-chapter-1/' }, { fetchRaw: never }),
    /no valid link/);
});

test('Eva: search reads /series/ links', async () => {
  const page = `<div class="listupd"><div class="bs"><div class="bsx"> <a href="https://evascans.net/series/a-king-is-born-on-the-road/" title="A King is Born on the Road"> <div class="limit">
<img src="https://i1.wp.com/evascans.net/wp-content/uploads/2026/11/cover.jpeg?resize=165,225" class="ts-post-image"/> </div></a></div></div></div><div class="pagination"></div>`;
  const calls = [];
  const results = await eva.evaAdapter.search('king', 'en', { fetchRaw: raw((url) => { calls.push(url); return page; }) });
  assert.deepEqual(calls, ['https://evascans.net/?s=king']);
  assert.deepEqual(results, [{ seriesId: 'a-king-is-born-on-the-road', title: 'A King is Born on the Road', author: '',
    thumbnail: `${EVA_UP}/2026/11/cover.jpeg`, url: 'https://evascans.net/series/a-king-is-born-on-the-road/' }]);
});

/* ---------------- Magus Manga (same CMS as NYX) ---------------- */

const MAGUS_MEDIA = 'https://media.magustoon.org/upload/series/all-i-want-is-your-child';
const magusRow = (n, extra = {}) => ({ id: 51101 + n, slug: `chapter-${n}`, number: n, title: '', unlockAt: null, isPermanentlyLocked: false,
  isShortLinkLocked: false, price: 0, mangaPostId: 1061, createdAt: '2026-11-20T17:14:31.425Z', ...extra });

test('Magus: links, chapter list and locks use the shared CMS reader', async () => {
  assert.deepEqual(magus.parseUrl('https://magustoon.org/series/all-i-want-is-your-child/chapter-12'),
    { seriesId: 'all-i-want-is-your-child', lang: 'en', episodeNo: 12 });
  assert.equal(magus.parseUrl('https://magusmanga.com/series/x'), null, 'magusmanga.com is another site now');
  assert.equal(resolveUrl('https://magustoon.org/series/x').adapter.id, 'magus');
  assert.equal(resolveUrl('https://nyxscans.com/series/x').adapter.id, 'nyx');

  const calls = [];
  const series = await magus.magusAdapter.getSeries({ seriesId: 'all-i-want-is-your-child' }, {
    fetchJson: async (url) => {
      calls.push(url);
      if (url.includes('/post?')) return { post: { id: 1061, postTitle: 'All I Want Is Your Child', isNovel: false, postContent: '', featuredImage: 'https://media.magustoon.org/upload/series/featured/c.jpg' } };
      return { totalChapterCount: 3, post: { chapters: [magusRow(1), magusRow(2), magusRow(3, { isPermanentlyLocked: true })] } };
    },
  });
  assert.equal(calls[0], 'https://api.magustoon.org/api/post?postSlug=all-i-want-is-your-child');
  assert.match(calls[1], /^https:\/\/api\.magustoon\.org\/api\/chapters\?postId=1061&/);
  assert.deepEqual(series.chapters.map((c) => [c.number, c.isFree, c.chapterId]), [[1, true, 51102], [2, true, 51103], [3, false, 51104]]);
  assert.equal(series.chapters[0].url, 'https://magustoon.org/series/all-i-want-is-your-child/chapter-1');
  await assert.rejects(magus.magusAdapter.getChapterImages({}, series.chapters[2], { fetchJson: never }),
    (e) => e instanceof ProtectedContentError && /Magus Manga chapter 3 is locked/.test(e.message));

  const images = await magus.magusAdapter.getChapterImages({}, series.chapters[0], {
    fetchJson: async (url) => {
      assert.equal(url, 'https://api.magustoon.org/api/chapter?chapterId=51102');
      return { chapter: { number: 1, isLocked: false, isAccessible: true, price: 0, images: [
        { url: `${MAGUS_MEDIA}/b/page-0002.webp`, width: 720, height: 5000, order: 1 },
        { url: `${MAGUS_MEDIA}/b/page-0001.webp`, width: 720, height: 5000, order: 0 },
      ] } };
    },
  });
  assert.deepEqual(images.map((i) => i.url.split('/').pop()), ['page-0001.webp', 'page-0002.webp']);
  assert.throws(() => magus.parseSeriesInfo({ post: { id: 1, postTitle: 'X', isNovel: true } }, 'x'), /text novel on Magus Manga/);
});

/* ---------------- Valir Scans (Next.js RSC payload) ---------------- */

const push = (value) => `<script>self.__next_f.push([1,${JSON.stringify(value)}])</script>`;
const valirChapter = (n, locked = false) => ({ id: `c${n}`, number: n, title: `Chapter ${n}`, isLocked: locked, coinPrice: locked ? 100 : 0,
  publishedAt: '2026-11-21T03:30:01.563Z', contentFormat: 'IMAGES', hasAccess: !locked, becomesFreeAt: null, earlyAccessUntil: null });
const valirSeriesPage = (chapters, page = 1, totalPages = 1, type = 'MANHWA') => {
  const json = JSON.stringify({ series: { id: 'cmwpti4h1', title: 'A King is Born on the Road', slug: 'a-king-is-born-on-the-road', urlSlug: 'a-king-is-born-on-the-road',
    description: 'She was the queen of a fallen kingdom.', coverImage: '/uploads/series/2026/11/cover.webp', type }, chapters, currentPage: page, totalPages });
  // The payload arrives split across several pushes, mid-value.
  const cut = Math.floor(json.length / 2);
  return `<html><body>${push(`1:["$","div",null,${json.slice(0, cut)}`)}${push(`${json.slice(cut)}]\n`)}</body></html>`;
};
const VALIR_MEDIA = 'https://media.valirscans.org/series/a-king-is-born-on-the-road/0001';
const valirPage = (n, extra = {}) => ({ id: `p${n}`, pageNumber: n, kind: 'CONTENT', isRedacted: false, imageUrl: `${VALIR_MEDIA}/p-${n}.webp`,
  width: 800, height: 4000, isEncrypted: false, tiles: [], hasStrips: false, strips: [], hasFragments: false, fragments: [], ...extra });
const valirChapterPage = (number, pages) => `<html><body>${push(`5:["$","$L118",null,${JSON.stringify({ kind: 'comic', chapter: { id: 'c', number, title: `Chapter ${number}`, freePreviewPct: 0, content: '', pages } })}]\n`)}</body></html>`;

test('Valir: links, novels, and the RSC payload is read as data', () => {
  assert.deepEqual(valir.parseUrl('https://valirscans.org/series/comic/a-king-is-born-on-the-road/chapter/12'),
    { seriesId: 'a-king-is-born-on-the-road', lang: 'en', episodeNo: 12 });
  assert.deepEqual(valir.parseUrl('https://valirscans.org/series/novel/x'), { seriesId: 'x', lang: 'en', novel: true });
  for (const bad of ['https://valirscans.org/series', 'https://valirscans.org/series/comic/', 'https://media.valirscans.org/series/comic/x', 'nope']) {
    assert.equal(valir.parseUrl(bad), null, bad);
  }
  assert.equal(resolveUrl('https://valirscans.org/series/comic/x').adapter.id, 'valir');
  assert.deepEqual(valir.jsonAt('x{"a":"}]\\"",b:1}', 1), undefined, 'malformed JSON is skipped, not evaluated');
  assert.deepEqual(valir.jsonAt('x{"a":"}]\\"","b":[1]}', 1), { a: '}]"', b: [1] });

  const series = valir.parseSeriesPage(valirSeriesPage([valirChapter(1), valirChapter(2), valirChapter(3, true)]), 'a-king-is-born-on-the-road');
  assert.equal(series.title, 'A King is Born on the Road');
  assert.equal(series.cover, 'https://valirscans.org/uploads/series/2026/11/cover.webp');
  assert.deepEqual(series.chapters.map((c) => [c.number, c.isFree, c.chapterId]), [[1, true, 1000], [2, true, 2000], [3, false, 3000]]);
  assert.equal(series.chapters[0].url, 'https://valirscans.org/series/comic/a-king-is-born-on-the-road/chapter/1');
  assert.deepEqual(series.chapters[2].lock, { price: 100 });
  assert.throws(() => valir.parseSeriesPage(valirSeriesPage([], 1, 1, 'WEB_NOVEL'), 'a-king-is-born-on-the-road'), /text novel/);
});

test('Valir: every lock signal counts', () => {
  const open = valirChapter(1);
  assert.equal(valir.isLockedChapter(open), false);
  for (const flag of [{ isLocked: true }, { coinPrice: 50 }, { hasAccess: false }, { isFree: false }, { earlyAccessUntil: '2999-01-01T00:00:00Z' }]) {
    assert.equal(valir.isLockedChapter({ ...open, ...flag }), true, JSON.stringify(flag));
  }
  assert.equal(valir.isLockedChapter({ ...open, earlyAccessUntil: '2000-01-01T00:00:00Z' }), false, 'early access already over');
});

test('Valir: getSeries follows ?page=N; locked chapters are refused before any request', async () => {
  const calls = [];
  const page1 = valirSeriesPage([valirChapter(1), valirChapter(2)], 1, 2);
  const page2 = valirSeriesPage([valirChapter(3, true)], 2, 2);
  const series = await valir.valirAdapter.getSeries({ seriesId: 'a-king-is-born-on-the-road' }, {
    fetchRaw: raw((url) => { calls.push(url); return url.endsWith('?page=2') ? page2 : page1; }),
  });
  assert.deepEqual(calls, ['https://valirscans.org/series/comic/a-king-is-born-on-the-road', 'https://valirscans.org/series/comic/a-king-is-born-on-the-road?page=2']);
  assert.deepEqual(series.chapters.map((c) => c.number), [1, 2, 3]);
  await assert.rejects(valir.valirAdapter.getChapterImages({}, series.chapters[2], { fetchRaw: never }),
    (e) => e instanceof ProtectedContentError && /costs 100 coins/.test(e.message));
  await assert.rejects(valir.valirAdapter.getSeries({ seriesId: 'x', novel: true }, { fetchRaw: never }), /text novel/);
});

test('Valir: pages by number; redacted, encrypted or split pages are never used', () => {
  const images = valir.parseChapterImages(valirChapterPage(1, [valirPage(2), valirPage(1)]), 1);
  assert.deepEqual(images.map((i) => i.url.split('/').pop()), ['p-1.webp', 'p-2.webp']);
  assert.equal(images[0].height, 4000);
  assert.throws(() => valir.parseChapterImages(valirChapterPage(20, [valirPage(1, { isRedacted: true, imageUrl: '' })]), 20),
    (e) => e instanceof ProtectedContentError && /chapter 20 is locked/.test(e.message));
  for (const extra of [{ isEncrypted: true }, { hasFragments: true }, { tiles: [{ x: 0 }] }, { hasStrips: true }]) {
    assert.throws(() => valir.parseChapterImages(valirChapterPage(88, [valirPage(1, extra)]), 88),
      (e) => e instanceof ProtectedContentError && /does not decrypt/.test(e.message), JSON.stringify(extra));
  }
  assert.throws(() => valir.parseChapterImages(valirChapterPage(2, [valirPage(1)]), 3), /answered chapter 2/);
  assert.throws(() => valir.parseChapterImages(valirChapterPage(1, [valirPage(1, { imageUrl: 'https://evil.example/p.webp' })]), 1), /no pages yet/);
});

test('Valir: search keeps comics and drops web novels', async () => {
  const html = `<html><body>${push(`7:${JSON.stringify({ initialSeries: [
    { slug: 'a-king-is-born-on-the-road', urlSlug: 'a-king-is-born-on-the-road', title: 'A King is Born on the Road', coverImage: '/uploads/series/c.webp', type: 'MANHWA' },
    { slug: 'the-baby-fairy-is-a-villain-novel', urlSlug: 'the-baby-fairy-is-a-villain', title: 'The Baby Fairy Is a Villain', type: 'WEB_NOVEL' },
  ], total: 2 })}\n`)}</body></html>`;
  const calls = [];
  const results = await valir.valirAdapter.search('king', 'en', { fetchRaw: raw((url) => { calls.push(url); return html; }) });
  assert.deepEqual(calls, ['https://valirscans.org/series?q=king']);
  assert.deepEqual(results, [{ seriesId: 'a-king-is-born-on-the-road', title: 'A King is Born on the Road', author: '',
    thumbnail: 'https://valirscans.org/uploads/series/c.webp', url: 'https://valirscans.org/series/comic/a-king-is-born-on-the-road' }]);
});

/* ---------------- Siren Scans ---------------- */

const sirenRow = (slug, n, { locked = 0, coins = 0, tier = 0 } = {}) => `<a href="/${slug}-chapter-${n}" class="chapter-row flex items-center gap-3" data-title="chapter ${n}" data-index="1" data-ch-uid="660e1299672" data-ch-url="/${slug}-chapter-${n}" data-ch-label="Chapter ${n}" data-ch-locked="${locked}" data-ch-cover="https://wsrv.nl/?url=cdn.meowing.org/uploads/65fdaf5c42c.avif&amp;w=200&amp;q=55" data-ch-date="1767230602" data-series-slug="${slug}" data-ch-paid="${locked}" data-ch-coins="${coins}" data-ch-tier="${tier}" data-ch-tier-unlocked="0" data-ch-read="0" > <div class="ch-info">Chapter ${n} </div> </a>`;
const SIREN_SLUG = 'a-socially-anxious-guy-goes-to-another-world';
const sirenSeries = (type = 'MANGA') => `<html><head>
<meta property="og:title" content="A Socially Anxious Guy Goes to Another World | Siren Scans">
<meta property="og:description" content="Summary &amp; more...">
<meta property="og:image" content="https://wsrv.nl/?url=cdn.meowing.org/uploads/65fdaf5c42c.avif">
</head><body><h1 class="text-2xl font-bold md:text-3xl text-white">A Socially Anxious Guy Goes to Another World</h1>
<div class="flex-1 bg-surface rounded-lg px-4 py-3"> <div class="text-xs text-white/50 mb-1.5">Type</div> <div class="flex items-center gap-1.5"> <span class="w-2 h-2 rounded-full bg-violet-400 shrink-0"></span> <span class="text-sm font-bold text-violet-400">${type}</span> </div> </div>
<div id="chapters-list" class="custom-scrollbar"
    data-series-uid="65fdaf1e71e"
    data-series-slug="${SIREN_SLUG}"></div></body></html>`;
const sirenChapter = (pages, label = 'Chapter 1', seriesSlug = SIREN_SLUG) => `<html><body><div id="reader-wrap">
<script id="chapter-offline-data" type="application/json"> ${JSON.stringify({ chapterUid: '660e1299672', chapterLabel: label, seriesSlug, novel: false, pages }).replace(/&/g, '\\u0026')}</script></div></body></html>`;

test('Siren: links; reserved pages are not series', () => {
  assert.deepEqual(siren.parseUrl(`https://sirenscans.com/${SIREN_SLUG}-chapter-48`), { seriesId: SIREN_SLUG, lang: 'en', episodeNo: 48 });
  assert.deepEqual(siren.parseUrl('https://sirenscans.com/a-king-is-born-on-the-road-2'), { seriesId: 'a-king-is-born-on-the-road-2', lang: 'en' });
  for (const bad of ['https://sirenscans.com/', 'https://sirenscans.com/recently-updated', 'https://sirenscans.com/?browse',
    'https://sirenscans.com/a/b', 'https://sirenscans.com.evil.org/x', 'nope']) {
    assert.equal(siren.parseUrl(bad), null, bad);
  }
  assert.equal(resolveUrl('https://sirenscans.com/x-chapter-1').adapter.id, 'siren');
  assert.equal(siren.imageUrl('https://wsrv.nl/?url=cdn.meowing.org/uploads/660e1299672.avif&w=200'), 'https://cdn.meowing.org/uploads/660e1299672.avif');
  assert.equal(siren.imageUrl('https://wsrv.nl/?url=evil.example/x.avif'), '');
});

test('Siren: series page, list endpoint and locks', async () => {
  const calls = [];
  const rows = [sirenRow(SIREN_SLUG, 48, { locked: 1, coins: 100 }), sirenRow(SIREN_SLUG, 2), sirenRow(SIREN_SLUG, 1), sirenRow(SIREN_SLUG, 3, { tier: 2 })].join('\n');
  const series = await siren.sirenAdapter.getSeries({ seriesId: SIREN_SLUG }, {
    fetchRaw: raw((url) => { calls.push(url); return sirenSeries(); }),
    fetchJson: async (url) => { calls.push(url); return { success: true, chapter_count: 4, rows_html: rows }; },
  });
  assert.deepEqual(calls, [`https://sirenscans.com/${SIREN_SLUG}`,
    `https://sirenscans.com/?_chapters_html=1&series_uid=65fdaf1e71e&series_slug=${SIREN_SLUG}`]);
  assert.equal(series.title, 'A Socially Anxious Guy Goes to Another World');
  assert.equal(series.summary, 'Summary & more...');
  assert.equal(series.cover, 'https://cdn.meowing.org/uploads/65fdaf5c42c.avif');
  assert.deepEqual(series.chapters.map((c) => [c.number, c.isFree]), [[1, true], [2, true], [3, false], [48, false]]);
  assert.deepEqual(series.chapters[0], { number: 1, title: '', date: '2026-01-01', url: `https://sirenscans.com/${SIREN_SLUG}-chapter-1`, chapterId: 1000, isFree: true });
  await assert.rejects(siren.sirenAdapter.getChapterImages({ seriesId: SIREN_SLUG }, series.chapters[3], { fetchRaw: never }),
    (e) => e instanceof ProtectedContentError && /costs 100 coins/.test(e.message));
  assert.throws(() => siren.parseSeriesPage(sirenSeries('NOVEL'), 'x'), /text novel/);
  assert.throws(() => siren.parseChapterList({ success: false }, 'x'), FetchError);
});

test('Siren: pages come from the offline data, unwrapped to the CDN original', async () => {
  const pages = ['660e1299672', '660e129bd1e'].map((id) => `https://wsrv.nl/?url=cdn.meowing.org/uploads/${id}.avif`);
  const images = await siren.sirenAdapter.getChapterImages({ seriesId: SIREN_SLUG },
    { number: 1, isFree: true, url: `https://sirenscans.com/${SIREN_SLUG}-chapter-1` },
    { fetchRaw: raw(() => sirenChapter(pages)) });
  assert.deepEqual(images, [{ url: 'https://cdn.meowing.org/uploads/660e1299672.avif', index: 1 }, { url: 'https://cdn.meowing.org/uploads/660e129bd1e.avif', index: 2 }]);
  // No page list: the site withheld it, so it is treated as locked.
  assert.throws(() => siren.parseChapterImages('<html><body>Unlock this chapter</body></html>', 5), ProtectedContentError);
  assert.throws(() => siren.parseChapterImages(sirenChapter(pages, 'Chapter 2'), 1), /answered chapter 2/);
  assert.throws(() => siren.parseChapterImages(sirenChapter(pages, 'Chapter 1', 'other'), 1, SIREN_SLUG), /answered a chapter of "other"/);
  await assert.rejects(siren.sirenAdapter.getChapterImages({}, { number: 1, isFree: true, url: 'https://evil.example/x-chapter-1' }, { fetchRaw: never }), /no valid link/);
});

test('Siren: search uses the suggest endpoint and drops novels', async () => {
  const results = await siren.sirenAdapter.search('king', 'en', {
    fetchJson: async (url) => {
      assert.equal(url, 'https://sirenscans.com/?_ajax=suggest&q=king');
      return { success: true, items: [
        { title: 'A King is Born on the Road', url: '/a-king-is-born-on-the-road-2', cover: 'https://wsrv.nl/?url=cdn.meowing.org/uploads/660c47e6311.avif&w=120&q=70', type: 'manhwa' },
        { title: 'I’ll Raise My Mom Well', url: '/ill-raise-my-mom-well', cover: '', type: 'novel' },
      ] };
    },
  });
  assert.deepEqual(results, [{ seriesId: 'a-king-is-born-on-the-road-2', title: 'A King is Born on the Road', author: '',
    thumbnail: 'https://cdn.meowing.org/uploads/660c47e6311.avif', url: 'https://sirenscans.com/a-king-is-born-on-the-road-2' }]);
});

/* ---------------- Following ---------------- */

test('Following accepts the new sites by slug and their covers', () => {
  for (const id of ['eva', 'magus', 'valir', 'siren']) {
    assert.deepEqual(cleanRef(id, { seriesId: 'a-king-is-born-on-the-road' }), { seriesId: 'a-king-is-born-on-the-road', lang: 'en' });
    assert.ok(chapterSnapshot(id, [{ number: 1.5, chapterId: 1500, isFree: true }]));
  }
  for (const url of ['https://evascans.net/wp-content/uploads/c.jpeg', 'https://media.magustoon.org/c.jpg',
    'https://valirscans.org/uploads/series/c.webp', 'https://cdn.meowing.org/uploads/c.avif']) {
    assert.equal(safeCover(url), url);
  }
});
