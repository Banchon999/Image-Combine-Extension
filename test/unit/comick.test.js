import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comickSearchUrl, parseComickResults, titlesToSearch, titleMatches, normalizeTitle, findOnSites, FIND_SITES } from '../../src/common/comick.js';
import { getAdapterById } from '../../src/adapters/registry.js';

// Trimmed from a live api.comick.dev/v1.0/search answer (2026-11-23).
const ROW = {
  id: 442855, hid: 'U5dgZzDi', slug: 'a-king-is-born-on-the-road', title: 'A King is Born on the Road',
  last_chapter: 20, year: 2026, country: 'kr', content_rating: 'safe',
  md_titles: [
    { id: 16221025, title: 'A King is Born on the Road', lang: 'en', is_default: true },
    { id: 16221026, title: '왕은 길 위에서 태어난다', lang: 'ko', is_default: false },
  ],
  md_covers: [{ w: 963, h: 1403, b2key: 'jx5r1X.jpg' }],
  highlight: '<mark>A</mark> <mark>King</mark>',
};

test('comick: search URL and result parsing', () => {
  assert.equal(comickSearchUrl(' 왕은 길 '), 'https://api.comick.dev/v1.0/search?q=%EC%99%95%EC%9D%80%20%EA%B8%B8&limit=20');
  const [item] = parseComickResults([ROW, ROW, { hid: '../x', title: 'Bad' }, { hid: 'abc', title: '' }]);
  assert.deepEqual(item, {
    hid: 'U5dgZzDi', title: 'A King is Born on the Road', altTitles: ['왕은 길 위에서 태어난다'],
    englishTitles: ['A King is Born on the Road'], cover: 'https://meo.comick.pictures/jx5r1X.jpg',
    year: 2026, country: 'kr', lastChapter: 20, contentRating: 'safe',
  });
  assert.equal(parseComickResults([ROW, ROW]).length, 1, 'duplicates dropped');
  assert.equal(parseComickResults({ statusCode: 403 }).length, 0);
  assert.equal(parseComickResults([{ ...ROW, md_covers: [{ b2key: '../evil.svg' }] }])[0].cover, '');
});

test('comick: titles to search are distinct, English first, at most four', () => {
  const item = parseComickResults([{ ...ROW, md_titles: [
    ...ROW.md_titles,
    { title: 'A King Is Born On The Road!', lang: 'en' },
    { title: 'The Born King', lang: 'en' },
    { title: 'King Road', lang: 'en' },
    { title: 'Road King', lang: 'en' },
  ] }])[0];
  assert.deepEqual(titlesToSearch(item), ['A King is Born on the Road', 'The Born King', 'King Road', 'Road King']);
});

test('comick: title matching ignores case and punctuation, not unrelated titles', () => {
  assert.equal(normalizeTitle('The Villain’s Daughter-in-Law'), 'the villains daughter in law');
  const titles = ['A King is Born on the Road'];
  assert.ok(titleMatches('A King Is Born On The Road', titles));
  assert.ok(titleMatches('a king is born on the road (official)', titles));
  assert.ok(!titleMatches('Solo Leveling: Ragnarok', ['Solo Leveling']), 'a sequel is another series');
  assert.ok(!titleMatches('A King is Born', titles), 'short prefix of the wanted title is too loose');
  assert.ok(!titleMatches('The Holy King wants to be killed', titles));
  assert.ok(!titleMatches('King', ['King of the Road']));
  assert.ok(titleMatches('Ève & Moi', ['Eve and Moi']));
});

test('comick: findOnSites keeps matches per site, tries the next title only while nothing matched, and reports failures', async () => {
  const calls = [];
  const sites = await findOnSites(['A King is Born on the Road', 'Another Name'], async (adapterId, title) => {
    calls.push(`${adapterId}:${title}`);
    if (adapterId === 'valir') throw new Error('HTTP 503');
    if (adapterId === 'eva') return [
      { title: 'A King is Born on the Road', url: 'https://evascans.net/series/a-king-is-born-on-the-road/' },
      { title: 'The Holy King', url: 'https://evascans.net/series/holy/' },
    ];
    if (adapterId === 'siren' && title === 'Another Name') return [{ title: 'Another Name', url: 'https://sirenscans.com/another-name' }];
    return [];
  }, (id) => id.toUpperCase(), ['eva', 'siren', 'valir']);
  assert.deepEqual(sites, [
    { adapterId: 'eva', label: 'EVA', results: [{ title: 'A King is Born on the Road', url: 'https://evascans.net/series/a-king-is-born-on-the-road/' }] },
    { adapterId: 'siren', label: 'SIREN', results: [{ title: 'Another Name', url: 'https://sirenscans.com/another-name' }] },
    { adapterId: 'valir', label: 'VALIR', results: [], error: 'HTTP 503' },
  ]);
  assert.deepEqual(calls.filter((c) => c.startsWith('eva:')), ['eva:A King is Born on the Road'], 'stops after a match');
  assert.deepEqual(await findOnSites(['  '], async () => assert.fail()), []);
});

test('comick: every site it searches exists and can search', () => {
  for (const id of FIND_SITES) assert.equal(getAdapterById(id)?.capabilities.search, true, id);
});

test('comick: a result found by its Korean name still shows the English name', () => {
  const [item] = parseComickResults([{ ...ROW, title: '왕은 길 위에서 태어난다' }]);
  assert.equal(item.title, 'A King is Born on the Road');
  assert.deepEqual(item.altTitles, ['왕은 길 위에서 태어난다']);
  assert.deepEqual(titlesToSearch(item), ['A King is Born on the Road']);
});

test('comick: alternative names list English, then the original language', () => {
  const [item] = parseComickResults([{ ...ROW, md_titles: [
    { title: 'Die Königin auf der Straße', lang: 'de' },
    ...ROW.md_titles,
    { title: 'The Road King', lang: 'en' },
  ] }]);
  assert.deepEqual(item.altTitles, ['The Road King', '왕은 길 위에서 태어난다', 'Die Königin auf der Straße']);
});
