import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUrl, getAdapterForUrl, getAdapterById } from '../../src/adapters/registry.js';
import { toOriginalQuality, buildListUrl, buildSearchUrl, parseUrl } from '../../src/adapters/webtoons.js';
import {
  parseUrl as parseKakaoUrl,
  kakaoAdapter,
  parseChapterPage,
  parseViewerImages,
} from '../../src/adapters/kakao.js';
import { ProtectedContentError, UnsupportedUrlError } from '../../src/common/errors.js';

test('parses a webtoons series list URL', () => {
  assert.deepEqual(parseUrl('https://www.webtoons.com/en/fantasy/tower-of-god/list?title_no=95'), {
    seriesId: '95',
    lang: 'en',
    genre: 'fantasy',
    slug: 'tower-of-god',
  });
});

test('parses a webtoons viewer URL including the episode number', () => {
  const parsed = parseUrl('https://www.webtoons.com/th/fantasy/x/ep-1/viewer?title_no=95&episode_no=42');
  assert.equal(parsed.episodeNo, 42);
  assert.equal(parsed.lang, 'th');
});

test('falls back to English for an unknown language segment', () => {
  assert.equal(parseUrl('https://www.webtoons.com/xx/g/s/list?title_no=1').lang, 'en');
});

test('rejects webtoons URLs without a title_no', () => {
  assert.equal(parseUrl('https://www.webtoons.com/en/fantasy/tower-of-god/list'), null);
  assert.equal(parseUrl('not a url'), null);
});

test('a lookalike hostname is not routed to the webtoons adapter', () => {
  // Guards against matching on a bare substring.
  assert.equal(getAdapterForUrl('https://webtoons.com.evil.example/x?title_no=1'), null);
  assert.equal(getAdapterForUrl('https://notwebtoons.com/x'), null);
  assert.equal(getAdapterForUrl('https://m.webtoons.com/en/g/s/list?title_no=1').id, 'webtoons');
});

test('original-quality rewriting drops only the type parameter', () => {
  // Verified against the live CDN: dropping ?type=q90 returns the source
  // encode at the same dimensions (159 KB vs 57 KB on a sample page).
  assert.equal(toOriginalQuality('https://cdn/x.jpg?type=q90'), 'https://cdn/x.jpg');
  // Other parameters are load-bearing and must survive.
  assert.equal(toOriginalQuality('https://cdn/x.jpg?type=q90&t=123'), 'https://cdn/x.jpg?t=123');
  assert.equal(toOriginalQuality('https://cdn/x.jpg?t=9'), 'https://cdn/x.jpg?t=9');
  assert.equal(toOriginalQuality('https://cdn/x.jpg'), 'https://cdn/x.jpg');
  assert.equal(toOriginalQuality('not-a-url'), 'not-a-url');
});

test('builds list and search URLs', () => {
  const ref = { lang: 'en', genre: 'fantasy', slug: 'tower-of-god', seriesId: '95' };
  assert.equal(buildListUrl(ref, 3), 'https://www.webtoons.com/en/fantasy/tower-of-god/list?title_no=95&page=3');
  assert.equal(buildSearchUrl('a b', 'th'), 'https://www.webtoons.com/th/search?keyword=a%20b');
  // An unknown language must not end up in the path.
  assert.ok(buildSearchUrl('x', 'zz').startsWith('https://www.webtoons.com/en/'));
});

test('resolveUrl reports the two failure modes distinctly', () => {
  assert.throws(() => resolveUrl('https://example.com/a'), UnsupportedUrlError);
  assert.throws(
    () => resolveUrl('https://www.webtoons.com/en/fantasy/x/list'),
    /not a series or episode URL/,
  );
});

/* -------------------------- Kakao: free chapters only ---------------------- */

test('kakao content and viewer URLs are recognised', () => {
  assert.deepEqual(parseKakaoUrl('https://page.kakao.com/content/69103222'), {
    seriesId: '69103222',
    lang: 'ko',
  });
  assert.equal(
    parseKakaoUrl('https://page.kakao.com/content/69103222/viewer/69302779').episodeNo,
    69302779,
  );
  assert.equal(parseKakaoUrl('https://page.kakao.com/'), null);
  assert.equal(parseKakaoUrl('https://page.kakao.com/content/abc'), null);
});

test('kakao is registered, downloadable and supports opt-in account access', () => {
  const kakao = getAdapterById('kakao');
  assert.equal(kakao.capabilities.download, true);
  assert.equal(kakao.capabilities.freeChaptersOnly, false);
  assert.equal(kakao.capabilities.accountAccess, true);
  assert.equal(resolveUrl('https://page.kakao.com/content/69103222').adapter.id, 'kakao');
});

test('parseChapterPage reads the is_free flag per chapter', () => {
  const chapters = parseChapterPage({
    list: [
      { cursor_index: 1, item: { product_id: '111', title: '1화', is_free: true } },
      { cursor_index: 2, item: { product_id: '222', title: '2화', is_free: false } },
      // A missing flag must never be read as free.
      { cursor_index: 3, item: { product_id: '333', title: '3화' } },
      { cursor_index: 4, item: { product_id: '444', title: '4화', is_free: 'true' } },
      { cursor_index: 5, item: {} },
    ],
  });
  assert.deepEqual(
    chapters.map((c) => [c.number, c.isFree]),
    [
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
    ].slice(0, 4),
  );
  assert.equal(chapters.length, 4, 'an item without a product_id is dropped');
});

test('parseViewerImages maps files and keeps published dimensions', () => {
  const images = parseViewerImages({
    type: 'ImageViewerData',
    imageDownloadData: {
      files: [
        { no: 1, secureUrl: 'https://cdn/1.jpg', width: 760, height: 1100 },
        { no: 2, secureUrl: 'https://cdn/2.jpg', width: 760, height: 980 },
      ],
    },
  });
  assert.deepEqual(images, [
    { url: 'https://cdn/1.jpg', index: 1, width: 760, height: 1100 },
    { url: 'https://cdn/2.jpg', index: 2, width: 760, height: 980 },
  ]);
});

test('parseViewerImages rejects a non-image viewer payload', () => {
  assert.throws(() => parseViewerImages({ type: 'TextViewerData' }), /Unsupported Kakao viewer/);
  assert.throws(() => parseViewerImages(null), /Unsupported Kakao viewer/);
});

test('a locked chapter is refused WITHOUT any network request', async () => {
  // The whole boundary of this adapter. If the is_free check ever moves after
  // the fetch, this test fails -- which is the point.
  let calls = 0;
  const ctx = {
    fetchJson: async () => {
      calls++;
      return {};
    },
  };
  await assert.rejects(
    () => kakaoAdapter.getChapterImages({ seriesId: '69103222' }, { number: 4, isFree: false }, ctx),
    ProtectedContentError,
  );
  assert.equal(calls, 0, 'no request may be made for a locked chapter');

  // A chapter with no flag at all is locked too.
  await assert.rejects(
    () => kakaoAdapter.getChapterImages({ seriesId: '1' }, { number: 9 }, ctx),
    ProtectedContentError,
  );
  assert.equal(calls, 0);
});

test('a free chapter yields its images', async () => {
  const requested = [];
  const ctx = {
    fetchJson: async (url) => {
      requested.push(url);
      return {
        viewer_data: {
          type: 'ImageViewerData',
          imageDownloadData: {
            files: [{ no: 1, secureUrl: 'https://cdn/a.jpg', width: 760, height: 1100 }],
          },
        },
      };
    },
  };
  const images = await kakaoAdapter.getChapterImages(
    { seriesId: '69103222' },
    { number: 1, productId: '69302779', isFree: true },
    ctx,
  );
  assert.equal(images.length, 1);
  assert.equal(images[0].url, 'https://cdn/a.jpg');
  assert.match(requested[0], /series_id=69103222&product_id=69302779/);
});

test('missing Kakao viewer data is reported as an API/access error, not assumed to be DRM', async () => {
  // Missing data does not identify the reason for failure.
  const ctx = { fetchJson: async () => ({}) };
  await assert.rejects(
    () => kakaoAdapter.getChapterImages({ seriesId: '1' }, { number: 1, isFree: true }, ctx),
    /Kakao returned no viewer data/,
  );
});

test('getSeries paginates and preserves per-chapter free flags', async () => {
  const pages = [
    {
      result: {
        series_item: { title: 'Test Series', thumbnail: 'https://cdn/cover.jpg' },
        has_next: true,
        list: [
          { cursor_index: 1, item: { product_id: 'a', title: '1화', is_free: true } },
          { cursor_index: 2, item: { product_id: 'b', title: '2화', is_free: true } },
        ],
      },
    },
    {
      result: {
        has_next: false,
        list: [{ cursor_index: 3, item: { product_id: 'c', title: '3화', is_free: false } }],
      },
    },
  ];
  let call = 0;
  const ctx = { fetchJson: async () => pages[call++] };

  const series = await kakaoAdapter.getSeries({ seriesId: '69103222' }, ctx);
  assert.equal(series.title, 'Test Series');
  assert.equal(series.cover, 'https://cdn/cover.jpg');
  assert.deepEqual(
    series.chapters.map((c) => [c.number, c.isFree]),
    [
      [1, true],
      [2, true],
      [3, false],
    ],
  );
});

test('getSeries stops if the cursor stops advancing', async () => {
  // A pagination contract change must not spin forever.
  const ctx = {
    fetchJson: async () => ({
      result: {
        has_next: true,
        list: [{ cursor_index: 1, item: { product_id: 'a', title: '1', is_free: true } }],
      },
    }),
  };
  const series = await kakaoAdapter.getSeries({ seriesId: '1' }, ctx);
  assert.equal(series.chapters.length, 1);
});

test('Kakao validates missing image URLs instead of fetching undefined', () => {
  assert.throws(() => parseViewerImages({type:'ImageViewerData',imageDownloadData:{files:[{no:1}]}}), /no valid download URL/);
});

test('Kakao orders pages numerically while preserving signed URLs', () => {
  const images = parseViewerImages({type:'ImageViewerData',imageDownloadData:{files:[
    {no:2,secureUrl:'https://page-edge.kakao.com/b?signature=abc%2Bdef'},
    {no:1,secureUrl:'https://page-edge.kakao.com/a?signature=xyz'},
  ]}});
  assert.deepEqual(images.map(i=>i.index),[1,2]);
  assert.equal(images[1].url,'https://page-edge.kakao.com/b?signature=abc%2Bdef');
});

test('Kakao accepts viewer_data inside a result envelope for free chapters', async () => {
  const images = await kakaoAdapter.getChapterImages({seriesId:'1'}, {number:1,productId:'2',isFree:true}, {
    fetchJson:async()=>({result:{viewer_data:{type:'ImageViewerData',imageDownloadData:{files:[{no:1,secureUrl:'https://page-edge.kakao.com/a.jpg'}]}}}}),
  });
  assert.equal(images.length,1);
});
