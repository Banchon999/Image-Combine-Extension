import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, DEFAULT_SETTINGS } from '../../src/common/settings.js';

test('passes through valid settings', () => {
  const out = normalizeSettings({ ...DEFAULT_SETTINGS, format: 'pdf', concurrentImages: 6 });
  assert.equal(out.format, 'pdf');
  assert.equal(out.concurrentImages, 6);
});

test('clamps concurrency into a range that stays polite to the CDN', () => {
  assert.equal(normalizeSettings({ concurrentChapters: 999 }).concurrentChapters, 8);
  assert.equal(normalizeSettings({ concurrentChapters: 0 }).concurrentChapters, 1);
  assert.equal(normalizeSettings({ concurrentImages: -5 }).concurrentImages, 1);
  assert.equal(normalizeSettings({ concurrentImages: 1000 }).concurrentImages, 16);
});

test('falls back on non-numeric input rather than producing NaN', () => {
  // NaN concurrency would make the pool spin with zero workers.
  assert.equal(normalizeSettings({ concurrentImages: 'abc' }).concurrentImages, DEFAULT_SETTINGS.concurrentImages);
  assert.equal(normalizeSettings({ throttleMs: undefined }).throttleMs, DEFAULT_SETTINGS.throttleMs);
});

test('rejects unknown formats and languages', () => {
  assert.equal(normalizeSettings({ format: 'exe' }).format, DEFAULT_SETTINGS.format);
  assert.equal(normalizeSettings({ language: 'zz' }).language, 'en');
  assert.equal(normalizeSettings({ language: 'th' }).language, 'th');
});

test('coerces flags to booleans', () => {
  assert.equal(normalizeSettings({ originalQuality: 'yes' }).originalQuality, true);
  assert.equal(normalizeSettings({ writeRawThenClean: 0 }).writeRawThenClean, false);
});
