import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withRetry } from '../../src/common/pool.js';
import { CancelledError } from '../../src/common/errors.js';

test('results keep input order regardless of completion order', async () => {
  const out = await pool([30, 10, 20], 3, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(out.map((r) => r.value), [30, 10, 20]);
});

test('one failure does not discard the successes', async () => {
  // A chapter that lost a single image is still worth delivering.
  const out = await pool([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });
  assert.deepEqual(out.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(out[1].reason.message, 'boom');
});

test('never exceeds the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  await pool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  });
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test('handles an empty list', async () => {
  assert.deepEqual(await pool([], 4, async () => 1), []);
});

test('aborting stops the pool', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    () => pool(Array.from({ length: 50 }, (_, i) => i), 2, async () => {
      await new Promise((r) => setTimeout(r, 20));
    }, { signal: controller.signal }),
    CancelledError,
  );
});

test('withRetry eventually succeeds', async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    if (++calls < 3) throw new Error('flaky');
    return 'ok';
  }, { attempts: 3, baseMs: 1 });
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
});

test('withRetry respects shouldRetry for deterministic failures', async () => {
  // A Referer 403 cannot be fixed by retrying; retrying only multiplies it.
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls++;
    throw new Error('403');
  }, { attempts: 5, baseMs: 1, shouldRetry: () => false }));
  assert.equal(calls, 1);
});
