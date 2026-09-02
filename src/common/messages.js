/**
 * Message names exchanged between the side panel, the service worker and the
 * offscreen document.
 *
 * Centralised as constants because a typo in a message name fails silently:
 * chrome.runtime.sendMessage resolves with undefined rather than throwing.
 */

export const MSG = /** @type {const} */ ({
  // panel -> worker
  SEARCH: 'search',
  RESOLVE_URL: 'resolve-url',
  GET_SERIES: 'get-series',
  START_JOB: 'start-job',
  CANCEL_JOB: 'cancel-job',
  GET_STATE: 'get-state',
  GET_SETTINGS: 'get-settings',
  SET_SETTINGS: 'set-settings',
  FOLLOW_LIST: 'following:list',
  FOLLOW_ADD: 'following:add',
  FOLLOW_REMOVE: 'following:remove',
  FOLLOW_CHECK: 'following:check',
  FOLLOW_HANDLED: 'following:handled',
  FOLLOW_EXPORT: 'following:export',
  FOLLOW_IMPORT: 'following:import',

  // worker -> offscreen
  OFF_SEARCH: 'offscreen:search',
  OFF_GET_SERIES: 'offscreen:get-series',
  OFF_GET_IMAGES: 'offscreen:get-chapter-images',
  OFF_FETCH_CHAPTER: 'offscreen:fetch-chapter',
  OFF_CHECK_REFERER: 'offscreen:check-referer',
  OFF_CANCEL: 'offscreen:cancel',

  // offscreen/worker -> panel (broadcast)
  PROGRESS: 'progress',
  JOB_UPDATED: 'job-updated',
  LOG: 'log',
});

/** Job and per-chapter lifecycle states, shared by the worker and the UI. */
export const STATUS = /** @type {const} */ ({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  PARTIAL: 'partial',
  FAILED: 'failed',
  SKIPPED_PROTECTED: 'skipped-protected',
  CANCELLED: 'cancelled',
});

/**
 * Send a message and resolve even if no receiver is listening.
 *
 * The side panel is frequently closed while a job runs; without this, every
 * progress broadcast would reject with "Receiving end does not exist" and
 * surface as an unhandled rejection in the worker.
 */
export async function broadcast(type, payload) {
  try {
    await chrome.runtime.sendMessage({ type, payload });
  } catch {
    // No listener; nothing to do.
  }
}
