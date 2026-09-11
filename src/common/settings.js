/**
 * User settings, persisted in chrome.storage.local.
 *
 * Defaults are chosen to be polite to the source site: modest concurrency and
 * a small inter-request delay. Users can raise them, but the shipped values
 * should never look like an attack to a CDN.
 */

import {STITCH_DEFAULTS,stitchOptions} from './stitch-plan.js';

export const OUTPUT_FORMATS = /** @type {const} */ (['pdf', 'cbz', 'zip', 'raw']);
/** Shipped interface locales; 'auto' follows the browser UI language. */
export const UI_LANGUAGES = /** @type {const} */ ([
  { code: 'auto', label: 'Auto (browser)' },
  { code: 'en', label: 'English' },
  { code: 'th', label: 'ไทย (Thai)' },
]);
export const LANGUAGES = /** @type {const} */ ([
  { code: 'en', label: 'English' },
  { code: 'zh-hant', label: 'Chinese (Traditional)' },
  { code: 'th', label: 'Thai' },
  { code: 'id', label: 'Indonesian' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
]);

export const DEFAULT_SETTINGS = Object.freeze({
  ...STITCH_DEFAULTS,
  /** pdf | cbz | raw */
  format: 'cbz',
  /** Skip the CDN's q90 recompression and take the source image. */
  originalQuality: true,
  /** Chapters fetched at the same time. */
  concurrentChapters: 1,
  /** Images fetched at the same time within one chapter. */
  concurrentImages: 4,
  /** Retry attempts per image before the chapter is marked partial. */
  retryAttempts: 5,
  /** Milliseconds between starting successive image requests. */
  throttleMs: 150,
  /**
   * For pdf/cbz: also write the raw images to disk, then delete them once the
   * archive is built. Off by default, in which case images are held in memory
   * and never touched disk at all.
   */
  writeRawThenClean: false,
  /** Opt-in per job: request already accessible Kakao chapters using browser cookies. */
  kakaoAccountAccess: false,
  /**
   * For cbz/zip: pack every selected chapter into one archive per series
   * (named by the chapter range) instead of one file per chapter. Ignored for
   * pdf/raw and when stitching is on.
   */
  bundleSeries: false,
  /** Root folder inside the browser's Downloads directory. */
  downloadFolder: 'Webtoons',
  /** Search/content language (WEBTOON editions, Korean for NAVER/Kakao). */
  language: 'en',
  /** Interface language: 'auto' follows the browser, or a shipped locale code. */
  uiLanguage: 'auto',
  /** Zero-padding width for chapter numbers in filenames. */
  padWidth: 3,
});

const KEY = 'settings';

/** Read settings, merged over defaults so a new key never reads as undefined. */
export async function getSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] ?? {}) };
}

/** Persist a partial update and return the full merged result. */
export async function updateSettings(patch) {
  const merged = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: merged });
  return merged;
}

/** Clamp/validate anything the UI could send before it reaches the network layer. */
export function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  };
  s.concurrentChapters = clamp(s.concurrentChapters, 1, 8, DEFAULT_SETTINGS.concurrentChapters);
  s.concurrentImages = clamp(s.concurrentImages, 1, 16, DEFAULT_SETTINGS.concurrentImages);
  s.retryAttempts = clamp(s.retryAttempts, 1, 10, DEFAULT_SETTINGS.retryAttempts);
  s.throttleMs = clamp(s.throttleMs, 0, 5000, DEFAULT_SETTINGS.throttleMs);
  s.padWidth = clamp(s.padWidth, 1, 6, DEFAULT_SETTINGS.padWidth);
  if (!OUTPUT_FORMATS.includes(s.format)) s.format = DEFAULT_SETTINGS.format;
  if (!LANGUAGES.some((l) => l.code === s.language)) s.language = DEFAULT_SETTINGS.language;
  if (!UI_LANGUAGES.some((l) => l.code === s.uiLanguage)) s.uiLanguage = DEFAULT_SETTINGS.uiLanguage;
  s.originalQuality = Boolean(s.originalQuality);
  s.writeRawThenClean = Boolean(s.writeRawThenClean);
  s.bundleSeries = s.bundleSeries === true;
  // Never opt in on truthy strings such as "false" or old stored values.
  s.kakaoAccountAccess = s.kakaoAccountAccess === true;
  s.stitchEnabled = s.stitchEnabled === true;
  if (s.stitchEnabled) {
    stitchOptions(s); // Reject impossible user values; do not silently change them.
    s.concurrentChapters = 1;
  }
  return s;
}
