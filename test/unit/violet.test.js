import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as violet from '../../src/adapters/violet.js';
import { resolveUrl } from '../../src/adapters/registry.js';
import { cleanRef, createFollowEntry, safeCover } from '../../src/common/following.js';
import { FetchError, ProtectedContentError } from '../../src/common/errors.js';

// Markup trimmed from live violetmanga.com pages (2026-10-22), quirks kept:
// tab-indented lines, "<a  href" with two spaces, the price and countdown in
// their own tags.
const UP = 'https://violetmanga.com/wp-content/uploads';
const freeItem = (slug, n, date = 'October 21, 2026') => `
\t\t\t<li data-num="${n}">
\t\t\t<a  href="https://violetmanga.com/${slug}-chapter-${n}/" >
\t\t\t\t<div class="chbox">
\t\t\t\t\t<div class="eph-num">
\t\t\t\t\t\t<span class="chapternum"> Chapter ${n}</span>
\t\t\t\t\t\t<span class="chapterdate">${date}</span>
\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t</a>
\t\t\t</li>`;
const lockedItem = (n, id, coins) => `
\t\t\t<li data-num="${n}">
\t\t\t<a data-bs-toggle="modal" data-bs-target="#lockedChapterModal" data-id="${id}" data-coin="${coins}" data-title="Chapter ${n}" >
\t\t\t\t<div class="chbox"><div class="eph-num">
\t\t\t\t\t<span class="chapternum"> Chapter ${n}</span>
\t\t\t\t\t<span class="chapterdate">October 21, 2026</span>
\t\t\t\t</div><span class=" text-gold "><svg viewBox="0 0 512 512"><path d="M0 405.3"/></svg> ${coins}</span></div>
\t\t\t</a>
\t\t\t</li>`;
const seriesPage = ({ slug = 'in-honor-of-you-who-survived', title = 'In Honor of You Who Survived', type = 'Manhwa', items = '' } = {}) => `<html><head>
<meta property="og:title" content="${title} Manga | Violet Scans" />
<meta property="og:image" content="${UP}/2026/10/2026-10-21-06-55-19.webp" />
</head><body>
<h1 class="entry-title" itemprop="name">${title}</h1>
<div class="entry-content entry-content-single" itemprop="description"><p>For Lucienne, a shockingly beautiful yet lowly maid&#8230;</p>
<p>Second paragraph &amp; more.</p></div>
<div class="tsinfo bixbox">
<div class="imptdt">
<h1> Type </h1> <i>${type}</i>
</div>
<div class="imptdt">
<h1> Author </h1> <i>Woo Ji-hye</i>
</div>
<div class="imptdt">
<h1> Artist </h1> <i>Woo Ji-hye</i>
</div>
</div>
<div class="eplister" id="chapterlist"><ul class="clstyle">${items}
</ul></div></body></html>`;
const IHOY = seriesPage({ items: lockedItem(6, 437887, 50) + [5, 4, 3, 2, 1].map((n) => freeItem('in-honor-of-you-who-survived', n)).join('') });

// Serena chapter list order as the site serves it: 0002 ... 0009, then 0001,
// which is the real last page (closing panel and recruiting notice).
const PAGES = ['0002_8d82739c', '0003_9df82789', '0004_ae22a29f', '0009_14e21c65', '0001_85f9f949']
  .map((name) => `${UP}/manga/8e5dc81cbe37664e7eee9fc744f212e9/${name}.webp`);
const chapterPage = (images = PAGES) => `<html><body>
<div class="allc">All chapters are in <a href="https://violetmanga.com/comics/a-fortune-telling-princess/">A Fortune-Telling Princess</a></div>
<div id="readerarea"></div>
<script>ts_reader.run(${JSON.stringify({ post_id: 73370, noimagehtml: '<center><h4>NO IMAGE YET</h4></center>', mode: 'full', sources: [{ source: 'Server 1', images }] }).replace(/\//g, '\\/')});</script>
</body></html>`;
const LOCKED_PAGE = `<html><body><div class="lock-container"><div class="lock-card">
<h2 class="lock-title">This chapter is locked.</h2> <p>Please purchase it to read the full content.</p>
<span id="countdown-prefix">Free in</span> <span id="countdown-timer" class="countdown-timer">2026-10-28 22:28:14</span>
<button>
          Buy now for
          <span class="coin-amount">50</span> Coins
</button></div></div>
<a href="https://violetmanga.com/comics/in-honor-of-you-who-survived/" class="btn-enhanced btn-back-enhanced">Go back to series</a>
</body></html>`;
const searchItem = (slug, title, format = 'manhwa') => `<div class="bs"> <div class="bsx"> <a href="https://violetmanga.com/comics/${slug}/" title="${title}"> <div class="limit">
${format ? `<span class="colored violet-format violet-format--${format}">${format.toUpperCase()}</span>` : ''}
<img src="${UP}/2026/10/${slug}-207x300.png" class="ts-post-image" /> </div> <div class="bigor"><div class="tt"> ${title} </div></div> </a> </div> </div>`;
const searchPage = (items, next) => `<html><body><div class="listupd">${items.join('')}</div>
<div class="pagination">${next ? `<a class="next page-numbers" href="https://violetmanga.com/page/${next}/?s=x">Next</a>` : ''}</div></body></html>`;

const raw = (map) => async (url) => {
  const entry = map(url);
  if (entry instanceof Error) throw entry;
  return { text: async () => entry };
};
const notFound = (url) => new FetchError(`HTTP 404 for ${url}`, { url, status: 404 });

test('Violet: series and chapter links on the current and old domains', () => {
  assert.deepEqual(violet.parseUrl('https://violetmanga.com/comics/serena/'), { seriesId: 'serena', lang: 'en' });
  assert.deepEqual(violet.parseUrl('https://violetscans.org/comics/serena'), { seriesId: 'serena', lang: 'en' });
  assert.deepEqual(violet.parseUrl('https://violetmanga.com/serena-chapter-147/'),
    { seriesId: 'serena', lang: 'en', episodeNo: 147, chapterPath: '/serena-chapter-147/' });
  assert.equal(violet.parseUrl('https://www.violetmanga.com/a-fortune-telling-princess-chapter-0').episodeNo, 0);
  assert.equal(violet.parseUrl('https://violetmanga.com/x-chapter-12-5/').episodeNo, 12.5);
  for (const bad of ['https://violetmanga.com/', 'https://violetmanga.com/comics/', 'https://violetmanga.com/about/',
    'https://violetmanga.com.evil.com/comics/x/', 'ftp://violetmanga.com/comics/x/', 'nope']) {
    assert.equal(violet.parseUrl(bad), null, bad);
  }
  assert.equal(resolveUrl('https://violetscans.com/comics/serena/').adapter.id, 'violet');
});

test('Violet: series page gives metadata and marks paid chapters', () => {
  const series = violet.parseSeriesPage(IHOY, 'in-honor-of-you-who-survived');
  assert.equal(series.title, 'In Honor of You Who Survived');
  assert.equal(series.author, 'Woo Ji-hye', 'author and artist are the same person, listed once');
  assert.equal(series.summary, 'For Lucienne, a shockingly beautiful yet lowly maid…\n\nSecond paragraph & more.');
  assert.equal(series.cover, `${UP}/2026/10/2026-10-21-06-55-19.webp`);
  assert.deepEqual(series.chapters.map((c) => [c.number, c.isFree]), [[1, true], [2, true], [3, true], [4, true], [5, true], [6, false]]);
  assert.deepEqual(series.chapters[0], {
    number: 1, title: '', date: '2026-10-21', chapterId: 1000,
    url: 'https://violetmanga.com/in-honor-of-you-who-survived-chapter-1/', isFree: true,
  });
  assert.deepEqual(series.chapters[5].lock, { price: 50 });
  assert.equal(series.chapters[5].chapterId, 6000, 'same id scheme as free chapters, so it survives unlocking');
});

test('Violet: novels are refused with a clear reason', () => {
  assert.throws(() => violet.parseSeriesPage(seriesPage({ title: 'A World Where You All Are The Villains [Novel]', type: 'Novel' }), 'x'),
    (e) => e instanceof FetchError && /text novel/.test(e.message));
});

test('Violet: pages keep the reader order, never re-sorted by file name', () => {
  const images = violet.parseChapterImages(chapterPage(), 1);
  assert.deepEqual(images.map((i) => i.url.split('/').pop().slice(0, 4)), ['0002', '0003', '0004', '0009', '0001']);
  assert.deepEqual(images.map((i) => i.index), [1, 2, 3, 4, 5]);
  assert.throws(() => violet.parseChapterImages(chapterPage([]), 1), /no pages yet/);
  assert.throws(() => violet.parseChapterImages('<html><p>Chapter text…</p></html>', 1), /no image reader/);
});

test('Violet: the locked page is protected and names the price and free date', () => {
  assert.throws(() => violet.parseChapterImages(LOCKED_PAGE, 6),
    (e) => e instanceof ProtectedContentError && /costs 50 coins/.test(e.message) && /free from 2026-10-28 22:28/.test(e.message));
});

test('Violet: a paid chapter is refused before any request', async () => {
  const chapter = violet.parseSeriesPage(IHOY, 'in-honor-of-you-who-survived').chapters.find((c) => c.number === 6);
  await assert.rejects(violet.violetAdapter.getChapterImages({ seriesId: 'x' }, chapter, {
    fetchRaw: async () => assert.fail('must not request a paid chapter'),
  }), (e) => e instanceof ProtectedContentError && /costs 50 coins/.test(e.message));
});

test('Violet: a free chapter is read from its own page; other hosts are refused', async () => {
  const calls = [];
  const chapter = violet.parseSeriesPage(IHOY, 'in-honor-of-you-who-survived').chapters[0];
  const images = await violet.violetAdapter.getChapterImages({ seriesId: 'x' }, chapter, {
    fetchRaw: raw((url) => { calls.push(url); return chapterPage(); }),
  });
  assert.deepEqual(calls, ['https://violetmanga.com/in-honor-of-you-who-survived-chapter-1/']);
  assert.equal(images.length, 5);
  for (const url of ['https://evil.example/x/', 'http://violetmanga.com/x-chapter-1/', '']) {
    await assert.rejects(violet.violetAdapter.getChapterImages({ seriesId: 'x' }, { number: 1, isFree: true, url }, {
      fetchRaw: async () => assert.fail('must not fetch an unexpected host'),
    }), /no valid link/);
  }
});

test('Violet: getSeries reads one page; a wrong slug from a chapter link is corrected', async () => {
  const calls = [];
  const series = await violet.violetAdapter.getSeries({ seriesId: 'in-honor-of-you-who-survived', lang: 'en' }, {
    fetchRaw: raw((url) => { calls.push(url); return IHOY; }),
  });
  assert.deepEqual(calls, ['https://violetmanga.com/comics/in-honor-of-you-who-survived/']);
  assert.equal(series.chapters.length, 6);

  const ref = violet.parseUrl('https://violetmanga.com/old-name-chapter-3/');
  const fixed = await violet.violetAdapter.getSeries(ref, {
    fetchRaw: raw((url) => (url.endsWith('/comics/old-name/') ? notFound(url)
      : url.endsWith('/old-name-chapter-3/') ? chapterPage()
        : url.endsWith('/comics/a-fortune-telling-princess/') ? IHOY : assert.fail(url))),
  });
  assert.equal(ref.seriesId, 'a-fortune-telling-princess', 'Following stores the real series');
  assert.equal(fixed.chapters.length, 6);

  await assert.rejects(violet.violetAdapter.getSeries({ seriesId: 'no-such' }, { fetchRaw: raw(notFound) }),
    (e) => /no series "no-such"/.test(e.message));
});

test('Violet: search keeps comics, drops novels, and follows pages up to the limit', async () => {
  const page1 = searchPage([
    searchItem('serena', 'Serena'),
    searchItem('a-world-where-you-all-are-the-villains-novel', 'A World Where You All Are The Villains [Novel]', ''),
    // A comic whose slug ends in "novel".
    searchItem('i-became-the-young-wife-of-the-male-protagonist-of-a-martial-arts-novel', 'I Became The Young Wife of The Male Protagonist of a Martial Arts Novel'),
    searchItem('defending-the-villains-innocence', 'Defending the Villain&#8217;s Innocence'),
  ], 2);
  const page2 = searchPage([searchItem('kill-the-villainess', 'Kill the Villainess', 'manga')], null);
  const calls = [];
  const results = await violet.violetAdapter.search('villain', 'en', {
    fetchRaw: raw((url) => { calls.push(url); return url.includes('/page/2/') ? page2 : page1; }),
  });
  assert.deepEqual(calls, ['https://violetmanga.com/?s=villain', 'https://violetmanga.com/page/2/?s=villain']);
  assert.deepEqual(results.map((r) => r.seriesId), ['serena',
    'i-became-the-young-wife-of-the-male-protagonist-of-a-martial-arts-novel', 'defending-the-villains-innocence', 'kill-the-villainess']);
  assert.equal(results[2].title, 'Defending the Villain’s Innocence');
  assert.equal(results[0].url, 'https://violetmanga.com/comics/serena/');
  assert.equal(results[0].thumbnail, `${UP}/2026/10/serena-207x300.png`);

  // Never more than 5 pages, even if the site keeps offering "next".
  let pages = 0;
  const many = await violet.violetAdapter.search('a', 'en', {
    fetchRaw: raw(() => { pages++; return searchPage(Array.from({ length: 10 }, (_, i) => searchItem(`s${pages}-${i}`, `S ${pages} ${i}`)), 99); }),
  });
  assert.equal(pages, 5);
  assert.equal(many.length, 50);
  assert.deepEqual(await violet.violetAdapter.search('  ', 'en', { fetchRaw: async () => assert.fail() }), []);
});

test('Violet: Following stores the slug and number-based chapter ids', () => {
  assert.deepEqual(cleanRef('violet', { seriesId: 'serena', chapterPath: '/serena-chapter-1/' }), { seriesId: 'serena', lang: 'en' });
  assert.equal(safeCover(`${UP}/2026/10/x.webp`), `${UP}/2026/10/x.webp`);
  const series = violet.parseSeriesPage(IHOY, 'in-honor-of-you-who-survived');
  const entry = createFollowEntry({ adapterId: 'violet', ref: { seriesId: 'in-honor-of-you-who-survived', lang: 'en' }, series }, 1, 'x');
  assert.equal(entry.id, 'violet:en::in-honor-of-you-who-survived');
  assert.deepEqual(entry.known.map((c) => c.id), ['1000', '2000', '3000', '4000', '5000', '6000']);
});

test('Violet: small helpers', () => {
  assert.equal(violet.isoDate('January 24, 2025'), '2025-01-24');
  assert.equal(violet.isoDate('nope'), '');
  assert.equal(violet.decodeHtml('Don&#8217;t &amp; &#x2019; &hellip; &bogus;'), 'Don’t & ’ … &bogus;');
  assert.equal(violet.chapterIdFor(152.5), 152500);
  assert.equal(violet.seriesSlugFromChapterPage(LOCKED_PAGE), 'in-honor-of-you-who-survived');
});
