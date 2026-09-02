/**
 * Engine pipeline tests.
 *
 * These cover the glue that fixtures and browser checks cannot reach: retry
 * behaviour, partial chapters, format branching, cleanup ordering and
 * cancellation. All I/O is faked, so the assertions are exact rather than
 * timing-dependent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/offscreen/engine.js';
import { RefererRuleError, FetchError, ProtectedContentError } from '../../src/common/errors.js';
import { STATUS } from '../../src/common/messages.js';

/** A minimal valid baseline JPEG, so the PDF writer has something real to parse. */
function jpeg(width = 700, height = 1140) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    0xff, 0xd9,
  ]);
}

/** A stub adapter standing in for a real site, with no DOM involved. */
function stubAdapter({ chapters = [1, 2, 3], pagesPerChapter = 3, onImages } = {}) {
  return {
    id: 'stub',
    label: 'Stub Site',
    hostPatterns: ['stub.test'],
    capabilities: { search: true, originalQuality: true, download: true, languages: ['en'] },
    parseUrl: () => ({ seriesId: '1', lang: 'en' }),
    async getSeries() {
      return {
        title: 'Stub Series',
        author: 'Stub Author',
        chapters: chapters.map((n) => ({ number: n, title: `Episode ${n}`, url: `https://stub.test/${n}` })),
      };
    },
    async getChapterImages(_ref, chapter, _ctx, opts) {
      onImages?.(chapter, opts);
      return Array.from({ length: pagesPerChapter }, (_, i) => ({
        url: `https://cdn.stub.test/c${chapter.number}-p${i + 1}.jpg`,
        index: i + 1,
        width: 700,
        height: 1140,
      }));
    },
  };
}

/** Records every save and removal so tests can assert on the exact sequence. */
function recordingIo(overrides = {}) {
  const saved = [];
  const removed = [];
  let nextId = 100;
  return {
    saved,
    removed,
    io: {
      getAdapter: () => stubAdapter(),
      fetchDoc: async () => {
        throw new Error('fetchDoc should not be called by these tests');
      },
      fetchImage: async (url) => ({ data: jpeg(), mimeType: 'image/jpeg', url }),
      saveBlob: async (blob, filename) => {
        saved.push({ filename, size: blob.size, type: blob.type });
        return nextId++;
      },
      removeFiles: async (ids) => removed.push(...ids),
      ...overrides,
    },
  };
}

const baseSettings = { throttleMs: 0, concurrentChapters: 2, concurrentImages: 4 };

for (const format of ['raw','zip','cbz','pdf']) {
  test(`stitched ${format} export uses generated parts and keeps the filename extension`,async()=>{
    const {io,saved}=recordingIo({
      toJpeg:async()=>{throw new Error('Must not recompress stitched PDF');},
      async *stitchPages(pages,settings,signal,progress){
        assert.equal(pages.length,3);assert.equal(settings.concurrentChapters,1);
        progress('Stitching');
        for(let index=1;index<=2;index++)yield {index,width:700,height:100,mimeType:'image/jpeg',data:jpeg(700,100)};
      },
    });
    const job=await createEngine(io).runJob({jobId:`stitched-${format}`,adapterId:'stub',ref:{},selection:'1',settings:{...baseSettings,format,stitchEnabled:true}});
    assert.equal(job.status,STATUS.DONE);
    assert.match(job.chapters[0].note,/Stitched into 2/);
    assert.equal(saved.length,format==='raw'?2:1);
    assert.ok(saved.every(s=>s.filename.includes('stitched')));
    assert.ok(saved.every(s=>s.filename.endsWith(format==='raw'?'.jpg':`.${format}`)));
  });
}
test('failed source image prevents exporting a stitched partial chapter',async()=>{
  const {io,saved}=recordingIo({
    fetchImage:async url=>{if(url.includes('p2'))throw new RefererRuleError('source denied');return {data:jpeg(),mimeType:'image/jpeg'};},
    async *stitchPages(){assert.fail('Must not stitch missing content');},
  });
  const job=await createEngine(io).runJob({jobId:'stitch-missing',adapterId:'stub',ref:{},selection:'1',settings:{...baseSettings,format:'zip',stitchEnabled:true}});
  assert.equal(job.status,STATUS.FAILED);assert.equal(saved.length,0);
  assert.match(job.chapters[0].note,/incomplete chapter/);
});

/* --------------------------------- happy path ------------------------------ */

test('runs a job end to end and writes one archive per chapter', async () => {
  const { io, saved } = recordingIo();
  const job = await createEngine(io).runJob({
    jobId: 'j1',
    adapterId: 'stub',
    ref: {},
    selection: 'all',
    settings: { ...baseSettings, format: 'cbz' },
  });

  assert.equal(job.status, STATUS.DONE);
  assert.equal(job.seriesTitle, 'Stub Series');
  assert.equal(job.chapters.length, 3);
  assert.ok(job.chapters.every((c) => c.status === STATUS.DONE && c.done === 3 && c.total === 3));

  assert.equal(saved.length, 3, 'one CBZ per chapter, no stray raw images');
  // Chapters run concurrently, so completion order is not deterministic;
  // compare as sets.
  assert.deepEqual(saved.map((s) => s.filename).sort(), [
    'Webtoons/Stub Series/001 - Episode 1.cbz',
    'Webtoons/Stub Series/002 - Episode 2.cbz',
    'Webtoons/Stub Series/003 - Episode 3.cbz',
  ]);
  assert.ok(saved.every((s) => s.type === 'application/vnd.comicbook+zip'));
});

test('honours the chapter selection', async () => {
  const { io, saved } = recordingIo();
  const job = await createEngine(io).runJob({
    jobId: 'j2',
    adapterId: 'stub',
    ref: {},
    selection: '2',
    settings: { ...baseSettings, format: 'cbz' },
  });
  assert.equal(job.chapters.length, 1);
  assert.equal(job.chapters[0].number, 2);
  assert.equal(saved.length, 1);
  assert.match(saved[0].filename, /002 - Episode 2\.cbz$/);
});

test('passes the originalQuality setting through to the adapter', async () => {
  const seen = [];
  const { io } = recordingIo({
    getAdapter: () => stubAdapter({ onImages: (_c, opts) => seen.push(opts.originalQuality) }),
  });
  await createEngine(io).runJob({
    jobId: 'j3',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, originalQuality: false },
  });
  assert.deepEqual(seen, [false]);
});

test('falls back to the published q90 image when the source URL is rejected', async () => {
  const attempted = [];
  const fallbackAdapter = stubAdapter({ chapters: [1], pagesPerChapter: 1 });
  fallbackAdapter.getChapterImages = async () => [{
    url: 'https://cdn.stub.test/source.jpg',
    fallbackUrl: 'https://cdn.stub.test/source.jpg?type=q90',
    index: 1,
  }];
  const { io, saved } = recordingIo({
    getAdapter: () => fallbackAdapter,
    fetchImage: async (url) => {
      attempted.push(url);
      if (!url.includes('type=q90')) throw new RefererRuleError(undefined, { url });
      return { data: jpeg(), mimeType: 'image/jpeg' };
    },
  });

  const job = await createEngine(io).runJob({
    jobId: 'j3-fallback',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, format: 'cbz', retryAttempts: 5 },
  });

  assert.equal(job.status, STATUS.DONE);
  assert.equal(saved.length, 1);
  assert.deepEqual(attempted, [
    'https://cdn.stub.test/source.jpg',
    'https://cdn.stub.test/source.jpg?type=q90',
  ]);
});

/* ---------------------------------- formats -------------------------------- */

test('raw format writes each image and builds no archive', async () => {
  const { io, saved } = recordingIo();
  await createEngine(io).runJob({
    jobId: 'j4',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, format: 'raw' },
  });
  assert.equal(saved.length, 3, 'three page images');
  assert.deepEqual(
    saved.map((s) => s.filename),
    [
      'Webtoons/Stub Series/001 - Episode 1/001.jpg',
      'Webtoons/Stub Series/001 - Episode 1/002.jpg',
      'Webtoons/Stub Series/001 - Episode 1/003.jpg',
    ],
  );
  assert.ok(saved.every((s) => !s.filename.endsWith('.cbz')));
});

test('pdf format produces a single application/pdf blob', async () => {
  const { io, saved } = recordingIo();
  await createEngine(io).runJob({
    jobId: 'j5',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, format: 'pdf' },
  });
  assert.equal(saved.length, 1);
  assert.match(saved[0].filename, /\.pdf$/);
  assert.equal(saved[0].type, 'application/pdf');
});

/* ---------------------------------- cleanup -------------------------------- */

test('writeRawThenClean stages images, then deletes them after the archive', async () => {
  const order = [];
  const { io, saved, removed } = recordingIo();
  const wrapped = {
    ...io,
    saveBlob: async (blob, filename) => {
      order.push(`save:${filename.endsWith('.cbz') ? 'archive' : 'raw'}`);
      return io.saveBlob(blob, filename);
    },
    removeFiles: async (ids) => {
      order.push('remove');
      return io.removeFiles(ids);
    },
  };

  await createEngine(wrapped).runJob({
    jobId: 'j6',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, format: 'cbz', writeRawThenClean: true },
  });

  assert.equal(saved.length, 4, 'three raw images plus the archive');
  assert.equal(removed.length, 3, 'the three staged images are removed');
  // Deleting before the archive is written would lose data on a failure.
  assert.deepEqual(order, ['save:raw', 'save:raw', 'save:raw', 'save:archive', 'remove']);
});

test('cleanup is skipped when disabled', async () => {
  const { io, saved, removed } = recordingIo();
  await createEngine(io).runJob({
    jobId: 'j7',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, format: 'cbz', writeRawThenClean: false },
  });
  assert.equal(saved.length, 1);
  assert.equal(removed.length, 0);
});

/* ------------------------------ failure handling --------------------------- */

test('a chapter that loses one image is delivered as partial', async () => {
  let calls = 0;
  const { io, saved } = recordingIo({
    fetchImage: async (url) => {
      // Fail one specific page on every attempt.
      if (url.endsWith('p2.jpg')) {
        calls++;
        throw new FetchError('HTTP 500', { url });
      }
      return { data: jpeg(), mimeType: 'image/jpeg' };
    },
  });

  const job = await createEngine(io).runJob({
    jobId: 'j8',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, format: 'cbz', retryAttempts: 2 },
  });

  assert.equal(job.status, STATUS.PARTIAL);
  assert.equal(job.chapters[0].status, STATUS.PARTIAL);
  assert.match(job.chapters[0].note, /1 image\(s\) failed/);
  // The surviving pages are still written rather than discarded.
  assert.equal(saved.length, 1);
  assert.equal(calls, 2, 'retried the configured number of times');
});

test('a chapter that loses every image fails without writing anything', async () => {
  const { io, saved } = recordingIo({
    fetchImage: async () => {
      throw new FetchError('HTTP 500');
    },
  });
  const job = await createEngine(io).runJob({
    jobId: 'j9',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, retryAttempts: 1 },
  });
  assert.equal(job.status, STATUS.FAILED);
  assert.equal(job.chapters[0].status, STATUS.FAILED);
  assert.equal(saved.length, 0);
});

test('a Referer failure is not retried', async () => {
  // It is deterministic; retrying only multiplies the 403s.
  let attempts = 0;
  const { io } = recordingIo({
    fetchImage: async (url) => {
      attempts++;
      throw new RefererRuleError(undefined, { url });
    },
  });
  await createEngine(io).runJob({
    jobId: 'j10',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: { ...baseSettings, retryAttempts: 5 },
  });
  assert.equal(attempts, 3, 'one attempt per image, no retries');
});

test('one failing chapter does not abort the others', async () => {
  const { io, saved } = recordingIo({
    fetchImage: async (url) => {
      if (url.startsWith('https://cdn.stub.test/c2')) throw new FetchError('boom');
      return { data: jpeg(), mimeType: 'image/jpeg' };
    },
  });
  const job = await createEngine(io).runJob({
    jobId: 'j11',
    adapterId: 'stub',
    ref: {},
    selection: 'all',
    settings: { ...baseSettings, retryAttempts: 1 },
  });
  assert.equal(job.status, STATUS.PARTIAL);
  assert.equal(saved.length, 2, 'chapters 1 and 3 still delivered');
  assert.equal(job.chapters.find((c) => c.number === 2).status, STATUS.FAILED);
});

/* ------------------------------ protected content -------------------------- */

test('a non-downloadable site is refused before any network call', async () => {
  let fetched = 0;
  const { io } = recordingIo({
    getAdapter: () => ({
      id: 'kakao',
      label: 'Kakao Page',
      capabilities: { download: false, search: false, originalQuality: false, languages: [] },
    }),
    fetchImage: async () => {
      fetched++;
      return { data: jpeg(), mimeType: 'image/jpeg' };
    },
  });

  const job = await createEngine(io).runJob({
    jobId: 'j12',
    adapterId: 'kakao',
    ref: {},
    selection: 'all',
    settings: baseSettings,
  });

  assert.equal(job.status, STATUS.FAILED);
  assert.match(job.error, /does not bypass DRM or paywalls/);
  assert.equal(fetched, 0, 'no request is made for protected content');
});

test('a per-chapter protected error is reported as skipped, not failed', async () => {
  const { io } = recordingIo({
    getAdapter: () => ({
      ...stubAdapter(),
      getChapterImages: async () => {
        throw new ProtectedContentError('DRM');
      },
    }),
  });
  const job = await createEngine(io).runJob({
    jobId: 'j13',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: baseSettings,
  });
  assert.equal(job.chapters[0].status, STATUS.SKIPPED_PROTECTED);
});

/* -------------------------------- cancellation ----------------------------- */

test('cancelling a running job stops it', async () => {
  const { io, saved } = recordingIo({
    fetchImage: async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { data: jpeg(), mimeType: 'image/jpeg' };
    },
  });
  const engine = createEngine(io);
  const promise = engine.runJob({
    jobId: 'j14',
    adapterId: 'stub',
    ref: {},
    selection: 'all',
    settings: { ...baseSettings, concurrentChapters: 1, concurrentImages: 1 },
  });

  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(engine.cancel('j14'), { cancelled: true });

  const job = await promise;
  assert.equal(job.status, STATUS.CANCELLED);
  assert.ok(saved.length < 3, 'did not finish every chapter');
});

test('cancelling an unknown job is reported, not thrown', async () => {
  assert.deepEqual(createEngine(recordingIo().io).cancel('nope'), { cancelled: false });
});

/* --------------------------------- progress -------------------------------- */

test('emits progress updates the panel can render', async () => {
  const updates = [];
  const { io } = recordingIo();
  await createEngine({ ...io, onJobUpdate: (job) => updates.push(job) }).runJob({
    jobId: 'j15',
    adapterId: 'stub',
    ref: {},
    selection: '1',
    settings: baseSettings,
  });

  assert.ok(updates.length > 3, 'progress is reported as it happens');
  const last = updates.at(-1);
  assert.equal(last.status, STATUS.DONE);
  assert.ok(last.finishedAt > 0);
  // Snapshots must be independent, or the panel would render mutating state.
  assert.notEqual(updates[0], updates.at(-1));
  assert.ok(updates.some((u) => u.chapters.some((c) => c.done > 0 && c.done < c.total)));
});

test('an unknown adapter fails the job cleanly', async () => {
  const { io } = recordingIo({ getAdapter: () => null });
  const job = await createEngine(io).runJob({
    jobId: 'j16',
    adapterId: 'nope',
    ref: {},
    selection: 'all',
    settings: baseSettings,
  });
  assert.equal(job.status, STATUS.FAILED);
  assert.match(job.error, /Unknown site adapter/);
});

test('an invalid chapter selection fails before fetching', async () => {
  let fetched = 0;
  const { io } = recordingIo({
    fetchImage: async () => {
      fetched++;
      return { data: jpeg(), mimeType: 'image/jpeg' };
    },
  });
  const job = await createEngine(io).runJob({
    jobId: 'j17',
    adapterId: 'stub',
    ref: {},
    selection: '99-200',
    settings: baseSettings,
  });
  assert.equal(job.status, STATUS.FAILED);
  assert.match(job.error, /did not match any chapter/);
  assert.equal(fetched, 0);
});

test('ZIP output uses ZIP bytes, a .zip suffix, and application/zip MIME', async () => {
  const blobs = [];
  const { io, saved } = recordingIo();
  const save = io.saveBlob;
  io.saveBlob = async (blob, name) => { blobs.push(blob); return save(blob, name); };
  const job = await createEngine(io).runJob({ jobId: 'zip-test', adapterId: 'stub', ref: {},
    selection: '1', settings: { ...baseSettings, format: 'zip' } });
  assert.equal(job.status, STATUS.DONE);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, 'application/zip');
  assert.match(saved[0].filename, /\.zip$/);
  const bytes = new Uint8Array(await blobs[0].arrayBuffer());
  assert.deepEqual([...bytes.slice(0,4)], [0x50,0x4b,3,4]);
  assert.ok(new TextDecoder().decode(bytes).includes('001.jpg'));
});
