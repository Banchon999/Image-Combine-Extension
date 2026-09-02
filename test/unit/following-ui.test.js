/** Controller smoke tests with a small DOM double, not a real-browser test. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {MSG,STATUS} from '../../src/common/messages.js';
import {DEFAULT_SETTINGS,LANGUAGES,OUTPUT_FORMATS} from '../../src/common/settings.js';
import {describeSelection,toRangeSpec} from '../../src/common/ranges.js';
import {buildSiteSearchUrl} from '../../src/common/site-search.js';
import {initialSelection,validateChapterSelection} from '../../src/common/chapter-access.js';
import {chapterIdentity,pendingChapters,FOLLOW_KEY} from '../../src/common/following.js';
import {createFollowingStore} from '../../src/background/following-store.js';
import {STITCH_DEFAULTS,stitchOptions,stitchCodecLimits} from '../../src/common/stitch-plan.js';

const html=await readFile(new URL('../../src/ui/app.html',import.meta.url),'utf8');
const source=(await readFile(new URL('../../src/ui/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const seriesData = numbers => ({adapterId:'kakao',ref:{seriesId:'62711843',lang:'ko'},series:{title:'Test',author:'A',cover:'',
  chapters:numbers.map(number=>({number,productId:String(70000000+number),title:`Episode ${number}`,isFree:number<101}))}});

async function setup() {
  const byId=new Map();
  class Node {
    constructor(tag='span') {this.tag=tag;this.children=[];this.attrs={};this.events={};this.style={};this.dataset={};this.value='';this.disabled=false;this.hidden=false;this.classList={toggle(){}};}
    get firstChild(){return this.children[0];}
    get textContent(){return this.ownText ?? this.children.map(c=>c.textContent).join('');}
    set textContent(value){this.ownText=String(value);this.children=[];}
    setAttribute(key,value){this.attrs[key]=String(value);if(key==='id'){this.id=String(value);byId.set(this.id,this);}if(key==='value')this.value=String(value);if(key==='class')this.className=String(value);if(key==='data-view')this.dataset.view=String(value);}
    append(...children){for(let c of children){if(typeof c==='string'){const text=new Node();text.textContent=c;c=text;}c.parentElement=this;this.children.push(c);}}
    remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);}}
    addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
    async click(){if(this.disabled)return;for(const fn of this.events.click??[])await fn({target:this});}
  }
  const document={body:new Node('body'),createElement:tag=>new Node(tag),getElementById:id=>byId.get(id),
    querySelectorAll:selector=>[...byId.values()].filter(n=>String(n.className??'').split(' ').includes(selector.slice(1)))};
  // IDs and tab/view attributes come from the shipped HTML, not hand-invented IDs.
  for(const match of html.matchAll(/<(\w+)\b([^>]*\bid="[^"]+"[^>]*)>/g)){
    const node=new Node(match[1]);
    for(const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g))node.setAttribute(attr[1],attr[2]);
    document.body.append(node);
  }
  byId.get('search-site').value='webtoons';
  let raw={};let next=0;
  const store=createFollowingStore({get:async key=>structuredClone({[key]:raw[key]}),set:async patch=>{raw={...raw,...structuredClone(patch)};}},{token:()=>String(++next)});
  const calls=[];
  const chrome={runtime:{onMessage:{addListener(){}},sendMessage:async({type,payload})=>{
    calls.push({type,payload});
    try {
      let result;
      if(type===MSG.GET_SETTINGS)result=DEFAULT_SETTINGS;
      else if(type===MSG.FOLLOW_LIST)result=await store.list();
      else if(type===MSG.FOLLOW_ADD)result=await store.add(payload);
      else if(type===MSG.FOLLOW_CHECK)result=await store.check(payload.id,async()=>seriesData([100,101]));
      else if(type===MSG.FOLLOW_HANDLED)result=await store.handled(payload.id,payload.ids);
      else if(type===MSG.GET_SERIES)result=seriesData([100,101]);
      else if(type===MSG.START_JOB)result={jobId:'j1'};
      else throw new Error(`Unexpected message ${type}`);
      return {ok:true,result};
    }catch(error){return {ok:false,error:error.message};}
  }},storage:{session:{get:async()=>({}),remove:async()=>{}},onChanged:{addListener(){}}}};
  const context={document,window:{matchMedia:()=>({matches:false,addEventListener(){}}),confirm:()=>true},chrome,
    MSG,STATUS,LANGUAGES,OUTPUT_FORMATS,describeSelection,toRangeSpec,buildSiteSearchUrl,STITCH_DEFAULTS,stitchOptions,stitchCodecLimits,
    initialSelection,validateChapterSelection,chapterIdentity,pendingChapters,FOLLOW_KEY,
    setTimeout,clearTimeout,URL,Blob};
  vm.createContext(context);
  vm.runInContext(source+'\nthis.testUI={renderSeries,refreshFollowing,state,showView};',context);
  await new Promise(resolve=>setImmediate(resolve));
  const button=(root,label)=>{
    const walk=node=>[node,...node.children.flatMap(walk)];
    const found=walk(root).find(node=>node.tag==='button'&&node.textContent===label);
    assert.ok(found,`missing button: ${label}`);return found;
  };
  return {ui:context.testUI,byId,store,calls,button};
}

test('Series Follow button records current chapters through the worker message',async()=>{
  const {ui,byId,store,button}=await setup();
  ui.renderSeries(seriesData([100]));
  await button(byId.get('series-body'),'ติดตามเรื่องนี้').click();
  const [entry]=await store.list();
  assert.equal(entry.known[0].number,100);
  assert.equal(pendingChapters(entry).length,0);
});

test('Following -> new chapters selects 101 only and never silently enables paid account mode',async()=>{
  const {ui,byId,store,button,calls}=await setup();
  const entry=await store.add(seriesData([100]));
  await ui.refreshFollowing();
  await button(byId.get('following-body'),'เลือกโหลดตอนใหม่').click();
  assert.equal(byId.get('range-input').value,'101');
  assert.equal(byId.get('account-access-toggle').checked,false);
  assert.equal(button(byId.get('series-body'),'Download').disabled,true);
  assert.equal(calls.some(c=>c.type===MSG.START_JOB),false);
  assert.equal(pendingChapters((await store.list())[0])[0].number,101);
  assert.equal((await store.list())[0].id,entry.id);
});

test('repeated check buttons keep pending chapter until the explicit handled action',async()=>{
  const {ui,byId,store,button}=await setup();
  await store.add(seriesData([100]));
  await ui.refreshFollowing();
  await button(byId.get('following-body'),'เช็กตอนใหม่').click();
  await button(byId.get('following-body'),'เช็กตอนใหม่').click();
  assert.equal(pendingChapters((await store.list())[0]).length,1);
  await button(byId.get('following-body'),'จัดการตอนที่แสดงแล้ว').click();
  assert.equal(pendingChapters((await store.list())[0]).length,0);
});

test('Following tab participates in mobile tab switching',async()=>{
  const {ui,byId}=await setup();
  ui.showView('following');
  assert.equal(byId.get('tab-following').attrs['aria-selected'],'true');
  assert.equal(byId.get('view-following').hidden,false);
  assert.equal(byId.get('view-search').hidden,true);
});

test('stitch UI exposes the fixed desktop dimensions',async()=>{
  const {ui,byId}=await setup();ui.renderSeries(seriesData([100]));
  assert.equal(byId.get('stitch-height').attrs.max,'32767');
  assert.equal(byId.get('stitch-width').attrs.max,'32767');
  assert.equal(byId.get('stitch-height').value,'18000');
  const mime=byId.get('stitch-mime');mime.value='image/webp';
  for(const fn of mime.events.change??[])await fn({target:mime});
  assert.equal(byId.get('stitch-height').attrs.max,'16383');
  assert.equal(byId.get('stitch-width').attrs.max,'16383');
});
