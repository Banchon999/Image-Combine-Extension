import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STITCH_LIMITS,stitchOptions,planStitch,partSlices} from '../../src/common/stitch-plan.js';
import {stitchPages} from '../../src/offscreen/convert/stitch.js';
import {normalizeSettings} from '../../src/common/settings.js';

const dims=[{width:32,height:30},{width:32,height:40},{width:32,height:50}];
const opts=patch=>stitchOptions({stitchMode:'height',stitchHeight:45,...patch});
const collect=async stream=>{const out=[];for await(const p of stream)out.push(p);return out;};

test('stitch is opt-in and limits chapter concurrency when enabled',()=>{
  assert.equal(normalizeSettings({}).stitchEnabled,false);
  assert.equal(normalizeSettings({stitchEnabled:true,concurrentChapters:4}).concurrentChapters,1);
  assert.equal(normalizeSettings({stitchEnabled:'true'}).stitchEnabled,false);
});
test('stitch option validation rejects unsupported types and invalid numbers',()=>{
  for(const patch of [{stitchMode:'wat'},{stitchMime:'image/tiff'},{stitchWidth:32768},{stitchQuality:0},{stitchQuality:NaN},{stitchMode:'height',stitchHeight:0},{stitchMode:'count',stitchCount:1.5}])assert.throws(()=>stitchOptions(patch));
  assert.equal(stitchOptions({format:'pdf',stitchMime:'image/webp'}).mime,'image/jpeg');
});
test('height splitting preserves the short last part and all source rows',()=>{
  const p=planStitch(dims,opts());
  assert.deepEqual(p.parts,[{top:0,height:45},{top:45,height:45},{top:90,height:30}]);
  assert.equal(p.totalHeight,120);
  for(const part of p.parts){
    const slices=partSlices(p,part);
    assert.equal(slices.reduce((n,s)=>n+s.dh,0),part.height);
    let end=0;for(const s of slices){assert.equal(s.dy,end);end+=s.dh;}
  }
});
test('count mode balances an exact number within the height cap',()=>{
  const p=planStitch(dims,opts({stitchMode:'count',stitchCount:7,stitchHeight:25}));
  assert.deepEqual(p.parts.map(x=>x.height),[18,17,17,17,17,17,17]);
  assert.throws(()=>planStitch(dims,opts({stitchMode:'count',stitchCount:4,stitchHeight:25})),/at least 5/);
  assert.throws(()=>planStitch(dims,opts({stitchMode:'count',stitchCount:121,stitchHeight:25})),/pixel rows/);
});
test('Smart respects the output pixel budget for wide pages',()=>{
  const p=planStitch([{width:20000,height:40000}],stitchOptions());
  assert.ok(p.parts.every(part=>part.height*p.width<=STITCH_LIMITS.maxPixels));
  assert.equal(p.parts.reduce((n,x)=>n+x.height,0),40000);
  assert.throws(()=>planStitch([{width:20000,height:40000}],opts({stitchHeight:18000})),/maximum height/);
});
test('desktop limits accept 18000 and 32767 without the old mobile area cap',()=>{
  for(const height of [15000,18000,32767]){
    const p=planStitch([{width:1440,height:height*2}],opts({stitchHeight:height}));
    assert.deepEqual(p.parts.map(x=>x.height),[height,height]);
  }
  const wide=planStitch([{width:18000,height:1000}],opts({stitchWidth:18000,stitchHeight:1000}));
  assert.equal(wide.width,18000);
  assert.equal(planStitch([{width:32767,height:1}],stitchOptions()).width,32767);
  assert.throws(()=>stitchOptions({stitchMode:'height',stitchHeight:32768}));
});
test('WebP codec dimensions apply to manual, Smart, auto width, and PDF override',()=>{
  assert.throws(()=>opts({stitchMime:'image/webp',stitchHeight:18000}),/16383/);
  assert.throws(()=>opts({stitchMime:'image/webp',stitchWidth:18000}),/16383/);
  const webp=stitchOptions({stitchMime:'image/webp'});
  assert.deepEqual(planStitch([{width:720,height:18000}],webp).parts.map(x=>x.height),[16383,1617]);
  assert.throws(()=>planStitch([{width:18000,height:10}],webp),/16383/);
  assert.equal(opts({format:'pdf',stitchMime:'image/webp',stitchHeight:18000}).height,18000);
});
test('auto width picks narrowest input and manual width preserves proportions',()=>{
  const d=[{width:100,height:101},{width:50,height:51}];
  const p=planStitch(d,opts());
  assert.equal(p.width,50);assert.equal(p.totalHeight,102);assert.equal(p.resized,true);
  assert.equal(planStitch(d,opts({stitchWidth:100})).totalHeight,203);
  const spans=p.parts.flatMap(part=>partSlices(p,part)).filter(s=>s.sourceIndex===0);
  assert.ok(Math.abs(spans.reduce((n,s)=>n+s.sh,0)-101)<1e-9);
});
test('planner rejects invalid dimensions and excessive output counts',()=>{
  assert.throws(()=>planStitch([],opts()),/No images/);
  assert.throws(()=>planStitch([{width:0,height:2}],opts()),/dimensions/);
  assert.throws(()=>planStitch([{width:32768,height:2}],opts()),/Width/);
  assert.throws(()=>planStitch([{width:1,height:3000}],opts({stitchHeight:1})),/Too many/);
});

function fakeIo({mime='image/png',fail=false,onDecode}={}){
  const state={opened:0,closed:0,canvases:[],draws:[]};
  return {state,io:{
    decode:async page=>{state.opened++;onDecode?.();return {...page,close(){state.closed++;}};},
    makeCanvas:(width,height)=>{
      const canvas={width,height,getContext:()=>({fillRect(){},drawImage(...args){state.draws.push(args);}}),
        convertToBlob:async()=>{if(fail)throw new Error('encoder failed');return new Blob(['bytes'],{type:mime});}};
      state.canvases.push(canvas);return canvas;
    },
  }};
}
test('renderer emits sequential parts and releases canvases and bitmaps',async()=>{
  const {io,state}=fakeIo();const progress=[];
  const pages=await collect(stitchPages(dims,{stitchMode:'height',stitchHeight:45,stitchMime:'image/png'},null,n=>progress.push(n),io));
  assert.deepEqual(pages.map(p=>[p.index,p.width,p.height,p.mimeType]),[[1,32,45,'image/png'],[2,32,45,'image/png'],[3,32,30,'image/png']]);
  assert.equal(state.opened,state.closed);assert.equal(state.opened,6);
  assert.ok(state.canvases.every(c=>c.width===1&&c.height===1));
  assert.equal(progress.length,6);
});
test('renderer rejects silent encoder MIME fallback and cleans resources',async()=>{
  const {io,state}=fakeIo();
  await assert.rejects(collect(stitchPages(dims,{stitchMime:'image/webp'},null,undefined,io)),/cannot encode image\/webp/);
  assert.equal(state.opened,state.closed);assert.equal(state.canvases[0].width,1);
});
test('renderer reports encode errors and early consumer exit releases resources',async()=>{
  const failed=fakeIo({fail:true});
  await assert.rejects(collect(stitchPages(dims,{},null,undefined,failed.io)),/part 1\/1 failed/);
  assert.equal(failed.state.opened,failed.state.closed);
  const {io,state}=fakeIo();
  for await(const part of stitchPages(dims,{stitchMode:'height',stitchHeight:45,stitchMime:'image/png'},null,undefined,io)){assert.equal(part.index,1);break;}
  assert.equal(state.opened,state.closed);assert.equal(state.canvases[0].height,1);
});
test('cancellation during measurement closes the decoded bitmap',async()=>{
  const c=new AbortController();const {io,state}=fakeIo({onDecode:()=>c.abort()});
  await assert.rejects(collect(stitchPages(dims,{},c.signal,undefined,io)),/cancel/i);
  assert.equal(state.opened,1);assert.equal(state.closed,1);assert.equal(state.canvases.length,0);
});
