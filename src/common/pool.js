/**
 * Bounded-concurrency helpers.
 *
 * One implementation is used at both levels of the download pipeline
 * (chapters in flight, and images within a chapter) so there is only one
 * scheduler to reason about.
 */

import { CancelledError } from './errors.js';

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Results come back in input order regardless of completion order. Unlike
 * Promise.all, one rejection does not discard the successful results: every
 * task is settled and reported, because a chapter that lost one image is still
 * worth delivering as a partial.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{ status: 'fulfilled', value: R } | { status: 'rejected', reason: any }>>}
 */
export async function pool(items, limit, fn, { signal } = {}) {
  const results = new Array(items.length);
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (signal?.aborted) throw new CancelledError();
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

/** Resolve after `ms`, rejecting early if `signal` aborts. */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new CancelledError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry `fn` with exponential backoff and jitter.
 *
 * Jitter matters here: without it, a chapter's worth of images that all fail
 * at once would retry in lockstep and hammer the CDN in synchronised waves.
 *
 * @param {() => Promise<any>} fn
 * @param {{ attempts?: number, baseMs?: number, signal?: AbortSignal, shouldRetry?: (e: any) => boolean }} [options]
 */
export async function withRetry(fn, { attempts = 3, baseMs = 500, signal, shouldRetry = () => true } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new CancelledError();
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof CancelledError) throw error;
      if (attempt === attempts - 1 || !shouldRetry(error)) break;
      const backoff = baseMs * 2 ** attempt;
      const serverDelay = Number(error?.retryAfterMs) || 0;
      const wait = Math.max(backoff + Math.random() * backoff * 0.5, serverDelay);
      await delay(wait, signal);
    }
  }
  throw lastError;
}
