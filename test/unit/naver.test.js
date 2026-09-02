import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naverAdapter, parseUrl, parseViewerImages } from '../../src/adapters/naver.js';
import { resolveUrl } from '../../src/adapters/registry.js';

// Attribute shape observed on the live mobile viewer for 836848, episode 1.
// The stub models selector routing too: the pre-fix desktop selector sees zero.
function mobileDoc(attributes) {
  return {querySelectorAll: selector => selector.split(',').map(s=>s.trim()).includes('img.toon_image')
    ? attributes.map(attrs=>({getAttribute:key=>attrs[key] ?? null})) : []};
}

test('mobile viewer extracts lazy data-src before transparent placeholder src', () => {
  const url = 'https://image-comic.pstatic.net/mobilewebimg/836848/1/page_001.jpg';
  const images = parseViewerImages(mobileDoc([
    {src:'https://ssl.pstatic.net/static/m/comic/im/2012/bg_transparency.png', 'data-src':url},
    {src:'https://ssl.pstatic.net/static/m/comic/im/2012/bg_transparency.png', 'data-src':url.replace('001','002')},
  ]));
  assert.deepEqual(images.map(i=>i.url), [url,url.replace('001','002')]);
  assert.deepEqual(images.map(i=>i.index), [1,2]);
});

test('mobile viewer skips placeholders and deduplicates overlapping images', () => {
  const url = 'https://image-comic.pstatic.net/mobilewebimg/836848/1/page.jpg';
  const images = parseViewerImages(mobileDoc([
    {src:'https://ssl.pstatic.net/static/m/comic/im/2012/bg_transparency.png'},
    {src:url}, {'data-src':url,src:url},
  ]));
  assert.equal(images.length, 1);
  assert.equal(images[0].url, url);
});

test('mobile viewer falls back to src when data-src is whitespace', () => {
  assert.equal(parseViewerImages(mobileDoc([{'data-src':'  ',src:'https://image-comic.pstatic.net/mobilewebimg/page.jpg'}])).length, 1);
});

test('chapter pipeline accepts a mobile document returned by desktop redirect', async () => {
  let requested;
  const images = await naverAdapter.getChapterImages({seriesId:'836848'}, {number:1}, {
    fetchDoc:async url => {
      requested = url;
      return mobileDoc([{'data-src':'https://image-comic.pstatic.net/mobilewebimg/836848/1/page.jpg'}]);
    },
  });
  assert.equal(requested, 'https://comic.naver.com/webtoon/detail?titleId=836848&no=1');
  assert.equal(images.length, 1);
});

test('routes the reported Naver URL and desktop/mobile viewer variants', () => {
  const resolved = resolveUrl('https://comic.naver.com/webtoon/list?titleId=828715');
  assert.equal(resolved.adapter.id, 'naver');
  assert.deepEqual(resolved.ref, { seriesId: '828715', lang: 'ko', section: 'webtoon' });
  assert.equal(parseUrl('https://m.comic.naver.com/webtoon/detail?titleId=828715&no=95').episodeNo, 95);
  assert.equal(parseUrl('https://comic.naver.com/webtoon/list.nhn?titleId=828715').seriesId, '828715');
  assert.equal(parseUrl('https://comic.naver.com.evil.test/webtoon/list?titleId=828715'), null);
  assert.equal(parseUrl('https://comic.naver.com/webtoon/list?titleId=no'), null);
});

test('Naver uses nextPage, retains actual episode numbers and sorts them', async () => {
  const calls = [];
  const series = await naverAdapter.getSeries({ seriesId: '828715' }, {
    fetchJson: async url => {
      calls.push(url);
      if (url.includes('/info?')) return { titleName: '절대회귀', communityArtists: { writers: [{name:'A'}], painters: [{name:'B'}] } };
      if (url.includes('page=1')) return { articleList: [{no:95,subtitle:'95화'},{no:91,subtitle:'91화'}], pageInfo: {nextPage:2} };
      return { articleList: [{no:91,subtitle:'91화'},{no:96,subtitle:'96화'}], pageInfo: {nextPage:null} };
    },
  });
  assert.equal(series.title, '절대회귀');
  assert.deepEqual(series.chapters.map(c=>c.number), [91,95,96]);
  assert.equal(series.author, 'A, B');
  assert.equal(calls.length, 3);
  assert.equal(series.chapters[1].url, 'https://comic.naver.com/webtoon/detail?titleId=828715&no=95');
});

test('Naver rejects repeated pagination rather than silently claiming a complete list', async () => {
  await assert.rejects(naverAdapter.getSeries({seriesId:'1'}, {
    fetchJson: async url => url.includes('/info?') ? {} : {articleList:[{no:1}],pageInfo:{nextPage:2}},
  }), /pagination stopped/);
});

test('Naver extracts chapter images, excludes static assets, keeps published URLs', () => {
  const img = attrs => ({getAttribute:key=>attrs[key] ?? null});
  const images = parseViewerImages({querySelectorAll:()=>[
    img({src:'https://image-comic.pstatic.net/webtoon/828715/95/page.jpg'}),
    img({src:'https://image-comic.pstatic.net/webtoon/828715/95/page.jpg'}),
    img({src:'https://image-comic.pstatic.net/static/logo.png'}),
    img({'data-src':'//image-comic.pstatic.net/webtoon/828715/95/page2.jpg', width:'690',height:'1000'}),
  ]});
  assert.equal(images.length, 2);
  assert.equal(images[1].index, 2);
  assert.equal(images[1].width, 690);
});
