/**
 * chrome.downloads wrapper.
 *
 * Only the service worker can reach this API, so the offscreen document asks
 * the worker to perform saves on its behalf.
 */

import { createLogger } from '../common/logger.js';
import { safeDownloadPath } from '../common/filenames.js';

const log = createLogger('downloads');
const COMPLETION_TIMEOUT_MS = 120_000;

/**
 * Start a download and resolve with its id.
 *
 * `filename` is a path relative to the browser's Downloads directory; the
 * segments were already sanitised in common/filenames.js, because a rejection
 * here happens after all the network work is done.
 */
export async function startDownload({ blobUrl, filename, conflictAction = 'uniquify' }) {
  const safeName = safeDownloadPath(filename);
  const attempt = (name) => new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename: name, conflictAction, saveAs: false }, (id) => {
      const error = chrome.runtime.lastError;
      if (error || id === undefined) {
        reject(new Error(error?.message ?? `Download refused for ${filename}`));
        return;
      }
      resolve(id);
    });
  });
  try {
    return await attempt(safeName);
  } catch (error) {
    // Retry only a rejected NAME, never a permission/network/disk failure.
    // Some Android download implementations reject subfolders or Unicode.
    if (!/invalid[ _-]*file[ _-]*name/i.test(error?.message ?? '')) throw error;
    const suffix = safeName.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? '';
    const fallback = `webtoon-${crypto.randomUUID()}${suffix}`;
    log.warn('Browser rejected the filename; using a short ASCII filename in Downloads.', { original: safeName, fallback });
    try {
      return await attempt(fallback);
    } catch (fallbackError) {
      throw new Error(`Could not save ${fallback}: ${fallbackError?.message ?? fallbackError}`);
    }
  }
}

/**
 * Resolve once a download reaches a terminal state.
 *
 * Needed before deleting a staged raw image: chrome.downloads.removeFile on an
 * in-flight download either fails or races the writer.
 */
export function waitForCompletion(downloadId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(state);
    };

    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        finish(delta.state.current);
      }
    }

    const timer = setTimeout(() => finish('timeout'), COMPLETION_TIMEOUT_MS);
    chrome.downloads.onChanged.addListener(onChanged);

    // The download may already have finished before the listener was attached.
    chrome.downloads.search({ id: downloadId }, (items) => {
      const state = items?.[0]?.state;
      if (state === 'complete' || state === 'interrupted') finish(state);
    });
  });
}

/**
 * Delete files this extension downloaded.
 *
 * This is how "clean up raw images after converting" is implemented. An
 * extension cannot delete arbitrary folders, but it can delete files it created
 * itself, which is exactly the set we want to remove.
 */
export async function removeDownloadedFiles(downloadIds) {
  for (const id of downloadIds) {
    try {
      await waitForCompletion(id);
      await chrome.downloads.removeFile(id);
      // Also drop the entry from the download history, so cleaning up does not
      // leave the user a list of broken "file moved or missing" rows.
      await chrome.downloads.erase({ id });
    } catch (error) {
      // A file the user already moved or deleted is not worth failing the job.
      log.warn(`Could not remove staged file ${id}`, String(error));
    }
  }
}
