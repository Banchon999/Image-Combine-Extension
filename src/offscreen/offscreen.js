/**
 * Binds the download engine to the browser.
 *
 * This document exists because an MV3 service worker is torn down after roughly
 * 30 seconds idle, which would abort a chapter download mid-flight. It persists
 * for the life of a job and owns everything long-running.
 *
 * All the logic lives in engine.js; this file supplies the four things that
 * engine cannot have as dependencies without becoming untestable: fetch, a
 * DOMParser, a canvas, and the message hop to the service worker for
 * chrome.downloads (an API offscreen documents cannot reach themselves).
 */

import { MSG, broadcast } from '../common/messages.js';
import { FetchError, ProtectedContentError, RefererRuleError } from '../common/errors.js';
import { createEngine } from './engine.js';
import { detectImageMime } from '../common/image-types.js';
import { stitchPages } from './convert/stitch.js';

const REQUEST_TIMEOUT_MS = 45_000;
const IMAGE_TIMEOUT_MS = 90_000;
let stitchTail = Promise.resolve();

/* ------------------------------- networking ------------------------------- */

async function request(url, { signal, accept, timeoutMs = REQUEST_TIMEOUT_MS, image = false } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    signal: combined,
    // Send the user's own cookies: this is what lets age-gated series load
    // without the extension ever handling credentials itself.
    credentials: 'include',
    headers: accept ? { Accept: accept } : undefined,
  });

  if (!response.ok) {
    // A 403 alone does not prove a Referer failure (signed URLs can expire).
    if (response.status === 403 && image) {
      const body = await response.clone().text().catch(() => '');
      if (/referr?al denied|invalid referer|referer denied/i.test(body)) {
        throw new RefererRuleError(undefined, { url });
      }
    }
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter
      ? /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Math.max(0, Date.parse(retryAfter) - Date.now())
      : undefined;
    throw new FetchError(`HTTP ${response.status} for ${url}`, {
      url,
      status: response.status,
      retryAfterMs,
    });
  }
  return response;
}

/* --------------------------- engine dependencies -------------------------- */

const io = {
  async *stitchPages(pages, settings, signal, progress) {
    const previous=stitchTail;
    let release;
    stitchTail=new Promise(resolve=>{release=resolve;});
    try {
      await previous;
      yield* stitchPages(pages,settings,signal,progress);
    } finally {release();}
  },
  async fetchDoc(url, signal) {
    const response = await request(url, { signal, accept: 'text/html' });
    return new DOMParser().parseFromString(await response.text(), 'text/html');
  },

  fetchRaw: (url, signal) => request(url, { signal }),

  async fetchJson(url, signal) {
    const response = await request(url, { signal, accept: 'application/json, text/plain, */*' });
    return response.json();
  },

  async fetchImage(url, signal, { requirePlainImage = false } = {}) {
    const response = await request(url, {
      signal,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      timeoutMs: IMAGE_TIMEOUT_MS,
      image: true,
    });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) throw new FetchError('Empty image response', { url });
    const data = new Uint8Array(buffer);
    const declaredType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim();
    const detectedType = detectImageMime(data);
    if (requirePlainImage && !detectedType) {
      throw new FetchError('Kakao returned data without a supported plain-image signature. It may be an error, an unsupported format or protected data; no decryption is attempted.', { url });
    }
    if (!declaredType.startsWith('image/') && !detectedType) {
      throw new FetchError(`Expected an image but received ${declaredType || 'unknown data'}`, { url });
    }
    return {
      data,
      // Some CDNs use application/octet-stream. Prefer a detected image type
      // so CBZ/raw output still gets the correct extension.
      mimeType: detectedType || declaredType,
    };
  },

  /**
   * Hand a finished file to the service worker, which owns chrome.downloads.
   *
   * The blob URL is revoked as soon as the download has started; leaving them
   * open would pin every image of every chapter in memory for the lifetime of
   * this document.
   */
  async saveBlob(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'download-file',
        payload: { blobUrl, filename, conflictAction: 'uniquify' },
      });
      if (!result?.ok) throw new Error(result?.error || `Could not save ${filename}`);
      return result.downloadId ?? result.result?.downloadId;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  },

  async removeFiles(downloadIds) {
    if (!downloadIds.length) return;
    await chrome.runtime.sendMessage({ type: 'remove-files', payload: { downloadIds } });
  },

  /**
   * Re-encode anything that is not already a JPEG.
   *
   * The PDF writer embeds JPEG data verbatim, which is what preserves original
   * quality; other formats have no lossless path into a PDF. WEBTOON serves
   * JPEG, so this is a fallback rather than the normal path.
   */
  async toJpeg(page) {
    if (page.data[0] === 0xff && page.data[1] === 0xd8) return page;

    const bitmap = await createImageBitmap(
      new Blob([page.data], { type: page.mimeType || 'image/png' }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    return { ...page, data: new Uint8Array(await blob.arrayBuffer()), mimeType: 'image/jpeg' };
  },

  onJobUpdate(job) {
    broadcast(MSG.JOB_UPDATED, job);
  },
};

const engine = createEngine(io);

/* -------------------------------- messaging ------------------------------- */

const handlers = {
  [MSG.OFF_SEARCH]: (payload) => engine.search(payload),
  [MSG.OFF_GET_SERIES]: (payload) => engine.getSeries(payload),
  'offscreen:run-job': (payload) => engine.runJob(payload),
  [MSG.OFF_CANCEL]: ({ jobId }) => engine.cancel(jobId),

  /**
   * Confirm the Referer rule is live before a job commits to hundreds of
   * requests, so a misconfiguration surfaces as one clear error rather than a
   * wall of identical 403s.
   */
  async [MSG.OFF_CHECK_REFERER]({ imageUrl }) {
    try {
      await request(imageUrl, { accept: 'image/*', timeoutMs: IMAGE_TIMEOUT_MS, image: true });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        refererRule: error instanceof RefererRuleError,
        error: String(error?.message ?? error),
      };
    }
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  // Not ours: returning false lets the worker or the panel handle it.
  if (!handler) return false;

  Promise.resolve(handler(message.payload ?? {}))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: String(error?.message ?? error),
        protected: error instanceof ProtectedContentError,
      }),
    );
  // Keep the message channel open for the async response above.
  return true;
});
