import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDownload } from '../../src/background/download-manager.js';

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
