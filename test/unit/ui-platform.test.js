import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {localizeDocument} from '../../src/ui/i18n.js';
import {initTabs,syncTabs} from '../../src/ui/tabs.js';

test('English and Thai locale catalogs expose the same application keys', async () => {
  const load = async lang => JSON.parse(await readFile(new URL(`../../_locales/${lang}/messages.json`, import.meta.url)));
  const [en,th]=await Promise.all([load('en'),load('th')]);
  assert.deepEqual(Object.keys(th).sort(),Object.keys(en).sort());
  for(const catalog of [en,th]) for(const [key,value] of Object.entries(catalog)) {
    assert.ok(value.message.trim(),`${key} must not be empty`);
  }
});

test('shipped tab markup has relationships and a single keyboard stop', async () => {
  const html=await readFile(new URL('../../src/ui/app.html',import.meta.url),'utf8');
  const tabs=[...html.matchAll(/<button class="tab"[^>]+>/g)].map(match=>match[0]);
  assert.equal(tabs.length,4);
  assert.equal(tabs.filter(tab=>tab.includes('tabindex="0"')).length,1);
  assert.ok(tabs.every(tab=>/aria-controls="view-[^"]+"/.test(tab)));
});

test('localization updates document language and marked text', () => {
  const oldChrome=globalThis.chrome;
  globalThis.chrome={i18n:{getUILanguage:()=> 'th-TH',getMessage:key=>key==='tabSearch'?'ค้นหา':''}};
  const node={dataset:{i18n:'tabSearch'},textContent:'Search'};
  const root={title:'Webtoon Downloader',documentElement:{setAttribute(key,value){this[key]=value;}},querySelectorAll(selector){return selector==='[data-i18n]'?[node]:[];}};
  localizeDocument(root);
  assert.equal(root.documentElement.lang,'th');
  assert.equal(node.textContent,'ค้นหา');
  globalThis.chrome=oldChrome;
});

test('tab controller supports arrow navigation and synchronizes ARIA state', () => {
  const make=view=>({dataset:{view},hidden:false,attrs:{},events:{},setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,v){this.events[k]=v;},focus(){this.focused=true;}});
  const tabs=['search','following','series'].map(make);
  const root={querySelectorAll:()=>tabs};let active='search';
  initTabs({root,activate:value=>{active=value;}});
  tabs[0].events.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(active,'following');assert.equal(tabs[1].focused,true);
  syncTabs(root,active,false);
  assert.equal(tabs[1].attrs['aria-selected'],'true');
  assert.equal(tabs[1].attrs.tabindex,'0');
  assert.equal(tabs[0].attrs.tabindex,'-1');
});
