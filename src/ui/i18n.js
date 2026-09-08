/** Small wrapper around Chrome i18n with a readable fallback for tests/dev. */
export function t(key, substitutions, fallback = key) {
  return chrome.i18n?.getMessage(key, substitutions) || fallback;
}

export function localizeDocument(root = document) {
  const language = chrome.i18n?.getUILanguage?.() || 'en';
  root.documentElement?.setAttribute('lang', language.split('-')[0]);
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n, undefined, node.textContent);
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder, undefined, node.getAttribute('placeholder') || ''));
  }
  root.title = t('appTitle', undefined, root.title);
}
