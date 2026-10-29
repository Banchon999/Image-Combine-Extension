import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDownload, installFilenameGuard, sameDownloadName } from '../../src/background/download-manager.js';

function mockDownloads(t, errors) {
  const previous = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    runtime: {},
    downloads: { download(options, done) {
      calls.push(options);
      const error = errors[calls.length - 1];
      chrome.runtime.lastError = error ? {message:error} : undefined;
      done(error ? undefined : 100 + calls.length);
      delete chrome.runtime.lastError;
    } },
  };
  t.after(()=> {globalThis.chrome = previous;});
  return calls;
}

test('download retries a rejected name once with same Blob and ASCII basename', async t => {
  const calls = mockDownloads(t, ['Invalid filename']);
  const id = await startDownload({blobUrl:'blob:test',filename:'책/첫화.cbz'});
  assert.equal(id,102);
  assert.equal(calls.length,2);
  assert.match(calls[1].filename,/^webtoon-[a-f0-9-]+\.cbz$/);
  assert.equal(calls[1].url,calls[0].url);
  assert.equal(calls[1].conflictAction,'uniquify');
});

test('successful names are sanitized and not retried', async t => {
  const calls = mockDownloads(t, []);
  assert.equal(await startDownload({blobUrl:'blob:test',filename:'가'.repeat(100)+'/나'.repeat(1)+'.zip'}),101);
  assert.equal(calls.length,1);
  assert.ok(calls[0].filename.split('/').every(p=>new TextEncoder().encode(p).length <= 180));
  assert.ok(calls[0].filename.endsWith('.zip'));
});

test('fallback preserves each supported image/archive extension', async t => {
  for (const ext of ['zip','pdf','jpg','png','webp','gif','avif','bmp']) {
    const calls = mockDownloads(t,['Invalid filename']);
    await startDownload({blobUrl:'blob:test',filename:'책/001.'+ext});
    assert.ok(calls[1].filename.endsWith('.'+ext));
  }
});

test('permission and disk errors do not trigger a renamed retry', async t => {
  for (const message of ['Permission denied','Disk full','Network failed']) {
    const calls = mockDownloads(t,[message]);
    await assert.rejects(startDownload({blobUrl:'blob:test',filename:'a.cbz'}), {message});
    assert.equal(calls.length,1);
  }
});

test('second filename rejection stops and reports the fallback name', async t => {
  const calls = mockDownloads(t,['Invalid filename','Invalid filename']);
  await assert.rejects(startDownload({blobUrl:'blob:test',filename:'책/첫화.cbz'}), /Could not save webtoon-.*\.cbz: Invalid filename/);
  assert.equal(calls.length,2);
});

test('unsafe paths are rejected before any download call', async t => {
  const calls = mockDownloads(t,[]);
  await assert.rejects(startDownload({blobUrl:'blob:test',filename:'../a.cbz'}), /Unsafe download path/);
  assert.equal(calls.length,0);
});

/** chrome.downloads with the naming event and a settable final name. */
function namingChrome(t, { finalName } = {}) {
  const previous = globalThis.chrome;
  const listeners = { naming: [], changed: [] };
  const calls = [];
  globalThis.chrome = {
    runtime: { id: 'ours' },
    downloads: {
      onDeterminingFilename: { addListener: (fn) => listeners.naming.push(fn) },
      onChanged: { addListener: (fn) => listeners.changed.push(fn), removeListener: (fn) => { listeners.changed = listeners.changed.filter((x) => x !== fn); } },
      search: (query, done) => done(finalName ? [{ id: query.id, filename: finalName }] : [{ id: query.id, filename: '' }]),
      download(options, done) { calls.push(options); done(200 + calls.length); },
    },
  };
  t.after(() => { globalThis.chrome = previous; });
  const decide = (item) => {
    let suggestion = 'not called';
    for (const fn of listeners.naming) fn(item, (s) => { suggestion = s; });
    return suggestion;
  };
  return { calls, decide, listeners };
}

test('our downloads get their requested name back when Chrome asks; others are left alone', async (t) => {
  const { decide } = namingChrome(t);
  installFilenameGuard();
  await startDownload({ blobUrl: 'blob:chrome-extension://ours/0cc281d0', filename: 'Webtoons/The Good Daughter-in-Law Is Gone ตอน 1-2.zip' });
  assert.deepEqual(decide({ byExtensionId: 'ours', url: 'blob:chrome-extension://ours/0cc281d0' }),
    { filename: 'Webtoons/The Good Daughter-in-Law Is Gone ตอน 1-2.zip', conflictAction: 'uniquify' });
  // Another site's download, and another extension's: an empty suggestion.
  assert.equal(decide({ url: 'https://example.com/file.zip' }), undefined);
  assert.equal(decide({ byExtensionId: 'someone-else', url: 'blob:chrome-extension://ours/0cc281d0' }), undefined);
  // Used once only.
  assert.equal(decide({ byExtensionId: 'ours', url: 'blob:chrome-extension://ours/0cc281d0' }), undefined);
});

test('after a rejected name, the fallback name is the one restored', async (t) => {
  const { calls, decide } = namingChrome(t);
  installFilenameGuard();
  const realDownload = chrome.downloads.download;
  chrome.downloads.download = (options, done) => {
    if (calls.length === 0) { calls.push(options); chrome.runtime.lastError = { message: 'Invalid filename' }; done(undefined); delete chrome.runtime.lastError; return; }
    realDownload(options, done);
  };
  await startDownload({ blobUrl: 'blob:x/1', filename: '책/첫화.cbz' });
  assert.match(decide({ byExtensionId: 'ours', url: 'blob:x/1' }).filename, /^webtoon-[a-f0-9-]+\.cbz$/);
});

test('a file saved under another name is reported; Chrome\'s " (1)" is not', async (t) => {
  const reports = [];
  namingChrome(t, { finalName: 'C:\\Users\\max\\Downloads\\0cc281d0-3d10-4fa4-8aa2-ed93ad9d6013' });
  await startDownload({ blobUrl: 'blob:x/2', filename: 'Webtoons/Gone ตอน 1-2.zip', onRenamed: (info) => reports.push(info) });
  assert.deepEqual(reports, [{ downloadId: 201, requested: 'Gone ตอน 1-2.zip', actual: '0cc281d0-3d10-4fa4-8aa2-ed93ad9d6013' }]);

  const quiet = [];
  namingChrome(t, { finalName: 'C:\\Users\\max\\Downloads\\Webtoons\\Gone ตอน 1-2 (1).zip' });
  await startDownload({ blobUrl: 'blob:x/3', filename: 'Webtoons/Gone ตอน 1-2.zip', onRenamed: (info) => quiet.push(info) });
  assert.deepEqual(quiet, []);
});

test('sameDownloadName compares base names across path styles', () => {
  assert.equal(sameDownloadName('Webtoons/A/001.cbz', 'C:\\Downloads\\Webtoons\\A\\001.cbz'), true);
  assert.equal(sameDownloadName('Webtoons/A/001.cbz', '/home/u/Downloads/Webtoons/A/001 (2).cbz'), true);
  assert.equal(sameDownloadName('Webtoons/A.zip', '/home/u/Downloads/0cc281d0-3d10'), false);
  assert.equal(sameDownloadName('Webtoons/A (1) B.zip', '/d/A (1) B.zip'), true);
});
