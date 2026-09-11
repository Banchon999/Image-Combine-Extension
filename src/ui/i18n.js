/**
 * Interface localization.
 *
 * Two sources feed the same `t()` lookup:
 *   - By default the browser's own chrome.i18n, keyed off the UI language and
 *     the bundled _locales, so nothing extra loads when "Auto" is chosen.
 *   - When the user forces a specific interface language, that locale's
 *     messages are fetched once and override chrome.i18n, so the whole UI can
 *     switch without reloading the extension.
 *
 * `t(key, substitutions, fallback)` and `localizeDocument(root)` keep their
 * original signatures; only the override layer is new.
 */

/** Interface locales shipped in _locales/. 'auto' follows the browser. */
export const UI_LOCALES = ['en', 'th'];

// Active override, set by applyUiLanguage(); null means "use chrome.i18n".
let overrideMessages = null;
let overrideLang = null;

/** Minimal $1/$2 placeholder substitution, matching chrome.i18n semantics. */
function fill(text, substitutions) {
  if (substitutions === undefined || substitutions === null) return text;
  const list = Array.isArray(substitutions) ? substitutions : [substitutions];
  return String(text).replace(/\$(\d+)/g, (_, n) => String(list[Number(n) - 1] ?? ''));
}

export function t(key, substitutions, fallback = key) {
  if (overrideMessages) {
    const message = overrideMessages[key];
    if (message != null && message !== '') return fill(message, substitutions);
  }
  const native = chrome.i18n?.getMessage?.(key, substitutions);
  if (native) return native;
  return fill(fallback, substitutions);
}

export function localizeDocument(root = document) {
  const language = overrideLang || chrome.i18n?.getUILanguage?.() || 'en';
  root.documentElement?.setAttribute('lang', language.split('-')[0]);
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n, undefined, node.textContent);
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder, undefined, node.getAttribute('placeholder') || ''));
  }
  root.title = t('appTitle', undefined, root.title);
}

/** Resolve a stored uiLanguage setting ('auto'|locale) to a shipped locale. */
export function resolveUiLanguage(setting) {
  if (UI_LOCALES.includes(setting)) return setting;
  const base = String(chrome.i18n?.getUILanguage?.() || 'en').split('-')[0];
  return UI_LOCALES.includes(base) ? base : 'en';
}

/** Load a locale's messages, layered over English so a missing key falls back. */
async function loadLocaleMessages(lang) {
  const read = async (code) => {
    try {
      const response = await fetch(chrome.runtime.getURL(`_locales/${code}/messages.json`));
      if (!response.ok) return {};
      const json = await response.json();
      return Object.fromEntries(Object.entries(json).map(([key, value]) => [key, value?.message ?? '']));
    } catch {
      return {};
    }
  };
  const english = await read('en');
  const chosen = lang === 'en' ? {} : await read(lang);
  return { ...english, ...chosen };
}

/**
 * Force the interface language (or follow the browser for 'auto'/unknown),
 * then re-localize the static document. Returns the resolved locale code.
 */
export async function applyUiLanguage(setting, root = document) {
  const lang = resolveUiLanguage(setting);
  // 'auto' on a locale the browser already uses needs no override; letting
  // chrome.i18n answer keeps native placeholder handling intact.
  if (setting === 'auto' && lang === String(chrome.i18n?.getUILanguage?.() || '').split('-')[0]) {
    overrideMessages = null;
    overrideLang = null;
  } else {
    overrideMessages = await loadLocaleMessages(lang);
    overrideLang = lang;
  }
  localizeDocument(root);
  return lang;
}
