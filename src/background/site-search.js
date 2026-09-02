import { buildSiteSearchUrl, readSearchPage } from '../common/site-search.js';

export function sameSearchPage(actualUrl, expectedUrl, provider) {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    const category = provider === 'naver' ? 'searchType' : 'categoryUid';
    return actual.origin === expected.origin && actual.pathname === expected.pathname &&
      actual.searchParams.get('keyword') === expected.searchParams.get('keyword') &&
      actual.searchParams.get(category) === expected.searchParams.get(category);
  } catch { return false; }
}

/** One owned temporary tab per request; never reuse or scrape a user's tab. */
export async function searchInTab(provider, query, {
  api = chrome, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxAttempts = 30,
} = {}) {
  const url = buildSiteSearchUrl(provider, query);
  const tab = await api.tabs.create({ url, active: false });
  if (!Number.isInteger(tab.id)) throw new Error('Could not open the search tab.');
  let previous = null;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = await api.tabs.get(tab.id);
      if (current.status === 'complete') {
        if (!sameSearchPage(current.url, url, provider)) {
          throw new Error('Search left the results page. Open the site to check access, then retry.');
        }
        const [frame] = await api.scripting.executeScript({
          target: { tabId: tab.id }, func: readSearchPage, args: [provider],
        });
        const result = frame?.result;
        if (result?.ready) {
          const signature = JSON.stringify(result.items);
          if (signature === previous) return result.items;
          previous = signature;
        } else previous = null;
      }
      await pause(800);
    }
    throw new Error('Search results did not finish loading. Open the search page on the site and retry.');
  } finally {
    // Preserve the tab if the user navigated it elsewhere while we were waiting.
    try {
      const current = await api.tabs.get(tab.id);
      if (sameSearchPage(current.url, url, provider) || current.pendingUrl === url || current.url === 'about:blank') {
        await api.tabs.remove(tab.id);
      }
    } catch { /* Already closed by the user/browser. */ }
  }
}
