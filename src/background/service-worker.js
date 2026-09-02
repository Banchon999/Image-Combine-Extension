/**
 * Service worker: lifecycle, message routing, and the chrome.downloads calls
 * the offscreen document cannot make itself.
 *
 * It deliberately holds no long-running work. Chrome tears this context down
 * after a short idle period, so anything that outlives a single message round
 * trip lives in the offscreen document instead.
 */

import { MSG } from '../common/messages.js';
import { getSettings, updateSettings } from '../common/settings.js';
import { createLogger, recentLogs } from '../common/logger.js';
import { resolveUrl, ADAPTERS } from '../adapters/registry.js';
import { ensureRulesEnabled } from './net-rules.js';
import { startDownload, removeDownloadedFiles } from './download-manager.js';
import { searchInTab } from './site-search.js';
import { createFollowingStore } from './following-store.js';

const log = createLogger('worker');
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const following = createFollowingStore(chrome.storage.local);

/* ----------------------------- offscreen setup ---------------------------- */

// Guards against two concurrent messages both trying to create the document,
// which throws "Only a single offscreen document may be created".
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['DOM_PARSER', 'BLOBS'],
        justification:
          'Parses webtoon pages with DOMParser and assembles PDF/CBZ blobs; must outlive the service worker.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

/** Send a message to the offscreen document, starting it if necessary. */
async function toOffscreen(type, payload) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    const error = new Error(response?.error ?? 'Offscreen worker did not respond');
    error.protectedContent = Boolean(response?.protected);
    throw error;
  }
  return response.result;
}

/* -------------------------------- handlers -------------------------------- */

let jobCounter = 0;

const handlers = {
  [MSG.FOLLOW_LIST]: () => following.list(),
  [MSG.FOLLOW_ADD]: data => following.add(data),
  [MSG.FOLLOW_REMOVE]: ({id}) => following.remove(id),
  [MSG.FOLLOW_HANDLED]: ({id,ids}) => following.handled(id,ids),
  [MSG.FOLLOW_CHECK]: ({id}) => following.check(id, payload => toOffscreen(MSG.OFF_GET_SERIES,payload)),
  [MSG.FOLLOW_EXPORT]: () => following.export(),
  [MSG.FOLLOW_IMPORT]: ({backup}) => following.import(backup),
  async [MSG.GET_SETTINGS]() {
    return getSettings();
  },

  async [MSG.SET_SETTINGS](patch) {
    return updateSettings(patch);
  },

  async [MSG.GET_STATE]() {
    return {
      adapters: ADAPTERS.map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        capabilities: adapter.capabilities,
      })),
      logs: recentLogs().slice(-50),
    };
  },

  /** Identify a pasted URL without hitting the network. */
  async [MSG.RESOLVE_URL]({ url }) {
    const { adapter, ref } = resolveUrl(url);
    return {
      adapterId: adapter.id,
      label: adapter.label,
      capabilities: adapter.capabilities,
      ref,
    };
  },

  async [MSG.SEARCH]({ query, lang, adapterId = 'webtoons' }) {
    if (adapterId === 'naver' || adapterId === 'kakao') return searchInTab(adapterId, query);
    return toOffscreen(MSG.OFF_SEARCH, { query, lang, adapterId });
  },

  async [MSG.GET_SERIES]({ url, adapterId, ref }) {
    return toOffscreen(MSG.OFF_GET_SERIES, { url, adapterId, ref });
  },

  async [MSG.START_JOB]({ adapterId, ref, selection, settings }) {
    await ensureRulesEnabled();
    const jobId = `job-${Date.now()}-${++jobCounter}`;
    const merged = { ...(await getSettings()), ...(settings ?? {}) };

    // Fire and forget: the job outlives this worker, and the panel follows it
    // through JOB_UPDATED broadcasts rather than this response.
    toOffscreen('offscreen:run-job', { jobId, adapterId, ref, selection, settings: merged }).catch(
      (error) => log.error(`Job ${jobId} failed`, String(error?.message ?? error)),
    );
    return { jobId };
  },

  async [MSG.CANCEL_JOB]({ jobId }) {
    return toOffscreen(MSG.OFF_CANCEL, { jobId });
  },

  /* -- called by the offscreen document -- */

  async 'download-file'({ blobUrl, filename, conflictAction }) {
    const downloadId = await startDownload({ blobUrl, filename, conflictAction });
    return { downloadId };
  },

  async 'remove-files'({ downloadIds }) {
    await removeDownloadedFiles(downloadIds);
    return { removed: downloadIds.length };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  // Not ours: returning false lets the offscreen document or the panel handle it.
  if (!handler) return false;

  Promise.resolve(handler(message.payload ?? {}))
    .then((result) => sendResponse({ ok: true, result, downloadId: result?.downloadId }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: String(error?.message ?? error),
        protected: Boolean(error?.protectedContent),
      }),
    );
  return true;
});

/* ------------------------------- lifecycle -------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  await ensureRulesEnabled();
  log.info('Extension installed');
});

chrome.runtime.onStartup.addListener(() => {
  ensureRulesEnabled();
});

/* ----------------------------- opening the app ---------------------------- */

const APP_PATH = 'src/ui/app.html';
const APP_TAB_KEY = 'appTabId';

/**
 * Clicking the toolbar icon opens the app in a full tab.
 *
 * A tab rather than a popup because a popup closes the moment focus moves,
 * which is hostile during a long download; and a single click rather than a
 * popup-then-open because the extra step bought nothing.
 *
 * An already-open tab is focused rather than duplicated. The tab id is
 * remembered in session storage instead of found with chrome.tabs.query({url}),
 * which would require the broad "tabs" permission just to locate our own page.
 */
chrome.action.onClicked.addListener(async (tab) => {
  await ensureRulesEnabled();

  // Hand the page the URL the user was looking at, so a supported series is
  // picked up automatically. Readable without the "tabs" permission because the
  // sites we support are in host_permissions.
  if (tab?.url) {
    await chrome.storage.session.set({ pendingUrl: tab.url }).catch(() => {});
  }

  const appUrl = chrome.runtime.getURL(APP_PATH);
  const { [APP_TAB_KEY]: knownId } = await chrome.storage.session.get(APP_TAB_KEY);

  if (knownId !== undefined) {
    try {
      const existing = await chrome.tabs.get(knownId);
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      // Re-run the page's startup so the newly stashed URL is picked up.
      await chrome.tabs.reload(existing.id);
      return;
    } catch {
      // The tab was closed since we recorded it; fall through and open a new one.
    }
  }

  const created = await chrome.tabs.create({ url: appUrl });
  await chrome.storage.session.set({ [APP_TAB_KEY]: created.id });
});

// Forget the tab once it is gone, so the next click opens a fresh one.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { [APP_TAB_KEY]: knownId } = await chrome.storage.session.get(APP_TAB_KEY);
  if (knownId === tabId) await chrome.storage.session.remove(APP_TAB_KEY);
});
