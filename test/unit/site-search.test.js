import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSiteSearchUrl, readSearchPage } from '../../src/common/site-search.js';
import { searchInTab, sameSearchPage } from '../../src/background/site-search.js';
import { naverAdapter } from '../../src/adapters/naver.js';
import { kakaoAdapter } from '../../src/adapters/kakao.js';

// Minimal selector-aware DOM doubles model observed mobile NAVER / Kakao cards.
function card({provider = 'naver', id = '769209', title = '화산귀환', href,
  author = 'ARCHE, LICO / 비가', image = 'https://image-comic.pstatic.net/cover.jpg', metadata = true} = {}) {
  const naver = provider === 'naver';
  return {
    getAttribute: name => name === 'href' ? href ?? (naver ? `/webtoon/list?titleId=${id}` : `/content/${id}/`) : null,
    querySelector: selector => {
      if (selector === (naver ? '.toon_name' : '.line-clamp-2')) return {textContent: title};
      if (selector === 'p.sub_info' && naver) return {textContent: author};
      if (selector === '[aria-label^="작품,"]') return metadata ? {} : null;
      if (selector === (naver ? 'img' : 'img[alt="썸네일"]')) return {getAttribute: key => key === 'src' ? image : null};
      return null;
    },
    querySelectorAll: selector => selector === '.mb-12pxr span' ? [{textContent:'판타지'}, {textContent:author}] : [],
  };
}
function doc(provider, cards = [], empty = false) {
  return {
    querySelectorAll: selector => {
      if (selector === (provider === 'naver' ? '.section_search_result .result_lst a[href]' : 'a.flex-1[href]')) return cards;
      if (selector === 'span, p, div' && empty) return [{children:[],textContent:'검색 결과가 없습니다.'}];
      return [];
    },
    querySelector: selector => empty && provider === 'naver' && selector === '.section_search_result .no_lst' ? {} : null,
  };
}

test('search URLs safely encode Korean, ampersands and spaces and fix the webtoon category', () => {
  for (const provider of ['naver','kakao']) {
    const url = new URL(buildSiteSearchUrl(provider, '  화산 & a?categoryUid=11  '));
    assert.equal(url.searchParams.get('keyword'), '화산 & a?categoryUid=11');
    assert.equal(url.searchParams.get(provider === 'naver' ? 'searchType' : 'categoryUid'), provider === 'naver' ? 'WEBTOON' : '10');
  }
  assert.throws(()=>buildSiteSearchUrl('kakao',' '), /Type a title/);
  assert.throws(()=>buildSiteSearchUrl('unknown','a'), /Unsupported/);
});

test('NAVER maps titles/authors/covers, deduplicates and canonicalizes series URLs', () => {
  const result = readSearchPage('naver', doc('naver',[card(),card(),card({id:'2', title:' second\n title '})]));
  assert.equal(result.ready,true);
  assert.equal(result.items.length,2);
  assert.equal(result.items[0].author,'ARCHE, LICO / 비가');
  assert.equal(result.items[0].url,'https://comic.naver.com/webtoon/list?titleId=769209');
  assert.equal(result.items[1].title,'second title');
});

test('Kakao reads the final author span, not genre; keeps commas in author names', () => {
  const result = readSearchPage('kakao', doc('kakao',[card({provider:'kakao',id:'50866481', title:'나 혼자만 레벨업',author:'현군,장성락,추공'})]));
  assert.equal(result.items[0].author,'현군,장성락,추공');
  assert.equal(result.items[0].url,'https://page.kakao.com/content/50866481');
});

test('rejects cross-origin URLs, wrong sections, episode links and non-search Kakao tiles', () => {
  assert.equal(readSearchPage('naver',doc('naver',[
    card({href:'https://evil.test/webtoon/list?titleId=1'}),
    card({href:'/bestChallenge/list?titleId=2'}), card({href:'/webtoon/detail?titleId=3&no=1'}),
    card({href:'javascript:alert(1)'}), card({id:'nan'}),card({title:''}),
  ])).items.length,0);
  assert.equal(readSearchPage('kakao',doc('kakao',[
    card({provider:'kakao',metadata:false}),card({provider:'kakao',href:'/content/12/viewer/13'}),
  ])).items.length,0);
});

test('bad thumbnail protocols are excluded without losing the title', () => {
  assert.equal(readSearchPage('naver',doc('naver',[card({image:'javascript:alert(1)'})])).items[0].thumbnail,'');
});

test('explicit empty pages are ready; empty loading shells are not', () => {
  for (const provider of ['naver','kakao']) {
    assert.deepEqual(readSearchPage(provider,doc(provider,[],true)),{ready:true,items:[]});
    assert.deepEqual(readSearchPage(provider,doc(provider)),{ready:false,items:[]});
  }
});

test('both adapters advertise search and refuse to disguise unrendered HTML as zero results', async () => {
  for (const adapter of [naverAdapter,kakaoAdapter]) {
    assert.equal(adapter.capabilities.search,true);
    let requested;
    assert.deepEqual(await adapter.search('a','en',{fetchDoc:async url=>{requested=url;return doc(adapter.id,[],true);}}),[]);
    assert.equal(requested,buildSiteSearchUrl(adapter.id,'a'));
    await assert.rejects(adapter.search('a','ko',{fetchDoc:async()=>doc(adapter.id)}),/rendered page/);
  }
});

function fakeBrowser({results = [{ready:true,items:[{seriesId:'1'}]}], scriptError,
  redirect, status = 'complete'} = {}) {
  const calls = {created:[],removed:[],scripts:[]};
  let index = 0;
  let url;
  const api = {
    tabs: {
      create: async options => {calls.created.push(options);url=options.url;return {id:17};},
      get: async id => {assert.equal(id,17);return {id,url:redirect ?? url,status};},
      remove: async id => {calls.removed.push(id);},
    },
    scripting: {executeScript: async options => {
      calls.scripts.push(options);
      if (scriptError) throw scriptError;
      return [{result:results[Math.min(index++,results.length-1)]}];
    }},
  };
  return {api,calls,pause:async()=>{},maxAttempts:4};
}

test('temporary search tab is inactive, injects the DOM reader, waits for stability and closes only its own tab', async () => {
  const fake = fakeBrowser();
  assert.deepEqual(await searchInTab('naver','a',fake),[{seriesId:'1'}]);
  assert.equal(fake.calls.created[0].active,false);
  assert.equal(fake.calls.scripts.length,2);
  assert.equal(fake.calls.scripts[0].func,readSearchPage);
  assert.deepEqual(fake.calls.scripts[0].args,['naver']);
  assert.deepEqual(fake.calls.scripts[0].target,{tabId:17});
  assert.deepEqual(fake.calls.removed,[17]);
});

test('rendering can progress from shell to results without premature empty response', async () => {
  const fake = fakeBrowser({results:[{ready:false,items:[]},{ready:true,items:[{seriesId:'2'}]}]});
  assert.deepEqual(await searchInTab('kakao','a',fake),[{seriesId:'2'}]);
  assert.equal(fake.calls.scripts.length,3);
});

test('genuine empty result succeeds and closes its temporary tab', async () => {
  const fake = fakeBrowser({results:[{ready:true,items:[]}]});
  assert.deepEqual(await searchInTab('kakao','a',fake),[]);
  assert.deepEqual(fake.calls.removed,[17]);
});

test('timeout closes the temporary tab and reports an error, never zero results', async () => {
  const fake = fakeBrowser({results:[{ready:false,items:[]}]});
  await assert.rejects(searchInTab('kakao','a',fake),/did not finish loading/);
  assert.deepEqual(fake.calls.removed,[17]);
});

test('script permission failure stops immediately and still cleans up', async () => {
  const fake = fakeBrowser({scriptError:new Error('Missing scripting permission')});
  await assert.rejects(searchInTab('naver','a',fake),/permission/);
  assert.equal(fake.calls.scripts.length,1);
  assert.deepEqual(fake.calls.removed,[17]);
});

test('redirect or user navigation is not scraped and is not closed', async () => {
  const fake = fakeBrowser({redirect:'https://accounts.kakao.com/login'});
  await assert.rejects(searchInTab('kakao','a',fake),/left the results page/);
  assert.equal(fake.calls.scripts.length,0);
  assert.deepEqual(fake.calls.removed,[]);
});

test('invalid requests never create tabs', async () => {
  const fake = fakeBrowser();
  await assert.rejects(searchInTab('evil','a',fake),/Unsupported/);
  await assert.rejects(searchInTab('naver',' ',fake),/Type a title/);
  assert.equal(fake.calls.created.length,0);
});

test('URL comparison tolerates equivalent encoding but rejects changed query, category or origin', () => {
  const expected = buildSiteSearchUrl('kakao','나 a');
  assert.equal(sameSearchPage('https://page.kakao.com/search/result/?categoryUid=10&keyword=%eb%82%98+a',expected,'kakao'),true);
  assert.equal(sameSearchPage(expected.replace('categoryUid=10','categoryUid=11'),expected,'kakao'),false);
  assert.equal(sameSearchPage(expected.replace('keyword=','keyword=x'),expected,'kakao'),false);
  assert.equal(sameSearchPage(expected.replace('page.kakao.com','evil.test'),expected,'kakao'),false);
});
