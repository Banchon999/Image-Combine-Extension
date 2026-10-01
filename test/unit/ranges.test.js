import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, describeSelection, toRangeSpec } from '../../src/common/ranges.js';

// A series with a deliberate gap (no chapter 4) and non-contiguous numbering,
// which is what makes selecting against the real list matter.
const AVAILABLE = [1, 2, 3, 5, 6, 7, 8, 9, 10, 12];

test('all / empty select everything', () => {
  assert.deepEqual(parseRange('all', AVAILABLE), AVAILABLE);
  assert.deepEqual(parseRange('', AVAILABLE), AVAILABLE);
  assert.deepEqual(parseRange('   ', AVAILABLE), AVAILABLE);
});

test('latest selects the highest chapter, not the last listed', () => {
  assert.deepEqual(parseRange('latest', AVAILABLE), [12]);
  // Unsorted input must not change the answer.
  assert.deepEqual(parseRange('latest', [5, 1, 12, 3]), [12]);
});

test('latest:N selects the newest N', () => {
  assert.deepEqual(parseRange('latest:3', AVAILABLE), [9, 10, 12]);
  // Asking for more than exist yields everything rather than erroring.
  assert.deepEqual(parseRange('latest:99', AVAILABLE), AVAILABLE);
});

test('single chapter', () => {
  assert.deepEqual(parseRange('6', AVAILABLE), [6]);
});

test('closed range skips chapters that do not exist', () => {
  // 4 is absent from the series and must not appear.
  assert.deepEqual(parseRange('3-6', AVAILABLE), [3, 5, 6]);
});

test('open-ended ranges', () => {
  assert.deepEqual(parseRange('9-', AVAILABLE), [9, 10, 12]);
  assert.deepEqual(parseRange('-3', AVAILABLE), [1, 2, 3]);
});

test('unions are merged, de-duplicated and sorted', () => {
  assert.deepEqual(parseRange('12,1,5-7,6', AVAILABLE), [1, 5, 6, 7, 12]);
});

test('whitespace is tolerated', () => {
  assert.deepEqual(parseRange(' 1 , 5 - 7 ', AVAILABLE), [1, 5, 6, 7]);
});

test('rejects unparseable input', () => {
  assert.throws(() => parseRange('abc', AVAILABLE), /Could not understand/);
  assert.throws(() => parseRange('5-2', AVAILABLE), /starts after it ends/);
});

test('rejects a selection that matches nothing', () => {
  assert.throws(() => parseRange('4', AVAILABLE), /did not match any chapter/);
  assert.throws(() => parseRange('100-200', AVAILABLE), /did not match any chapter/);
});

test('rejects an empty series', () => {
  assert.throws(() => parseRange('all', []), /no chapters/);
});

test('describeSelection summarises for the UI', () => {
  assert.equal(describeSelection([]), 'nothing');
  assert.equal(describeSelection([7]), 'chapter 7');
  assert.equal(describeSelection([1, 2, 5]), '3 chapters (1-5)');
});

test('toRangeSpec compresses runs back into the spec syntax', () => {
  assert.equal(toRangeSpec([1, 2, 3]), '1-3');
  assert.equal(toRangeSpec([1, 3, 5]), '1,3,5');
  assert.equal(toRangeSpec([7]), '7');
  assert.equal(toRangeSpec([]), '');
  assert.equal(toRangeSpec([1, 2, 3, 7, 9, 10, 11]), '1-3,7,9-11');
  // Unsorted input with duplicates must still produce a clean spec.
  assert.equal(toRangeSpec([5, 4, 4, 6]), '4-6');
  // A run of exactly two is written as a pair, since "4-5" and "4,5" are the
  // same length but the pair reads better.
  assert.equal(toRangeSpec([4, 5]), '4,5');
});

test('toRangeSpec output round-trips through parseRange', () => {
  // The spec it produces is fed straight back into the selection box, so the
  // two functions must agree.
  const available = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (const picked of [[1, 2, 3], [1, 3, 5], [7], [1, 2, 3, 7, 9, 10, 11], [12]]) {
    assert.deepEqual(parseRange(toRangeSpec(picked), available), picked);
  }
});

// Asura numbers side chapters with decimals (152.1 ... 152.6) and has chapter 0.
const WITH_SIDE = [0, 1, 2, 2.5, 3, 4, 152, 152.1, 152.2, 153];

test('decimal side chapters can be selected singly and as range ends', () => {
  assert.deepEqual(parseRange('152.1', WITH_SIDE), [152.1]);
  assert.deepEqual(parseRange('2-3', WITH_SIDE), [2, 2.5, 3]);
  assert.deepEqual(parseRange('152-152.1', WITH_SIDE), [152, 152.1]);
  assert.deepEqual(parseRange('152.1-', WITH_SIDE), [152.1, 152.2, 153]);
  assert.deepEqual(parseRange('0', WITH_SIDE), [0]);
  assert.throws(() => parseRange('2.', WITH_SIDE));
  assert.throws(() => parseRange('.5', WITH_SIDE));
});

test('toRangeSpec never spans a chapter that lies between two selected ones', () => {
  // Free 1, 2, 3 with a locked 2.5 between: "1-3" would select 2.5 too.
  assert.equal(toRangeSpec([1, 2, 3], WITH_SIDE), '1,2,3');
  assert.equal(toRangeSpec([0, 1, 2, 2.5, 3, 4], WITH_SIDE), '0-4');
  assert.equal(toRangeSpec(WITH_SIDE, WITH_SIDE), '0-153');
  // Without the series list, behaviour is unchanged.
  assert.equal(toRangeSpec([1, 2, 3]), '1-3');
  assert.equal(toRangeSpec([152, 152.1]), '152,152.1');
});

test('toRangeSpec output parses back to exactly the same selection', () => {
  for (const chosen of [[1, 2, 3], [0, 1, 2, 2.5, 3, 4], [152.1, 152.2], [1, 2, 3, 4, 152, 152.1], [2.5]]) {
    assert.deepEqual(parseRange(toRangeSpec(chosen, WITH_SIDE), WITH_SIDE), chosen);
  }
});
