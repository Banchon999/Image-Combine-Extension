/**
 * App page controller.
 *
 * Everything it renders (series titles, author names, chapter titles) comes
 * from scraped third-party pages, so all text goes in through textContent and
 * all attributes through setAttribute. There is no innerHTML with interpolated
 * data anywhere in this file, and it should stay that way -- a series title is
 * attacker-controlled input as far as this page is concerned.
 */

import { MSG, STATUS } from '../common/messages.js';
import { LANGUAGES, OUTPUT_FORMATS, UI_LANGUAGES } from '../common/settings.js';
import { describeSelection, toRangeSpec } from '../common/ranges.js';
import { buildSiteSearchUrl } from '../common/site-search.js';
import { initialSelection, validateChapterSelection } from '../common/chapter-access.js';
import { chapterIdentity, pendingChapters, FOLLOW_KEY } from '../common/following.js';
import { STITCH_DEFAULTS, stitchOptions, stitchCodecLimits } from '../common/stitch-plan.js';
import { applyUiLanguage, t } from './i18n.js';
import { initTabs, syncTabs } from './tabs.js';

const $ = (id) => document.getElementById(id);

/** Panel state. `current` is the series being viewed; `jobs` mirrors the engine. */
const state = {
  settings: null,
  current: null,
  jobs: new Map(),
  followed: [],
};

/* ------------------------------- messaging -------------------------------- */

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response) throw new Error('The extension worker did not respond.');
  if (!response.ok) {
    const error = new Error(response.error || 'Something went wrong.');
    error.protectedContent = Boolean(response.protected);
    throw error;
  }
  return response.result;
}

/* --------------------------------- helpers -------------------------------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('Refusing to set innerHTML from data');
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

function notice(container, message, kind = '') {
  clear(container).append(el('div', { class: `notice ${kind}`.trim(), text: message }));
}

/**
 * Thumbnails come from the same CDN that requires a Referer, so a bare <img>
 * in the panel would 403. The declarativeNetRequest rule covers extension
 * requests, so they load; if one still fails, hide it rather than show a broken
 * image icon.
 */
function thumb(src, alt) {
  const img = el('img', { src: src || '', alt: alt || '', loading: 'lazy' });
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  return img;
}

/**
 * On a wide window the queue is pinned to its own column and always visible, so
 * you can watch a download progress while browsing for the next series. Below
 * that width there is no room for two columns and it becomes a tab like the
 * others.
 */
const WIDE = window.matchMedia('(min-width: 900px)');

/** The view the tabs are currently pointing at, remembered across re-layouts. */
let activeView = 'search';

function applyLayout() {
  const pinnedQueue = WIDE.matches;
  document.body.classList.toggle('two-column', pinnedQueue);

  // With the queue pinned it is not one of the tabbed views, so selecting it
  // would leave the main column empty.
  const tabbed = pinnedQueue ? ['search', 'following', 'series'] : ['search', 'following', 'series', 'queue'];
  if (!tabbed.includes(activeView)) activeView = 'search';

  syncTabs(document, activeView, pinnedQueue);

  for (const view of document.querySelectorAll('.view')) {
    const name = view.id.replace('view-', '');
    view.hidden = name === 'queue' ? !pinnedQueue && activeView !== 'queue' : name !== activeView;
  }
}

function showView(name) {
  activeView = name;
  applyLayout();
  if (name === 'following') refreshFollowing().catch(error => notice($('following-status'),error.message,'error'));
}

/* ----------------------------- followed series ---------------------------- */

let followingRevision = 0;
let followingBusy = false;

async function refreshFollowing() {
  const revision = ++followingRevision;
  const entries = await send(MSG.FOLLOW_LIST);
  if (revision !== followingRevision) return;
  state.followed = entries;
  renderFollowing();
}

async function followAction(work) {
  if (followingBusy) return;
  followingBusy = true;
  renderFollowing();
  try { await work(); }
  catch (error) { notice($('following-status'),error.message,'error'); }
  finally {
    followingBusy = false;
    await refreshFollowing().catch(error => notice($('following-status'),error.message,'error'));
  }
}

function renderFollowing() {
  const body = clear($('following-body'));
  $('follow-check-all').disabled = followingBusy || !state.followed.length;
  $('follow-import').disabled = followingBusy;
  if (!state.followed.length) {
    body.append(el('div',{class:'empty',text:t('followEmpty',undefined,'เปิดเรื่องจาก Search หรือ URL แล้วกด “ติดตามเรื่องนี้” เพื่อเริ่มบันทึก')}));
  }
  for (const entry of state.followed) {
    const pending = pendingChapters(entry);
    const available = new Set(entry.availableIds);
    const handled = new Set(entry.handledIds);
    const max = chapters => chapters.length ? Math.max(...chapters.map(c => c.number)) : '—';
    const oldMax = max(entry.known.filter(c => handled.has(c.id)));
    const currentMax = max(entry.known.filter(c => available.has(c.id)));
    const row = el('div',{class:'panel followed-card'});
    row.append(el('div',{class:'series-head'},[
      thumb(entry.cover,entry.title), el('div',{},[
        el('h2',{text:entry.title}),
        el('div',{class:'sub',text:`${entry.adapterId} · ${entry.ref.lang} · ${t('followProgress',[oldMax,currentMax],`บันทึกแล้วถึง #${oldMax} → ล่าสุด #${currentMax}`)}`}),
        el('div',{text:pending.length ? t('followPending',[pending.length,toRangeSpec(pending.map(c=>c.number))],`${pending.length} ตอนใหม่ที่ยังไม่กดจัดการแล้ว: ${toRangeSpec(pending.map(c=>c.number))}`) : t('followNoPending',undefined,'ไม่มีตอนใหม่ค้างอยู่')}),
        el('div',{class:'hint',text:t('followLastChecked',[entry.lastCheckedAt ? new Date(entry.lastCheckedAt).toLocaleString() : t('followNever',undefined,'ยังไม่เคยเช็ก')],`เช็กสำเร็จล่าสุด: ${entry.lastCheckedAt ? new Date(entry.lastCheckedAt).toLocaleString() : 'ยังไม่เคยเช็ก'}`)}),
      ]),
    ]));
    if (entry.lastError) row.append(el('div',{class:'notice error',text:t('followCheckFailed',[entry.lastError],`เช็กไม่สำเร็จ: ${entry.lastError} (เก็บรายการเดิมไว้)`)}));
    if (pending.some(c => !available.has(c.id))) row.append(el('p',{class:'hint',text:t('followStaleHint',undefined,'บางตอนที่เคยพบไม่อยู่ในรายการล่าสุด จึงยังเก็บสถานะค้างไว้ ไม่ถือว่าโหลดแล้ว')}));
    const actions = el('div',{class:'follow-actions'});
    const action = (label, work, disabled = false) => {
      const button = el('button',{text:label,onclick:()=>followAction(work)});
      button.disabled = followingBusy || disabled;
      actions.append(button);
    };
    action(t('followCheckNew',undefined,'เช็กตอนใหม่'),async()=>{
      const {entry:updated} = await send(MSG.FOLLOW_CHECK,{id:entry.id});
      notice($('following-status'),t('followCheckResult',[updated.title,pendingChapters(updated).length],`${updated.title}: ${pendingChapters(updated).length} ตอนใหม่ค้างอยู่`));
    });
    action(t('followPickNew',undefined,'เลือกโหลดตอนใหม่'),async()=>{
      const {entry:updated,result} = await send(MSG.FOLLOW_CHECK,{id:entry.id});
      const ids = new Set(pendingChapters(updated).map(c => c.id));
      const chapters = result.series.chapters.filter(c=>ids.has(chapterIdentity(result.adapterId,c)));
      if (!chapters.length) {
        notice($('following-status'),t('followNoOpenable',undefined,'ไม่มีตอนใหม่ที่เปิดได้ในรายการล่าสุด'));
        return;
      }
      state.current = result;
      showView('series');
      renderSeries(result,{selection:toRangeSpec(chapters.map(c=>c.number)),followingTitle:updated.title});
    });
    action(t('followOpen',undefined,'เปิดเรื่อง'),()=>openSeries({adapterId:entry.adapterId,ref:entry.ref}));
    action(t('followMarkHandled',undefined,'จัดการตอนที่แสดงแล้ว'),async()=>{
      if (!window.confirm(t('followMarkConfirm',[pending.length,entry.title],`นำ ${pending.length} ตอนที่แสดงออกจากรายการตอนใหม่ของ “${entry.title}”?\nทำหลังโหลดสำเร็จหรือเมื่อไม่ต้องการโหลด การกดนี้ไม่ใช่การตรวจว่าไฟล์ดาวน์โหลดสำเร็จแล้ว`))) return;
      await send(MSG.FOLLOW_HANDLED,{id:entry.id,ids:pending.map(c=>c.id)});
      notice($('following-status'),t('followMarkedDone',undefined,'บันทึกว่าจัดการตอนที่แสดงแล้ว ตอนที่เข้ามาภายหลังจะยังค้างอยู่'));
    },!pending.length);
    action(t('followUnfollow',undefined,'เลิกติดตาม'),async()=>{
      if (!window.confirm(t('followUnfollowConfirm',[entry.title],`เลิกติดตาม “${entry.title}”? ประวัติการติดตามเรื่องนี้จะถูกลบ แต่ไฟล์ที่ดาวน์โหลดไว้ไม่ถูกลบ`))) return;
      await send(MSG.FOLLOW_REMOVE,{id:entry.id});
    });
    row.append(actions);
    body.append(row);
  }
}

async function exportFollowing() {
  try {
    const backup = await send(MSG.FOLLOW_EXPORT);
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'}));
    try {
      await chrome.downloads.download({url,filename:'webtoon-following-backup.json',conflictAction:'uniquify',saveAs:true});
      notice($('following-status'),t('followExportDone',undefined,'ส่งไฟล์สำรองให้เบราว์เซอร์แล้ว เก็บไฟล์นี้ไว้ก่อนเปลี่ยน/ลบส่วนขยาย'));
    } finally { setTimeout(()=>URL.revokeObjectURL(url),60000); }
  } catch (error) { notice($('following-status'),error.message,'error'); }
}

function initFollowing() {
  $('follow-check-all').addEventListener('click',()=>followAction(async()=>{
    let failed = 0;
    const entries = [...state.followed];
    for (let i=0;i<entries.length;i++) {
      notice($('following-status'),t('followCheckingProgress',[i+1,entries.length,entries[i].title],`กำลังเช็ก ${i+1}/${entries.length}: ${entries[i].title}`));
      try { await send(MSG.FOLLOW_CHECK,{id:entries[i].id}); }
      catch { failed++; }
    }
    notice($('following-status'),t('followCheckedAll',[entries.length],`เช็กครบ ${entries.length} เรื่อง`)+(failed ? t('followCheckedFailed',[failed],` · ไม่สำเร็จ ${failed} เรื่อง ดูข้อความใต้เรื่อง`) : ''));
  }));
  $('follow-export').addEventListener('click',exportFollowing);
  $('follow-import').addEventListener('click',()=>$('follow-import-file').click());
  $('follow-import-file').addEventListener('change',event=>{
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    followAction(async()=>{
      if (file.size > 5*1024*1024) throw new Error(t('backupTooLarge',undefined,'ไฟล์สำรองใหญ่เกิน 5 MB'));
      const backup = JSON.parse(await file.text());
      const result = await send(MSG.FOLLOW_IMPORT,{backup});
      notice($('following-status'),t('importResult',[result.added,result.skipped],`นำเข้า ${result.added} เรื่อง · ข้าม ${result.skipped} เรื่องที่มีอยู่แล้ว โดยไม่ทับสถานะเดิม`));
    });
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if (area === 'local' && changes[FOLLOW_KEY] && activeView === 'following') {
      refreshFollowing().catch(error=>notice($('following-status'),error.message,'error'));
    }
  });
}

/* --------------------------------- search --------------------------------- */

let searchRevision = 0;
let searching = false;
let webtoonLanguage = 'en';

function invalidateSearch() {
  searchRevision++;
  clear($('search-results'));
  clear($('search-status'));
  $('search-external').hidden = true;
}

function selectSearchSite() {
  const select = $('search-lang');
  if (!select.disabled && select.value) webtoonLanguage = select.value;
  const korean = $('search-site').value !== 'webtoons';
  clear(select);
  for (const { code, label } of korean ? [{ code: 'ko', label: '한국어 (Korean)' }] : LANGUAGES) {
    select.append(el('option', { value: code, text: label }));
  }
  select.disabled = korean;
  select.value = korean ? 'ko' : webtoonLanguage;
  $('search-input').placeholder = korean ? '화산귀환 / 나 혼자만 레벨업' : 'Tower of God';
  $('search-hint').textContent = korean
    ? t('searchHintKorean', undefined, 'Search Korean titles/authors. Opens a temporary tab and closes it after reading the first results. Kakao searches webtoons only; account access is opt-in on the chapter page.')
    : t('searchHintWebtoon', undefined, 'Search the selected WEBTOON language.');
  invalidateSearch();
}

async function runSearch() {
  if (searching) return;
  const revision = ++searchRevision;
  const adapterId = $('search-site').value;
  const query = $('search-input').value.trim();
  const status = $('search-status');
  const results = $('search-results');
  clear(results);
  $('search-external').hidden = true;

  if (!query) {
    notice(status, t('searchTypePrompt', undefined, 'Type a title to search for.'));
    return;
  }

  clear(status).append(el('div', { class: 'notice' }, [el('span', { class: 'spinner' }), ` ${t('searching', undefined, 'Searching…')}`]));
  searching = true;
  $('search-go').disabled = true;
  if (adapterId !== 'webtoons') {
    $('search-external').href = buildSiteSearchUrl(adapterId, query);
    $('search-external').hidden = false;
  }

  try {
    const found = await send(MSG.SEARCH, { query, lang: $('search-lang').value, adapterId });
    if (revision !== searchRevision) return;
    clear(status);
    if (!found.length) {
      notice(status, t('searchNoResults', [query], `Nothing found for "${query}" on the selected site/language.`));
      return;
    }
    notice(status, adapterId === 'webtoons'
      ? t('searchResults', [found.length], `${found.length} results.`)
      : t('searchResultsBatch', [found.length], `${found.length} results (first loaded batch; see the site for more).`));
    for (const item of found) {
      results.append(
        el('button', { class: 'card', onclick: () => openSeries({ url: item.url }) }, [
          thumb(item.thumbnail, item.title),
          el('span', { class: 'meta' }, [
            el('div', { class: 'title', text: item.title }),
            el('div', { class: 'sub', text: item.author || '' }),
          ]),
        ]),
      );
    }
  } catch (error) {
    if (revision === searchRevision) notice(status, error.message, 'error');
  } finally {
    searching = false;
    $('search-go').disabled = false;
  }
}

/* --------------------------------- series --------------------------------- */

async function openSeries({ url, adapterId, ref }) {
  showView('series');
  const body = $('series-body');
  clear(body).append(el('div', { class: 'notice' }, [el('span', { class: 'spinner' }), ` ${t('loadingChapters', undefined, 'Loading chapters…')}`]));

  try {
    const result = await send(MSG.GET_SERIES, { url, adapterId, ref });
    state.current = result;
    renderSeries(result);
  } catch (error) {
    // A protected-content refusal is a deliberate outcome, not a failure: say
    // what the site does and why, rather than showing a red error.
    notice(body, error.message, error.protectedContent ? 'protected' : 'error');
  }
}

function renderSeries({ series, adapterId, ref }, options = {}) {
  const body = clear($('series-body'));

  body.append(
    el('div', { class: 'series-head' }, [
      thumb(series.cover, series.title),
      el('div', {}, [
        el('h2', { text: series.title }),
        el('div', { class: 'sub', text: series.author || '' }),
        el('div', { class: 'sub', text: t('chaptersAvailable', [series.chapters.length], `${series.chapters.length} chapters available`) }),
      ]),
    ]),
  );

  const followButton = el('button',{text:t('followThis',undefined,'ติดตามเรื่องนี้'),onclick:async()=>{
    followButton.disabled = true;
    try {
      await send(MSG.FOLLOW_ADD,{series,adapterId,ref});
      followButton.textContent = t('followedGoTab',undefined,'ติดตามแล้ว — ดูในแท็บติดตาม');
    } catch (error) {
      followButton.textContent = t('followAddFailed',[error.message],`บันทึกไม่สำเร็จ: ${error.message} (กดเพื่อลองใหม่)`);
      followButton.disabled = false;
    }
  }});
  body.append(followButton,el('p',{class:'hint',text:t('followFirstHint',undefined,'ครั้งแรกจะจำตอนที่มีอยู่ตอนนี้ทั้งหมดเป็นจุดเริ่มต้น ไม่ได้ถือว่าดาวน์โหลดตอนเหล่านั้นแล้ว')}));
  if (options.followingTitle) body.append(el('div',{class:'notice',text:t('followSelectedNewHint',undefined,'เลือกเฉพาะตอนใหม่ให้แล้ว หลังตรวจว่าโหลดสำเร็จ ให้กลับไปแท็บติดตามและกด “จัดการตอนที่แสดงแล้ว” การดาวน์โหลดล้มเหลวจะไม่ทำให้รายการตอนใหม่หาย')}));

  /*
   * isFree describes the catalog, not this account's purchase entitlement.
   * Start with free chapters (or the exact pasted episode), and require an
   * explicit account-mode choice before requesting non-free episodes.
   */
  const downloadable = series.chapters.filter((c) => c.isFree !== false).map((c) => c.number);
  const lockedCount = series.chapters.length - downloadable.length;

  const selection = el('input', {
    type: 'text',
    id: 'range-input',
    value: options.selection ?? initialSelection(series.chapters, ref, adapterId),
    placeholder: 'all, latest, latest:5, 1-25, 1,3,5-9',
    autocomplete: 'off',
  });

  const format = el('select', { id: 'format-select' });
  for (const value of OUTPUT_FORMATS) {
    const label = {
      pdf: t('fmtPdf', undefined, 'PDF'),
      cbz: t('fmtCbz', undefined, 'CBZ (comic archive)'),
      zip: t('fmtZip', undefined, 'ZIP (images archive)'),
      raw: t('fmtRaw', undefined, 'Raw images'),
    }[value];
    format.append(el('option', { value, text: label, ...(state.settings.format === value ? { selected: 'selected' } : {}) }));
  }

  const quality = el('input', { type: 'checkbox', id: 'quality-toggle' });
  quality.checked = state.settings.originalQuality;

  const cleanup = el('input', { type: 'checkbox', id: 'cleanup-toggle' });
  cleanup.checked = state.settings.writeRawThenClean;

  const bundle = el('input', { type: 'checkbox', id: 'bundle-toggle' });
  bundle.checked = state.settings.bundleSeries;
  const bundleLabel = el('label', { class: 'checkbox' }, [bundle,
    el('span', { text: t('bundleSeries', undefined, 'รวมทุกตอนที่เลือกเป็นไฟล์เดียวต่อเรื่อง (ตั้งชื่อตามช่วงตอน)') })]);
  const bundleHint = el('p', { class: 'hint' });
  // Bundling concatenates every chapter in memory, so it only applies to the
  // archive formats and never to stitching (which is itself whole-chapter work).
  const bundleApplies = () => (format.value === 'cbz' || format.value === 'zip') && !stitchToggle.checked;
  const refreshBundle = () => {
    const ok = bundleApplies();
    bundle.disabled = !ok;
    bundleHint.textContent = ok
      ? t('bundleHintOn', undefined, 'เช่น “ชื่อเรื่อง 1-25.cbz” ทั้งเรื่องในไฟล์เดียว แต่ละตอนอยู่ในโฟลเดอร์ย่อยภายใน ไฟล์ใหญ่มากอาจสร้างไม่ได้')
      : t('bundleHintOff', undefined, 'ใช้ได้เฉพาะ CBZ/ZIP และต้องปิดการต่อภาพแนวตั้ง');
  };

  const stitchSettings={...STITCH_DEFAULTS,...state.settings};
  const stitchToggle=el('input',{type:'checkbox',id:'stitch-toggle'});
  stitchToggle.checked=stitchSettings.stitchEnabled;
  const stitchPanel=el('div',{class:'panel stitch-options'});
  const select=(id,choices,value)=>{
    const node=el('select',{id});
    for(const [key,label] of choices)node.append(el('option',{value:key,text:label}));
    node.value=value;return node;
  };
  const stitchMode=select('stitch-mode',[['smart',t('stitchModeSmart',undefined,'Smart — คำนวณความสูงให้')],['height',t('stitchModeHeight',undefined,'กำหนดความสูงสูงสุดต่อภาพ')],['count',t('stitchModeCount',undefined,'กำหนดจำนวนภาพ + ความสูงสูงสุด')]],stitchSettings.stitchMode);
  const stitchHeight=el('input',{id:'stitch-height',type:'number',min:1,max:32767,step:1,value:stitchSettings.stitchHeight});
  const stitchCount=el('input',{id:'stitch-count',type:'number',min:1,max:2000,step:1,value:stitchSettings.stitchCount});
  const stitchWidth=el('input',{id:'stitch-width',type:'number',min:0,max:32767,step:1,value:stitchSettings.stitchWidth});
  const stitchMime=select('stitch-mime',[['image/jpeg','JPG'],['image/png','PNG (lossless)'],['image/webp','WebP']],stitchSettings.stitchMime);
  const stitchQuality=el('input',{id:'stitch-quality',type:'number',min:1,max:100,step:1,value:stitchSettings.stitchQuality});
  const field=(title,node)=>el('label',{class:'field'},[el('span',{text:title}),node]);
  const heightField=field(t('stitchFieldHeight',undefined,'ความสูงสูงสุดต่อภาพ (px) — ภาพสุดท้ายอาจสั้นกว่า'),stitchHeight);
  const countField=field(t('stitchFieldCount',undefined,'จำนวนภาพต่อตอน — แบ่งความสูงใกล้เคียงกัน'),stitchCount);
  const stitchHint=el('p',{class:'hint'});
  stitchPanel.append(field(t('stitchFieldMode',undefined,'วิธีแบ่งภาพ'),stitchMode),heightField,countField,
    field(t('stitchFieldWidth',undefined,'ความกว้าง (px) — 0 = ใช้ความกว้างภาพต้นฉบับที่แคบที่สุด'),stitchWidth),
    field(t('stitchFieldMime',undefined,'ชนิดภาพหลังต่อ'),stitchMime),field(t('stitchFieldQuality',undefined,'คุณภาพ JPG/WebP (1–100)'),stitchQuality),stitchHint);
  const getStitchSettings=()=>({stitchEnabled:stitchToggle.checked,stitchMode:stitchMode.value,
    stitchHeight:Number(stitchHeight.value),stitchCount:Number(stitchCount.value),stitchWidth:Number(stitchWidth.value),
    stitchMime:stitchMime.value,stitchQuality:Number(stitchQuality.value)});
  const refreshStitch=()=>{
    stitchPanel.hidden=!stitchToggle.checked;
    heightField.hidden=stitchMode.value==='smart';
    countField.hidden=stitchMode.value!=='count';
    stitchMime.disabled=format.value==='pdf';
    stitchQuality.disabled=stitchMime.value==='image/png'&&format.value!=='pdf';
    const limits=stitchCodecLimits(format.value==='pdf'?'image/jpeg':stitchMime.value);
    stitchHeight.setAttribute('max',limits.maxHeight);
    stitchWidth.setAttribute('max',limits.maxWidth);
    const maxWidth=limits.maxWidth.toLocaleString();
    stitchHint.textContent=t('stitchHintDesktop',[maxWidth],`เพดานเดสก์ท็อป: กว้าง/สูง ≤ ${maxWidth} px และพื้นที่รวม ≤ 268,435,456 พิกเซล (เฉพาะ canvas อาจใช้ RAM ถึง 1 GiB) ใช้ค่าเดียวกันทุกอุปกรณ์ ไม่ได้ตรวจ RAM ว่างหรือรับประกันว่าเครื่องจะทำไหว; WebP จำกัด 16,383 px ต่อด้าน ถ้าจะใช้ 18,000 ให้เลือก JPG/PNG; Smart ใช้เพดานนี้ในการแบ่ง ไม่ตัดตามช่องคำพูด ภาพถูกปรับความกว้างและพื้นหลังโปร่งใสเป็นสีขาว ถ้าจำนวนภาพน้อยเกินไปจะแจ้งขั้นต่ำ ไม่ทิ้งภาพส่วนท้าย `)+
      (format.value==='pdf'?t('stitchHintPdf',undefined,'PDF ใช้ภาพ JPG ภายใน โดยใช้คุณภาพที่ตั้งไว้'):t('stitchHintArchive',undefined,'เลือก Save as เป็น Raw images เพื่อบันทึกภาพแยก หรือ ZIP/CBZ เพื่อรวมเป็นไฟล์เดียว'));
  };

  const summary = el('p', { class: 'hint', text: '' });
  const start = el('button', { class: 'primary', text: t('downloadButton', undefined, 'Download'), style: 'width:100%' });
  const accountAccess = el('input', { type: 'checkbox', id: 'account-access-toggle' });
  // Always off when opening a series: this choice is explicit for each job.
  accountAccess.checked = false;

  const refreshSummary = () => {
    if (downloadable.length === 0 && !(adapterId === 'kakao' && accountAccess.checked)) {
      summary.textContent = t('noFreeChapters', undefined, 'No free chapters. If you already have access, enable the Kakao account option and enter specific chapter numbers.');
      start.disabled = true;
      return;
    }
    try {
      if(stitchToggle.checked)stitchOptions({...getStitchSettings(),format:format.value});
      const { chosen, nonFreeCount } = validateChapterSelection(series.chapters, selection.value,
        adapterId === 'kakao' && accountAccess.checked);
      summary.textContent = t('willRequest', [describeSelection(chosen)], `Will request ${describeSelection(chosen)}.`) +
        (nonFreeCount ? t('kakaoAuthNote', [nonFreeCount], ` Kakao must authorize ${nonFreeCount} non-free chapter(s); enabling this option does not unlock them.`) : '');
      start.disabled = false;
    } catch (error) {
      summary.textContent = error.message;
      start.disabled = true;
    }
  };
  selection.addEventListener('input', refreshSummary);
  accountAccess.addEventListener('change', refreshSummary);
  for(const node of [stitchToggle,stitchMode,stitchHeight,stitchCount,stitchWidth,stitchMime,stitchQuality,format]) {
    node.addEventListener('change',()=>{refreshStitch();refreshBundle();refreshSummary();});
    node.addEventListener('input',refreshSummary);
  }
  refreshStitch();
  refreshBundle();

  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      await send(MSG.START_JOB, {
        adapterId,
        ref,
        selection: selection.value,
        settings: {
          format: format.value,
          originalQuality: quality.checked,
          writeRawThenClean: cleanup.checked,
          bundleSeries: bundle.checked && bundleApplies(),
          kakaoAccountAccess: adapterId === 'kakao' && accountAccess.checked,
          ...getStitchSettings(),
        },
      });
      showView('queue');
    } catch (error) {
      notice(summary.parentElement, error.message, error.protectedContent ? 'protected' : 'error');
    } finally {
      refreshSummary();
    }
  });

  if (lockedCount > 0) {
    body.append(
      el('div', { class: 'notice protected' }, [
        el('strong', { text: t('lockedStrong', [downloadable.length, series.chapters.length], `${downloadable.length} of ${series.chapters.length} chapters are free. `) }),
        t('lockedRest', [lockedCount], `The other ${lockedCount} are not marked free; this is not a check of your purchases. Default mode permits free chapters only.`),
      ]),
    );
  }

  if (adapterId === 'kakao') {
    body.append(
      el('label', { class: 'checkbox' }, [accountAccess,
        el('span', { text: t('kakaoAccessLabel', undefined, 'Use my existing Kakao access (already purchased / active rental)') })]),
      el('p', { class: 'hint', text: t('kakaoAccessHint', undefined, 'Sign in to Kakao and open the episode in this same browser/profile first. This option only requests viewer data; it does not buy chapters, call ticket/unlock APIs, or decrypt DRM. Start with one episode.') }),
    );
  }

  body.append(
    el('label', { class: 'field' }, [el('span', { text: t('labelChapters', undefined, 'Chapters') }), selection]),
    summary,
    el('label', { class: 'field' }, [el('span', { text: t('labelSaveAs', undefined, 'Save as') }), format]),
    el('label',{class:'checkbox'},[stitchToggle,el('span',{text:t('labelStitch',undefined,'ต่อภาพแนวตั้งแยกแต่ละตอน (Long images)')})]),
    stitchPanel,
    bundleLabel,
    bundleHint,
    el('label', { class: 'checkbox' }, [quality, el('span', { text: t('labelOriginalQuality', undefined, 'Original-quality images (larger files)') })]),
    el('label', { class: 'checkbox' }, [cleanup, el('span', { text: t('labelCleanup', undefined, 'Also write raw images, then delete them after converting') })]),
    start,
  );

  refreshSummary();

  const list = el('details', { class: 'settings' }, [el('summary', { text: t('chapterListSummary', [series.chapters.length], `Chapter list (${series.chapters.length})`) })]);
  for (const chapter of [...series.chapters].reverse()) {
    list.append(
      el('div', { class: 'chapter' }, [
        el('span', { class: 'num', text: `#${chapter.number}` }),
        el('span', { text: chapter.title || '' }),
        chapter.isFree === false
          ? el('span', { class: 'pill skipped-protected', text: t('notFreePill', undefined, 'not free · access unchecked') })
          : el('span', { class: 'note', text: chapter.date || '' }),
      ]),
    );
  }
  body.append(list);
}

/* ---------------------------------- queue --------------------------------- */

function renderQueue() {
  const body = clear($('queue-body'));
  if (state.jobs.size === 0) {
    body.append(el('div', { class: 'empty', text: t('queueEmpty', undefined, 'No downloads yet.') }));
    return;
  }

  for (const job of [...state.jobs.values()].reverse()) {
    const card = el('div', { class: 'job' });
    const head = el('div', { class: 'job-head' }, [
      el('strong', { text: job.seriesTitle || job.site || 'Job' }),
      el('span', { class: `pill ${job.status}`, text: job.status }),
    ]);

    if (job.status === STATUS.RUNNING) {
      head.append(
        el('button', {
          text: 'Cancel',
          onclick: () => send(MSG.CANCEL_JOB, { jobId: job.id }).catch(() => {}),
        }),
      );
    }
    card.append(head);

    if (job.error) card.append(el('div', { class: 'notice error', text: job.error }));

    for (const chapter of job.chapters ?? []) {
      const pct = chapter.total ? Math.round((chapter.done / chapter.total) * 100) : 0;
      const bar = el('div', { class: 'bar', role: 'progressbar', 'aria-label': `Chapter ${chapter.number}`,
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(chapter.status === STATUS.DONE ? 100 : pct) }, [el('i')]);
      bar.firstChild.style.width = `${chapter.status === STATUS.DONE ? 100 : pct}%`;

      card.append(
        el('div', { class: 'chapter' }, [
          el('span', { class: 'num', text: `#${chapter.number}` }),
          chapter.note
            ? el('span', { class: 'note', text: chapter.note })
            : bar,
          el('span', { class: `pill ${chapter.status}`, text: chapter.status.replace('skipped-protected', 'protected') }),
        ]),
      );
    }
    body.append(card);
  }
}

/* ---------------------------------- boot ---------------------------------- */

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.JOB_UPDATED) {
    state.jobs.set(message.payload.id, message.payload);
    renderQueue();
  }
  // Not handled here; let another context respond.
  return false;
});

/**
 * Interface-language picker. Lets the user force a language instead of
 * following the browser; the choice is persisted and applied immediately,
 * re-rendering the active dynamic view so its strings switch too.
 */
function initUiLanguageSelector() {
  const select = $('ui-lang');
  if (!select) return;
  clear(select);
  for (const { code, label } of UI_LANGUAGES) select.append(el('option', { value: code, text: label }));
  select.value = state.settings.uiLanguage;
  select.addEventListener('change', async () => {
    try {
      state.settings = await send(MSG.SET_SETTINGS, { uiLanguage: select.value });
      await applyUiLanguage(state.settings.uiLanguage);
      if (activeView === 'series' && state.current) renderSeries(state.current);
      else if (activeView === 'following') renderFollowing();
      else if (activeView === 'queue') renderQueue();
    } catch (error) {
      notice($('search-status'), error.message, 'error');
    }
  });
}

async function init() {
  state.settings = await send(MSG.GET_SETTINGS);
  await applyUiLanguage(state.settings.uiLanguage);
  initUiLanguageSelector();
  initFollowing();

  webtoonLanguage = state.settings.language;
  selectSearchSite();
  $('search-site').addEventListener('change', selectSearchSite);
  $('search-lang').addEventListener('change', invalidateSearch);
  $('search-input').addEventListener('input', invalidateSearch);

  initTabs({ activate: showView });
  // Re-run on resize so dragging the window across the breakpoint does not
  // strand the queue in a hidden tab.
  WIDE.addEventListener('change', applyLayout);
  applyLayout();

  $('search-go').addEventListener('click', runSearch);
  $('search-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runSearch();
  });

  const openFromInput = () => {
    const url = $('url-input').value.trim();
    if (url) openSeries({ url });
  };
  $('url-go').addEventListener('click', openFromInput);
  $('url-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openFromInput();
  });

  // The toolbar click stashes whatever page you were on. If it is a series we
  // recognise, open it straight away rather than making you paste the link you
  // were already looking at.
  const pending = await chrome.storage.session?.get('pendingUrl').catch(() => ({}));
  if (pending?.pendingUrl) {
    await chrome.storage.session.remove('pendingUrl');
    try {
      // Resolve first: an ordinary tab (a new tab page, unrelated site) is the
      // normal case and must not surface as an error on startup.
      await send(MSG.RESOLVE_URL, { url: pending.pendingUrl });
      $('url-input').value = pending.pendingUrl;
      openSeries({ url: pending.pendingUrl });
    } catch {
      // Not a supported page; just show the search view.
    }
  }
}

init().catch((error) => {
  notice($('search-status'), error.message, 'error');
});
