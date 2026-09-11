import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, resolveUiLanguage, applyUiLanguage } from '../../src/ui/i18n.js';

function fakeChrome(uiLanguage = 'en-US', messages = {}) {
  return {
    i18n: { getUILanguage: () => uiLanguage, getMessage: (key) => messages[key] ?? '' },
    runtime: { getURL: (path) => path },
  };
}

test('t() fills $1 placeholders and falls back when no source has the key', () => {
  globalThis.chrome = fakeChrome('en-US', {});
  assert.equal(t('missing', undefined, 'plain fallback'), 'plain fallback');
  assert.equal(t('missing', ['X'], 'value is $1'), 'value is X');
  assert.equal(t('missing', [1, 2], '#$1 of $2'), '#1 of 2');
});

test('t() prefers chrome.i18n when no interface override is active', () => {
  globalThis.chrome = fakeChrome('th-TH', { tabSearch: 'ค้นหา' });
  assert.equal(t('tabSearch', undefined, 'Search'), 'ค้นหา');
});

test('resolveUiLanguage maps auto/unknown onto a shipped locale', () => {
  globalThis.chrome = fakeChrome('th-TH');
  assert.equal(resolveUiLanguage('en'), 'en');
  assert.equal(resolveUiLanguage('th'), 'th');
  assert.equal(resolveUiLanguage('auto'), 'th', 'auto follows the browser language');
  assert.equal(resolveUiLanguage('es'), 'th', 'an unshipped choice falls back to the browser');
  globalThis.chrome = fakeChrome('fr-FR');
  assert.equal(resolveUiLanguage('auto'), 'en', 'an unshipped browser language falls back to English');
});

test('applyUiLanguage forces a locale, layering it over English', async () => {
  const files = {
    '_locales/en/messages.json': { tabSearch: { message: 'Search' }, downloadButton: { message: 'Download' } },
    '_locales/th/messages.json': { tabSearch: { message: 'ค้นหา' } },
  };
  globalThis.chrome = fakeChrome('en-US', { tabSearch: 'Search' });
  globalThis.fetch = async (url) => ({ ok: true, json: async () => files[url] ?? {} });
  const root = { documentElement: { setAttribute() {} }, querySelectorAll: () => [], title: 'x' };

  const lang = await applyUiLanguage('th', root);
  assert.equal(lang, 'th');
  assert.equal(t('tabSearch', undefined, 'Search'), 'ค้นหา', 'Thai message overrides the browser');
  assert.equal(t('downloadButton', undefined, 'Download'), 'Download', 'missing Thai key falls back to the English layer');

  // 'auto' on the browser's own language drops the override again.
  await applyUiLanguage('auto', root);
  globalThis.chrome = fakeChrome('en-US', { tabSearch: 'Search' });
  assert.equal(t('tabSearch', undefined, 'x'), 'Search');
});
