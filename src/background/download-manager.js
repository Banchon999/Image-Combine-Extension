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
// How long a requested name is kept for the naming step below. Chrome asks
// within moments of the download starting; this only bounds the memory.
const NAME_TTL_MS = 60_000;

/**
 * The name each of our downloads should get, keyed by its blob URL.
 *
 * Once ANY installed extension listens to chrome.downloads.onDeterminingFilename
 * (download managers and organisers commonly do), Chrome drops the `filename`
 * passed to chrome.downloads.download and names a blob download after its
 * URL's UUID, with no extension, in the top of Downloads ("0cc281d0-3d10-...").
 * Answering that same event with the name we asked for restores it.
 */
const requestedNames = new Map();

function rememberName(blobUrl, filename, conflictAction) {
  requestedNames.set(blobUrl, { filename, conflictAction });
  const timer = setTimeout(() => {
    if (requestedNames.get(blobUrl)?.filename === filename) requestedNames.delete(blobUrl);
  }, NAME_TTL_MS);
  timer?.unref?.(); // Node (tests) only: a pending cleanup must not hold the process open.
}

/**
 * Register the naming listener. Call once, synchronously, at the top level of
 * the service worker, so it is in place before any download starts.
 *
 * Every other download in the browser gets an empty suggestion, which leaves
 * its name exactly as Chrome or other extensions decide.
 */
export function installFilenameGuard() {
  const event = chrome.downloads?.onDeterminingFilename;
  if (!event) return;
  event.addListener((item, suggest) => {
    const wanted = item.byExtensionId === chrome.runtime.id
      ? requestedNames.get(item.url) ?? requestedNames.get(item.finalUrl)
      : undefined;
    if (!wanted) {
      suggest();
      return;
    }
    requestedNames.delete(item.url);
    suggest({ filename: wanted.filename, conflictAction: wanted.conflictAction });
  });
}

const baseName = (path) => String(path ?? '').split(/[\\/]/).pop();

/**
 * Whether Chrome kept the name we asked for. Its own " (1)" suffix for a
 * duplicate name ("uniquify") still counts as the same name.
 */
export function sameDownloadName(requestedPath, finalPath) {
  const strip = (name) => name.replace(/ \(\d+\)(?=\.[^.]+$|$)/, '');
  return strip(baseName(requestedPath)) === strip(baseName(finalPath));
}

/**
 * Report once if the file lands under a different name. That still happens
 * when another extension that names downloads was installed after this one:
 * Chrome lets the most recently installed one decide, and nothing here can
 * override it, so the user is at least told what the file is and why.
 */
function watchFinalName(id, requestedPath, onRenamed) {
  let done = false;
  const check = (finalPath) => {
    if (done || !finalPath) return;
    done = true;
    chrome.downloads.onChanged.removeListener(onChanged);
    clearTimeout(timer);
    if (!sameDownloadName(requestedPath, finalPath)) {
      onRenamed({ downloadId: id, requested: baseName(requestedPath), actual: baseName(finalPath) });
    }
  };
  function onChanged(delta) {
    if (delta.id === id && delta.filename?.current) check(delta.filename.current);
  }
  const timer = setTimeout(() => { done = true; chrome.downloads.onChanged.removeListener(onChanged); }, COMPLETION_TIMEOUT_MS);
  timer?.unref?.();
  chrome.downloads.onChanged.addListener(onChanged);
  chrome.downloads.search({ id }, (items) => check(items?.[0]?.filename));
}

/**
 * Start a download and resolve with its id.
 *
 * `filename` is a path relative to the browser's Downloads directory; the
 * segments were already sanitised in common/filenames.js, because a rejection
 * here happens after all the network work is done.
 */
export async function startDownload({ blobUrl, filename, conflictAction = 'uniquify', onRenamed }) {
  const safeName = safeDownloadPath(filename);
  const attempt = (name) => new Promise((resolve, reject) => {
    rememberName(blobUrl, name, conflictAction);
    chrome.downloads.download({ url: blobUrl, filename: name, conflictAction, saveAs: false }, (id) => {
      const error = chrome.runtime.lastError;
      if (error || id === undefined) {
        reject(new Error(error?.message ?? `Download refused for ${filename}`));
        return;
      }
      if (onRenamed) watchFinalName(id, name, onRenamed);
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
