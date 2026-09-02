import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSegment,
  padChapter,
  imageExtension,
  buildPath,
  imagePath,
  archivePath,
  safeDownloadPath,
  sanitizeFilename,
} from '../../src/common/filenames.js';

test('Korean filenames respect UTF-8 byte limits and retain extensions', () => {
  const path = archivePath({seriesTitle:'가'.repeat(100),chapterNumber:1,chapterTitle:'나'.repeat(100),format:'cbz'});
  for (const part of path.split('/')) assert.ok(new TextEncoder().encode(part).length <= 180);
  assert.ok(path.endsWith('.cbz'));
});

test('Unicode truncation never leaves an unpaired surrogate', () => {
  for (const ext of ['cbz','zip','pdf','jpg']) {
    const name = sanitizeFilename('😀'.repeat(100)+'.'+ext);
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(name)), name);
    assert.ok(new TextEncoder().encode(name).length <= 180);
    assert.ok(name.endsWith('.'+ext));
  }
});

test('format marks and malformed surrogates are removed', () => {
  assert.equal(sanitizeSegment('a\u202eb\u200bc\ud800'), 'abc');
});

test('reserved device names with extensions are escaped', () => {
  assert.equal(sanitizeSegment('CON.txt'), '_CON.txt');
  assert.equal(safeDownloadPath('series/NUL.cbz'), 'series/_NUL.cbz');
});

test('download boundary sanitizes every folder, preserving the file extension', () => {
  const path = safeDownloadPath('books/가'.repeat(1) + '가'.repeat(100) + '/'+ '나'.repeat(100) + '.zip');
  assert.ok(path.endsWith('.zip'));
  assert.ok(path.split('/').every(p=>new TextEncoder().encode(p).length <= 180));
  assert.equal(safeDownloadPath('books\\series\\001.cbz'), 'books/series/001.cbz');
});

test('download boundary rejects absolute and traversal paths', () => {
  for (const path of ['', '/a.cbz','C:\\a.cbz','a/../b.cbz','a//b.cbz','a/./b.cbz']) {
    assert.throws(()=>safeDownloadPath(path), /Unsafe download path/);
  }
});

test('strips characters that are illegal in filenames', () => {
  assert.equal(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
});

test('control characters become spaces rather than vanishing', () => {
  // Deleting them outright would join the surrounding words.
  const input = `Tower${String.fromCharCode(9)}of${String.fromCharCode(0)}God`;
  assert.equal(sanitizeSegment(input), 'Tower of God');
});

test('trims trailing dots and spaces', () => {
  // Windows silently drops these, which would desync the name on disk from the
  // one reported in the UI.
  assert.equal(sanitizeSegment('Episode 12. '), 'Episode 12');
});

test('escapes Windows reserved device names', () => {
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('lpt3'), '_lpt3');
  assert.equal(sanitizeSegment('CONSOLE'), 'CONSOLE');
});

test('never returns an empty segment', () => {
  assert.equal(sanitizeSegment('///'), 'untitled');
  assert.equal(sanitizeSegment(''), 'untitled');
  assert.equal(sanitizeSegment(null), 'untitled');
  assert.equal(sanitizeSegment('...'), 'untitled');
});

test('caps very long segments', () => {
  assert.ok(sanitizeSegment('x'.repeat(500)).length <= 100);
});

test('preserves non-ASCII titles', () => {
  assert.equal(sanitizeSegment('เว็บตูน 최고'), 'เว็บตูน 최고');
});

test('padChapter aligns lexical and numeric order', () => {
  assert.equal(padChapter(7), '007');
  assert.equal(padChapter(123), '123');
  assert.equal(padChapter(1234), '1234');
  assert.equal(padChapter(4, 4), '0004');
  assert.ok(padChapter(9) < padChapter(10));
});

test('imageExtension prefers MIME, falls back to the URL', () => {
  assert.equal(imageExtension('https://x/a', 'image/png'), 'png');
  assert.equal(imageExtension('https://x/a.JPEG?type=q90'), 'jpg');
  assert.equal(imageExtension('https://x/a.webp'), 'webp');
  assert.equal(imageExtension('https://x/no-extension'), 'jpg');
  assert.equal(imageExtension('https://x/a.png', 'image/jpeg'), 'jpg');
});

test('buildPath cannot escape the downloads directory', () => {
  // '..' sanitises to a harmless name rather than traversing.
  assert.equal(buildPath(['..', 'x']), 'untitled/x');
  assert.ok(!buildPath(['/etc', 'passwd']).startsWith('/'));
});

test('buildPath drops empty segments', () => {
  assert.equal(buildPath(['a', '', null, 'b']), 'a/b');
});

test('imagePath and archivePath compose the expected layout', () => {
  assert.equal(
    imagePath({ seriesTitle: 'Tower of God', chapterNumber: 12, chapterTitle: 'Ep 12', index: 3, url: 'https://x/a.jpg' }),
    'Tower of God/012 - Ep 12/003.jpg',
  );
  assert.equal(
    imagePath({ seriesTitle: 'S', chapterNumber: 1, index: 1, url: 'https://x/a.jpg' }),
    'S/001/001.jpg',
  );
  assert.equal(
    archivePath({ seriesTitle: 'Tower of God', chapterNumber: 12, chapterTitle: 'Ep 12', format: 'cbz' }),
    'Tower of God/012 - Ep 12.cbz',
  );
});

test('long multilingual chapter titles preserve the archive extension', () => {
  for (const format of ['cbz', 'zip', 'pdf']) {
    for (const length of [90, 94, 95, 96, 99, 100, 101, 500]) {
      const filename = archivePath({ seriesTitle: 'เรื่อง', chapterNumber: 12,
        chapterTitle: 'ก'.repeat(length), format }).split('/').at(-1);
      assert.ok(filename.endsWith(`.${format}`), filename);
      assert.ok(filename.length <= 100);
      assert.ok(filename.startsWith('012 - '));
    }
  }
});
