import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kakaoAdapter } from '../../src/adapters/kakao.js';
import { normalizeSettings } from '../../src/common/settings.js';
import { initialSelection, validateChapterSelection } from '../../src/common/chapter-access.js';
import { detectImageMime } from '../../src/common/image-types.js';
import { FetchError, ProtectedContentError } from '../../src/common/errors.js';
import { createEngine } from '../../src/offscreen/engine.js';
import { STATUS } from '../../src/common/messages.js';

const ref = {seriesId:'62711843',episodeNo:70440946,lang:'ko'};
const paid = {number:146,productId:'70440946',title:'146화',isFree:false};
const free = {number:1,productId:'101',title:'1화',isFree:true};
const viewer = {viewer_data:{type:'ImageViewerData',imageDownloadData:{files:[
  {no:1,secureUrl:'https://cdn.example/page.jpg'},
]}}};

test('account access requires literal true; default and truthy strings do not opt in', async () => {
  for (const flag of [undefined,false,'true','false',1]) {
    assert.equal(normalizeSettings({kakaoAccountAccess:flag}).kakaoAccountAccess,false);
    await assert.rejects(kakaoAdapter.getChapterImages(ref,paid,{
      fetchJson:async()=>assert.fail('must not call the viewer'),
    },{kakaoAccountAccess:flag}),ProtectedContentError);
  }
  assert.equal(normalizeSettings({kakaoAccountAccess:true}).kakaoAccountAccess,true);
});

test('explicit account mode requests exactly the selected viewer and requires plain image bytes', async () => {
  const calls=[];
  const images=await kakaoAdapter.getChapterImages(ref,paid,{fetchJson:async url=>{calls.push(url);return viewer;}},{kakaoAccountAccess:true});
  assert.deepEqual(calls,['https://bff-page.kakao.com/api/gateway/api/v1/viewer/data?series_id=62711843&product_id=70440946']);
  assert.equal(images.length,1);
  assert.equal(images[0].requirePlainImage,true);
  assert.equal(paid.isFree,false,'account mode must not relabel a paid chapter as free');
});

test('account mode accepts the supported nested viewer response', async () => {
  const images=await kakaoAdapter.getChapterImages(ref,paid,{fetchJson:async()=>({result:viewer})},{kakaoAccountAccess:true});
  assert.equal(images.length,1);
});

test('HTTP 401 and 403 stop after one viewer request without ticket/purchase attempts', async () => {
  for (const status of [401,403]) {
    let calls=0;
    await assert.rejects(kakaoAdapter.getChapterImages(ref,paid,{fetchJson:async()=>{
      calls++;throw new FetchError('denied',{status});
    }},{kakaoAccountAccess:true}),error=>error.status===status && /session\/API may differ/.test(error.message));
    assert.equal(calls,1);
  }
});

test('missing viewer data and unknown viewer types never manufacture image URLs', async () => {
  for (const response of [{},{result:{}},{viewer_data:{type:'UnknownProtectedViewer'}}]) {
    await assert.rejects(kakaoAdapter.getChapterImages(ref,paid,{fetchJson:async()=>response},{kakaoAccountAccess:true}),FetchError);
  }
});

test('network failures retain their original diagnostics', async () => {
  const failure=new Error('network offline');
  await assert.rejects(kakaoAdapter.getChapterImages(ref,paid,{fetchJson:async()=>{throw failure;}},{kakaoAccountAccess:true}),error=>error===failure);
});

test('pasted Kakao viewer product ID selects its cursor number, not all free episodes', () => {
  assert.equal(initialSelection([free,paid],ref,'kakao'),'146');
  assert.equal(initialSelection([free,{...paid,number:149}],ref,'kakao'),'149');
});

test('an absent pasted episode never falls back to all or free episodes', () => {
  assert.equal(initialSelection([free],ref,'kakao'),'');
  assert.throws(()=>validateChapterSelection([free],'',true),/Enter the chapter/);
});

test('series links keep the default free-only selection and do not auto-select paid chapters', () => {
  assert.equal(initialSelection([free,paid],{},'kakao'),'1');
  assert.equal(initialSelection([paid],{},'kakao'),'');
  assert.equal(initialSelection([free],{},'kakao'),'all');
});

test('NAVER and WEBTOON episode URLs select their own episode numbers', () => {
  for (const adapter of ['naver','webtoons']) {
    assert.equal(initialSelection([{number:1},{number:146}],{episodeNo:146},adapter),'146');
  }
});

test('paid selections require explicit account mode and invalid ranges remain disabled', () => {
  assert.throws(()=>validateChapterSelection([free,paid],'146',false),/non-free/);
  assert.deepEqual(validateChapterSelection([free,paid],'146',true),{chosen:[146],nonFreeCount:1});
  assert.throws(()=>validateChapterSelection([free,paid],'999',true));
  assert.throws(()=>validateChapterSelection([free,paid],'all',false),/non-free/);
  assert.deepEqual(validateChapterSelection([free,paid],'1',false),{chosen:[1],nonFreeCount:0});
});

test('plain-image detection identifies supported signatures and rejects HTML/unknown bytes', () => {
  const bytes=text=>new TextEncoder().encode(text);
  assert.equal(detectImageMime(new Uint8Array([255,216,255])),'image/jpeg');
  assert.equal(detectImageMime(new Uint8Array([137,80,78,71])),'image/png');
  assert.equal(detectImageMime(bytes('GIF89a')),'image/gif');
  assert.equal(detectImageMime(bytes('RIFF0000WEBP')),'image/webp');
  assert.equal(detectImageMime(bytes('0000ftypavif')),'image/avif');
  for (const data of [bytes('<html>login required</html>'),bytes('unrecognized encoded data'),new Uint8Array()]) {
    assert.equal(detectImageMime(data),'');
  }
});

test('real adapter + engine: opt-in reaches viewer, propagates image validation, and writes selected chapter only', async () => {
  const calls=[];const saved=[];
  const engine=createEngine({
    getAdapter:()=>kakaoAdapter,
    fetchJson:async url=>{
      calls.push(url);
      if (url.includes('/product/list?')) return {result:{list:[
        {cursor_index:146,item:{product_id:'70440946',title:'146화',is_free:false}},
      ],has_next:false,series_item:{title:'Test Series'}}};
      return viewer;
    },
    fetchImage:async (_url,_signal,options)=>{
      assert.equal(options.requirePlainImage,true);
      return {data:new Uint8Array([255,216,255,217]),mimeType:'image/jpeg'};
    },
    saveBlob:async (blob,name)=>{saved.push({blob,name});return 1;},
    removeFiles:async()=>{},
  });
  const job=await engine.runJob({jobId:'account-test',adapterId:'kakao',ref,selection:'146',
    settings:{format:'cbz',throttleMs:0,kakaoAccountAccess:true}});
  assert.equal(job.status,STATUS.DONE);
  assert.equal(job.chapters[0].number,146);
  assert.equal(saved.length,1);
  assert.ok(saved[0].name.endsWith('.cbz'));
  assert.equal(calls.filter(url=>url.includes('/viewer/data?')).length,1);
  assert.ok(calls.every(url=>/\/product\/list\?|\/viewer\/data\?/.test(url)));
});

test('engine default never requests a paid viewer or saves an archive', async () => {
  const engine=createEngine({getAdapter:()=>kakaoAdapter,
    fetchJson:async url=>{
      assert.ok(url.includes('/product/list?'));
      return {result:{list:[{cursor_index:146,item:{product_id:'70440946',title:'146화',is_free:false}}],has_next:false}};
    },fetchImage:async()=>assert.fail('no image request'),saveBlob:async()=>assert.fail('no archive'),removeFiles:async()=>{},
  });
  const job=await engine.runJob({jobId:'default-test',adapterId:'kakao',ref,selection:'146',settings:{throttleMs:0}});
  assert.equal(job.chapters[0].status,STATUS.SKIPPED_PROTECTED);
});
