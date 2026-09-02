import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFollowingStore} from '../../src/background/following-store.js';
import {FOLLOW_KEY,followId,cleanRef,createFollowEntry,updateFollowEntry,pendingChapters,
  chapterSnapshot,markHandled,parseFollowBackup} from '../../src/common/following.js';

const chapters = numbers => numbers.map(number=>({number,title:`Episode ${number}`,productId:String(70000000+number)}));
const data = (numbers=[99,100],adapterId='naver',seriesId='828715') => ({adapterId,
  ref:{seriesId,lang:adapterId==='webtoons'?'en':'ko',genre:'fantasy',slug:'test',episodeNo:100},
  series:{title:'Test Series',author:'Writer',cover:'https://image-comic.pstatic.net/cover.jpg',chapters:chapters(numbers)}});
function fixture() {
  let stored={settings:{format:'cbz'}};
  let fail=false;
  const storage={get:async key=>structuredClone({[key]:stored[key]}),set:async patch=>{
    if (fail) throw new Error('Quota exceeded');
    stored={...stored,...structuredClone(patch)};
  }};
  let counter=0;
  const store=createFollowingStore(storage,{now:()=>++counter,token:()=>`token-${++counter}`});
  return {store,storage,raw:()=>structuredClone(stored),fail:value=>{fail=value;}};
}
const ids = entry=>pendingChapters(entry).map(c=>c.id);

test('initial follow establishes a baseline without pretending old chapters were downloaded',()=>{
  const entry=createFollowEntry(data(),1000,'a');
  assert.deepEqual(ids(entry),[]);
  assert.deepEqual(entry.handledIds,['99','100']);
  assert.equal(entry.ref.episodeNo,undefined);
  assert.equal('downloadedIds' in entry,false);
});

test('100 -> 101 yields one pending chapter and repeated checks never clear it',()=>{
  let entry=createFollowEntry(data(),1,'a');
  entry=updateFollowEntry(entry,data([99,100,101]).series,2);
  assert.deepEqual(ids(entry),['101']);
  entry=updateFollowEntry(entry,data([99,100,101]).series,3);
  assert.deepEqual(ids(entry),['101']);
  assert.deepEqual(entry.handledIds,['99','100']);
});

test('acknowledging shown IDs cannot hide a newer chapter that arrived afterwards',()=>{
  let entry=createFollowEntry(data(),1,'a');
  entry=updateFollowEntry(entry,data([99,100,101]).series,2);
  const shown=ids(entry);
  entry=updateFollowEntry(entry,data([99,100,101,102]).series,3);
  entry=markHandled(entry,shown);
  assert.deepEqual(ids(entry),['102']);
});

test('inserted older-numbered chapters are detected without a max-number heuristic',()=>{
  const entry=updateFollowEntry(createFollowEntry(data(),1,'a'),data([98,99,100]).series,2);
  assert.deepEqual(ids(entry),['98']);
});

test('Kakao identity uses product IDs even when cursor/display numbers move',()=>{
  let entry=createFollowEntry(data([100],'kakao'),1,'a');
  entry=updateFollowEntry(entry,{title:'Changed',chapters:[
    {number:101,productId:'70000100',title:'Existing moved'},
    {number:100,productId:'99999999',title:'New inserted'},
  ]},2);
  assert.deepEqual(ids(entry),['99999999']);
  assert.equal(entry.known.find(c=>c.id==='70000100').number,101);
});

test('temporarily missing chapters retain pending status and returning chapters do not duplicate',()=>{
  let entry=createFollowEntry(data(),1,'a');
  entry=updateFollowEntry(entry,data([99,100,101]).series,2);
  entry=updateFollowEntry(entry,data([99,100]).series,3);
  assert.deepEqual(ids(entry),['101']);
  assert.ok(!entry.availableIds.includes('101'));
  entry=updateFollowEntry(entry,data([99,100,101]).series,4);
  assert.deepEqual(ids(entry),['101']);
});

test('series keys ignore viewer IDs/slugs but isolate site, language and NAVER section',()=>{
  assert.equal(followId('naver',data().ref),followId('naver',{seriesId:'828715',lang:'ko'}));
  assert.notEqual(followId('naver',data().ref),followId('kakao',data().ref));
  assert.notEqual(followId('naver',data().ref),followId('naver',{...data().ref,section:'challenge'}));
  assert.notEqual(followId('webtoons',data([1],'webtoons').ref),followId('webtoons',{...data([1],'webtoons').ref,lang:'th'}));
});

test('references reject unsupported adapters and unsafe path segments',()=>{
  assert.throws(()=>cleanRef('evil',data().ref));
  assert.throws(()=>cleanRef('naver',{seriesId:'bad'}));
  assert.throws(()=>cleanRef('naver',{seriesId:'1',section:'../../admin'}));
  for (const slug of ['../evil','x?token=a','..','x\\y']) {
    assert.throws(()=>cleanRef('webtoons',{...data([1],'webtoons').ref,slug}));
  }
});

test('empty/malformed lists are rejected rather than destroying history',()=>{
  assert.throws(()=>chapterSnapshot('naver',[]));
  assert.throws(()=>chapterSnapshot('naver',[{number:NaN}]));
  assert.throws(()=>chapterSnapshot('kakao',[{number:1}]));
  assert.equal(chapterSnapshot('naver',chapters([1,1,2])).length,2);
});

test('following is persisted across store restart and leaves settings untouched',async()=>{
  const {store,storage,raw}=fixture();
  const saved=await store.add(data());
  const restarted=createFollowingStore(storage);
  assert.deepEqual(await restarted.list(),[saved]);
  assert.deepEqual(raw().settings,{format:'cbz'});
});

test('adding same series again does not reset pending chapters',async()=>{
  const {store}=fixture();
  const saved=await store.add(data());
  await store.check(saved.id,async()=>data([99,100,101]));
  const again=await store.add(data([99,100,101]));
  assert.deepEqual(ids(again),['101']);
  assert.equal((await store.list()).length,1);
});

test('concurrent adds and checks for different series do not lose writes',async()=>{
  const {store}=fixture();
  const entries=await Promise.all([store.add(data()),store.add(data([1],'kakao','62711843'))]);
  await Promise.all(entries.map(entry=>store.check(entry.id,async()=>data([1,2,101],entry.adapterId,entry.ref.seriesId))));
  assert.equal((await store.list()).length,2);
  assert.ok((await store.list()).every(entry=>ids(entry).length));
});

test('failed check stores an error but keeps baseline, pending and last successful timestamp',async()=>{
  const {store}=fixture();
  const saved=await store.add(data());
  const {entry:good}=await store.check(saved.id,async()=>data([99,100,101]));
  await assert.rejects(store.check(saved.id,async()=>{throw new Error('HTTP 403');}),/403/);
  const [entry]=await store.list();
  assert.deepEqual(ids(entry),['101']);
  assert.equal(entry.lastCheckedAt,good.lastCheckedAt);
  assert.equal(entry.lastError,'HTTP 403');
});

test('invalid/empty successful response is treated as an error without erasing prior data',async()=>{
  const {store}=fixture();
  const saved=await store.add(data());
  await assert.rejects(store.check(saved.id,async()=>data([])),/empty/);
  const [entry]=await store.list();
  assert.equal(entry.known.length,2);
  assert.match(entry.lastError,/empty/);
});

test('acknowledging during an in-flight check is preserved when new result commits',async()=>{
  const {store}=fixture();
  const saved=await store.add(data());
  await store.check(saved.id,async()=>data([99,100,101]));
  let finish, started;
  const begun=new Promise(resolve=>{started=resolve;});
  const check=store.check(saved.id,()=>{started();return new Promise(resolve=>{finish=resolve;});});
  await begun;
  await store.handled(saved.id,['101']);
  finish(data([99,100,101,102]));
  await check;
  assert.deepEqual(ids((await store.list())[0]),['102']);
});

test('remove/re-add during a check cannot resurrect stale results into the replacement entry',async()=>{
  const {store}=fixture();
  const saved=await store.add(data());
  let finish, started;
  const begun=new Promise(resolve=>{started=resolve;});
  const check=store.check(saved.id,()=>{started();return new Promise(resolve=>{finish=resolve;});});
  await begun;
  await store.remove(saved.id);
  await store.add(data());
  finish(data([99,100,101]));
  await assert.rejects(check,/changed while checking/);
  assert.deepEqual(ids((await store.list())[0]),[]);
});

test('storage failure leaves old data intact and does not poison subsequent operations',async()=>{
  const fixture_=fixture();
  await fixture_.store.add(data());
  fixture_.fail(true);
  await assert.rejects(fixture_.store.add(data([1],'kakao','2')),/Quota/);
  fixture_.fail(false);
  assert.equal((await fixture_.store.list()).length,1);
  await fixture_.store.add(data([1],'kakao','2'));
  assert.equal((await fixture_.store.list()).length,2);
});

test('backup roundtrip preserves pending chapters but does not persist generation tokens',async()=>{
  const {store}=fixture();
  const saved=await store.add(data());
  await store.check(saved.id,async()=>data([99,100,101]));
  const backup=JSON.parse(JSON.stringify(await store.export()));
  assert.equal(backup.items[0].token,undefined);
  const other=fixture();
  assert.deepEqual(await other.store.import(backup),{added:1,skipped:0});
  assert.deepEqual(ids((await other.store.list())[0]),['101']);
});

test('import merges missing series and never overwrites existing progress',async()=>{
  const {store}=fixture();
  const saved=await store.add(data());
  const old=await store.export();
  await store.check(saved.id,async()=>data([99,100,101]));
  assert.deepEqual(await store.import(old),{added:0,skipped:1});
  assert.deepEqual(ids((await store.list())[0]),['101']);
});

test('invalid backup is rejected atomically, before inserting valid preceding entries',async()=>{
  const {store}=fixture();
  const good=createFollowEntry(data(),1,'x');
  await assert.rejects(store.import({version:1,items:[good,{...good,adapterId:'evil'}]}));
  assert.equal((await store.list()).length,0);
  assert.throws(()=>parseFollowBackup({version:2,items:[]}));
  assert.throws(()=>parseFollowBackup({version:1,items:[{...good,handledIds:['999']}]}));
});

test('backup sanitizes unknown fields, untrusted covers and never imports account access settings',()=>{
  const good=createFollowEntry(data(),1,'x');
  const [parsed]=parseFollowBackup({version:1,items:[{...good,cover:'https://evil.test/tracker',kakaoAccountAccess:true,
    ref:{...good.ref,episodeNo:123,password:'secret'}}]});
  assert.equal(parsed.cover,'');
  assert.equal(parsed.kakaoAccountAccess,undefined);
  assert.equal(parsed.ref.password,undefined);
  assert.equal(parsed.ref.episodeNo,undefined);
});

test('removing a followed series deletes only its tracking entry',async()=>{
  const {store,raw}=fixture();
  const a=await store.add(data());
  const b=await store.add(data([1],'kakao','2'));
  await store.remove(a.id);
  assert.deepEqual((await store.list()).map(e=>e.id),[b.id]);
  assert.deepEqual(raw().settings,{format:'cbz'});
  assert.equal(raw()[FOLLOW_KEY].version,1);
});

test('simultaneous checks of one series share a fetch instead of racing stale snapshots',async()=>{
  const {store}=fixture();
  const saved=await store.add(data());
  let calls=0;
  const load=async()=>{calls++;return data([99,100,101]);};
  const [first,second]=await Promise.all([store.check(saved.id,load),store.check(saved.id,load)]);
  assert.equal(calls,1);
  assert.deepEqual(first,second);
  assert.deepEqual(ids(first.entry),['101']);
});
