// Optional real raster/codec tests; no browser and no extension runtime dependency.
// npm install --no-save @napi-rs/canvas, or use CODEX_PRIMARY_RUNTIME_NODE_MODULES.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {stitchPages} from '../../src/offscreen/convert/stitch.js';
import {buildCbz} from '../../src/offscreen/convert/cbz.js';
import {buildPdf} from '../../src/offscreen/convert/pdf.js';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/stitch-check.cjs`:import.meta.url);
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const io={
  decode:async page=>{const image=await loadImage(Buffer.from(page.data));image.close=()=>{};return image;},
  makeCanvas:(w,h)=>{const canvas=createCanvas(w,h);canvas.convertToBlob=async({type,quality})=>new Blob([await canvas.encode(type.split('/')[1],Math.round(quality*100))],{type});return canvas;},
};
const collect=async stream=>{const out=[];for await(const page of stream)out.push(page);return out;};
async function source(w,h,paint){const c=createCanvas(w,h);paint(c.getContext('2d'));return {mimeType:'image/png',data:await c.encode('png')};}
const colors=['#ff0000','#00ff00','#0000ff'];
const inputs=await Promise.all([30,40,50].map((h,i)=>source(32,h,ctx=>{ctx.fillStyle=colors[i];ctx.fillRect(0,0,32,h);})));
for(const mime of ['image/png','image/jpeg','image/webp']){
  const pages=await collect(stitchPages(inputs,{stitchMode:'height',stitchHeight:45,stitchMime:mime},null,undefined,io));
  assert.deepEqual(pages.map(p=>p.height),[45,45,30]);
  let offset=0;
  for(const p of pages){
    const decoded=await io.decode(p);assert.equal(decoded.width,32);assert.equal(decoded.height,p.height);
    const c=createCanvas(32,p.height);const ctx=c.getContext('2d');ctx.drawImage(decoded,0,0);
    if(mime==='image/png')for(let y=0;y<p.height;y++){
      const row=offset+y,expected=row<30?[255,0,0,255]:row<70?[0,255,0,255]:[0,0,255,255];
      assert.deepEqual([...ctx.getImageData(16,y,1,1).data],expected,`pixel row ${row}`);
    }
    offset+=p.height;
  }
  const archive=buildCbz(pages.map((p,i)=>({name:`${i+1}.${mime.split('/')[1]}`,data:p.data})),{format:'zip'});
  assert.ok(archive.size>pages.reduce((sum,p)=>sum+p.data.length,0));
  if(mime==='image/jpeg')assert.ok(buildPdf(pages,{}).size>0);
  console.log(`PASS ${mime}: real encode/decode, dimensions, archive${mime==='image/png'?', all 120 rows exact':''}`);
}
const exact=await collect(stitchPages(inputs,{stitchMode:'count',stitchCount:7,stitchHeight:25,stitchMime:'image/png'},null,undefined,io));
assert.deepEqual(exact.map(p=>p.height),[18,17,17,17,17,17,17]);
const tall=await source(720,9000,ctx=>{ctx.fillStyle='orange';ctx.fillRect(0,0,720,9000);});
assert.deepEqual((await collect(stitchPages([tall],{},null,undefined,io))).map(p=>p.height),[9000]);
for(const mime of ['image/png','image/jpeg']){
  for(const [w,h] of [[720,18000],[18000,32],[32,32767],[32767,32]]){
    const input=await source(w,h,ctx=>{ctx.fillStyle='orange';ctx.fillRect(0,0,w,h);});
    const [part]=await collect(stitchPages([input],{stitchMode:'height',stitchHeight:h,stitchMime:mime},null,undefined,io));
    const decoded=await io.decode(part);assert.equal(decoded.width,w);assert.equal(decoded.height,h);
  }
  console.log(`PASS ${mime}: desktop 18000 and 32767 px, both axes encode/decode`);
}
const webpTall=await source(32,18000,ctx=>{ctx.fillStyle='orange';ctx.fillRect(0,0,32,18000);});
const webpParts=await collect(stitchPages([webpTall],{stitchMime:'image/webp'},null,undefined,io));
assert.deepEqual(webpParts.map(p=>p.height),[16383,1617]);
for(const p of webpParts)assert.equal((await io.decode(p)).height,p.height);
// A transparent source must flatten to white, not black, in every output codec.
const transparent=await source(10,10,()=>{});
for(const mime of ['image/png','image/jpeg','image/webp']){
  const [p]=await collect(stitchPages([transparent],{stitchMime:mime},null,undefined,io));
  const c=createCanvas(10,10),ctx=c.getContext('2d');ctx.drawImage(await io.decode(p),0,0);
  assert.deepEqual([...ctx.getImageData(5,5,1,1).data],[255,255,255,255]);
}
console.log('PASS exact count, 720×9000 Smart, transparent background; native raster tests complete (not Quetta E2E)');
